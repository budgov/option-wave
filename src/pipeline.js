import crypto from "node:crypto";
import {
  appendAnalysis,
  appendInterpretationEvent,
  appendMarketSnapshot,
  appendRawMessage,
  getLatestMarketSnapshot,
  getLatestStageOutput,
  getRawMessage,
  getSignalHint,
  isLatestRawMessageVersion
} from "./db.js";
import { captureMarketSnapshot, isScorableOptionSnapshot } from "./market-data.js";
import { ingestMessageMedia } from "./media.js";
import { runOpenClawAgent } from "./openclaw.js";
import { lunaPrompt, terraPrompt } from "./prompts.js";
import { applySourceSemantics, applyTerraSourceSemantics, channelSemantics, sourceExitFraction } from "./source-semantics.js";
import { lunaWithSignalContract, resolveSignalContext, reviewSellToClose } from "./lifecycle.js";
import { isResearchOnlyOptionCommentary } from "./signal-detector.js";

const MARKET_RELEVANT_CLASSIFICATIONS = new Set(["options_signal", "update", "cancel", "outcome"]);
const SECONDARY_ROUTER_MODEL = "local/secondary-router-v1";

function sha256(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function messageClockDeltaMilliseconds(record) {
  const received = Date.parse(record?.receivedAt ?? record?.received_at ?? "");
  const event = Date.parse(effectiveMessageTime(record) ?? "");
  return Number.isFinite(received) && Number.isFinite(event) ? received - event : null;
}

export function terraInputManifest(row, luna, marketSnapshotRecord, rawPrompt = null) {
  const snapshot = marketSnapshotRecord?.snapshot ?? {};
  const serializedSnapshot = marketSnapshotRecord?.snapshot_json ?? JSON.stringify(snapshot);
  const eventAt = effectiveMessageTime(row);
  return {
    schema_version: "terra-input-manifest.v1",
    raw_message_id: Number(row.id),
    telegram_message: {
      channel_key: row.channel_key,
      message_id: row.telegram_message_id,
      version: Number(row.version ?? 1),
      event_at: eventAt,
      received_at: row.received_at ?? null,
      clock_delta_ms: messageClockDeltaMilliseconds(row)
    },
    luna_result: {
      schema_version: luna?.schema_version ?? null,
      classification: luna?.classification ?? null,
      lifecycle_action: luna?.lifecycle_action ?? null,
      contract: luna?.contract ?? null,
      sha256: sha256(luna)
    },
    market_snapshot: {
      id: marketSnapshotRecord?.id == null ? null : Number(marketSnapshotRecord.id),
      provider: snapshot.provider ?? null,
      data_tier: snapshot.data_tier ?? null,
      observed_at: snapshot.observed_at ?? snapshot.as_of ?? null,
      sha256: sha256(serializedSnapshot)
    },
    raw_prompt_sha256: sha256(rawPrompt ?? row),
    prompt_schema_version: "terra-prompt.v1"
  };
}

export function effectiveMessageTime(record) {
  return record?.eventAt ?? record?.event_at ?? record?.editedAt ?? record?.edited_at
    ?? record?.publishedAt ?? record?.published_at;
}

function requireSchema(output, expected) {
  if (!output || output.schema_version !== expected) {
    throw new Error(`Expected ${expected} output.`);
  }
}

export function analysisSessionKey(stage, row, attempt) {
  if (!new Set(["luna", "terra"]).has(stage)) throw new Error(`Unsupported analysis stage: ${stage}`);
  const safeChannel = String(row.channel_key ?? "channel").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const rawMessageId = Number(row.id);
  const version = Number(row.version ?? 1);
  const attemptNumber = Number(attempt);
  if (!Number.isSafeInteger(rawMessageId) || rawMessageId <= 0) throw new Error("Invalid raw message id for analysis session.");
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error("Invalid message version for analysis session.");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) throw new Error("Invalid analysis attempt number.");
  return `${stage}-${safeChannel}-raw${rawMessageId}-v${version}-a${attemptNumber}`;
}

function nextAnalysisSessionKey(db, stage, row) {
  const prior = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM analysis_runs WHERE raw_message_id=? AND stage=?"
  ).get(Number(row.id), stage).count);
  return analysisSessionKey(stage, row, prior + 1);
}

export function rawRowForPrompt(config, row, mediaEvidence = [], signalHint = null, mediaError = null) {
  return {
    database_id: row.id,
    channel_key: row.channel_key,
    chat_id: row.telegram_chat_id,
    message_id: row.telegram_message_id,
    version: row.version,
    published_at: row.published_at,
    event_at: effectiveMessageTime(row),
    received_at: row.received_at,
    edited_at: row.edited_at,
    reply_to_message_id: row.reply_to_message_id,
    raw_text: row.raw_text,
    source_semantics: channelSemantics(config, row.channel_key),
    deterministic_signal_hint: signalHint,
    media_ingest_error: mediaError,
    media_evidence: mediaEvidence.map((media) => ({
      asset_id: media.asset_id,
      media_index: media.media_index,
      mime_type: media.mime_type,
      sha256: media.sha256,
      analysis_status: media.analysis_status,
      analysis: media.analysis,
      analysis_error: media.analysis_error
    }))
  };
}

export function canArchiveAsSecondaryContext(record, signalHint) {
  const hasMedia = Boolean(record?.raw?.has_media || record?.raw?.media_id || record?.raw?.grouped_id);
  const replyToMessageId = record?.replyToMessageId ?? record?.reply_to_message_id ?? null;
  return signalHint?.classification === "non_signal"
    && signalHint?.explicit !== true
    && signalHint?.needs_human_interpretation !== true
    && !hasMedia
    && replyToMessageId == null;
}

export function archiveSecondaryContext(db, record, rawMessageId, signalHint) {
  const existing = getLatestStageOutput(db, rawMessageId, "luna");
  if (existing) return { inserted: false, output: existing };
  const output = {
    schema_version: "luna.v1",
    classification: "non_signal",
    signal_id: null,
    source: {
      channel_key: record.channelKey ?? record.channel_key,
      chat_id: String(record.chatId ?? record.telegram_chat_id ?? ""),
      message_id: String(record.messageId ?? record.telegram_message_id ?? ""),
      published_at: record.publishedAt ?? record.published_at,
      edited_at: record.editedAt ?? record.edited_at ?? null,
      reply_to_message_id: null
    },
    evidence: { raw_text: String(record.rawText ?? record.raw_text ?? ""), spans: [] },
    contract: {
      symbol: null, expiry: null, strike: null, option_type: null, side: null,
      open_action: null, entry_price: { value: null, kind: null, raw: null },
      size: { value: null, unit: null, raw: null },
      stop_loss: { value: null, unit: null, type: null, raw: null }
    },
    confidence: { overall: 1, by_field: { classification: 1 } },
    lifecycle_action: null,
    lifecycle: { kind: null, average_cost: null, reference_exit_price: null, execution_state: null },
    market_forecast: {
      eligible: false, symbols: [], direction: null, horizon_minutes: null,
      maturity_policy: null, target_price: null, confidence: 1, evidence: null
    },
    missing_fields: [],
    ambiguities: [],
    follow_up: { relation: null, parent_message_id: null, confidence: 0 },
    data_role: "secondary_market_context",
    routing: {
      schema_version: "secondary-router.v1",
      policy: "strict_negative_option_filter",
      detector_version: signalHint?.schema_version ?? null,
      excluded_from_option_calculation: true,
      excluded_from_ai_queue: true
    }
  };
  appendAnalysis(db, {
    rawMessageId,
    stage: "luna",
    schemaVersion: "luna.v1",
    model: SECONDARY_ROUTER_MODEL,
    status: "ok",
    input: {
      schema_version: "secondary-router-input.v1",
      raw_message_id: rawMessageId,
      detector_version: signalHint?.schema_version ?? null,
      reason: "no option contract/action, reply, media, or unresolved market language"
    },
    output
  });
  return { inserted: true, output };
}

export function humanInterpretationRequest(config, luna, signalHint) {
  const threshold = Number(config.listener?.humanInterpretationConfidenceThreshold ?? 0.75);
  const confidence = Number(luna?.confidence?.overall);
  const action = luna?.lifecycle_action ?? luna?.contract?.open_action ?? signalHint?.action ?? null;
  const fastUnresolved = signalHint?.needs_human_interpretation === true
    && luna?.classification === "non_signal";
  const lowConfidence = MARKET_RELEVANT_CLASSIFICATIONS.has(luna?.classification)
    && Number.isFinite(confidence) && confidence < threshold;
  const languageAmbiguity = (luna?.ambiguities ?? []).some((item) =>
    /(?:meaning|intent|action)\s+(?:is\s+)?(?:unclear|ambiguous|unknown)|无法判断|无法确定.*(?:意思|意图|操作)|含义不明|动作不明/i.test(String(item))
  );
  const missingAction = MARKET_RELEVANT_CLASSIFICATIONS.has(luna?.classification)
    && !action && luna?.classification !== "cancel";
  if (!(fastUnresolved || lowConfidence || languageAmbiguity || missingAction)) return null;
  return {
    schema_version: "human-interpretation-request.v1",
    reason: fastUnresolved ? signalHint.uncertainty_reason ?? "unclassified_market_language"
      : lowConfidence ? "low_language_confidence"
        : missingAction ? "market_message_action_unknown" : "language_intent_ambiguous",
    luna_classification: luna?.classification ?? null,
    luna_confidence: Number.isFinite(confidence) ? confidence : null,
    ambiguities: Array.isArray(luna?.ambiguities) ? luna.ambiguities : [],
    status: "pending"
  };
}

async function captureForHumanInterpretation(config, db, row, luna, signalHint, record, options, request) {
  const context = resolveSignalContext(db, row, luna);
  const signalSnapshot = context ? getLatestMarketSnapshot(db, context.signalRow.id)?.snapshot ?? null : null;
  let marketInput = context && context.signalRow.id !== row.id
    ? lunaWithSignalContract(luna, context, signalSnapshot)
    : { ...luna, contract: { ...(signalHint?.contract ?? {}), ...(luna?.contract ?? {}) } };
  let captureBasis = context && context.signalRow.id !== row.id ? "reply_chain_contract" : "message_contract";
  if (!marketInput.contract?.symbol) {
    marketInput = {
      ...marketInput,
      contract: {
        ...(marketInput.contract ?? {}),
        symbol: String(config.listener?.humanInterpretationDefaultSymbol ?? "SPY").toUpperCase()
      }
    };
    captureBasis = "default_market_context";
  }
  let marketSnapshot = getLatestMarketSnapshot(db, row.id)?.snapshot ?? null;
  if (!marketSnapshot) {
    try {
      marketSnapshot = await (options.marketSnapshotPromise
        ?? options.marketCapture?.(config, marketInput, effectiveMessageTime(record))
        ?? captureMarketSnapshot(config, marketInput, effectiveMessageTime(record)));
    } catch (error) {
      const capturedAt = new Date().toISOString();
      marketSnapshot = {
        schema_version: "market-snapshot.v2",
        provider: config.marketData?.primary ?? "none",
        source_role: "unavailable",
        data_tier: "text_only",
        signal_published_at: effectiveMessageTime(record),
        observed_at: null,
        as_of: capturedAt,
        captured_at: capturedAt,
        execution_eligible: false,
        missing_reason: `Human-review market capture failed: ${String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300)}`
      };
    }
    if (!getLatestMarketSnapshot(db, row.id)) appendMarketSnapshot(db, row.id, marketSnapshot);
  }
  const stored = appendInterpretationEvent(db, {
    eventKey: `raw-${row.id}:human-interpretation-pending:v1`,
    rawMessageId: row.id,
    eventType: "pending",
    payload: {
      ...request,
      capture_basis: captureBasis,
      inherited_signal_raw_message_id: context?.signalRow?.id ?? null,
      market_snapshot: {
        provider: marketSnapshot?.provider ?? null,
        data_tier: marketSnapshot?.data_tier ?? null,
        observed_at: marketSnapshot?.observed_at ?? null,
        captured_at: marketSnapshot?.captured_at ?? null,
        time_alignment: marketSnapshot?.time_alignment ?? null,
        symbol: marketInput.contract?.symbol ?? null,
        contract: marketSnapshot?.target_contract?.matched ?? marketInput.contract ?? null
      }
    }
  });
  return { ...request, newly_queued: stored.inserted, marketSnapshot, capture_basis: captureBasis };
}

export async function processMessage(config, db, record, telegram = {}, options = {}) {
  const stored = options.stored ?? appendRawMessage(db, record);
  const media = telegram.client && telegram.message
    ? await ingestMessageMedia(config, db, telegram.client, stored.id, record, telegram.message)
    : { evidence: [], newAnalysis: false };
  const row = getRawMessage(db, stored.id);
  const signalHint = options.signalHint ?? getSignalHint(db, stored.id);
  const raw = rawRowForPrompt(config, row, media.evidence, signalHint, media.error ?? null);
  let luna = getLatestStageOutput(db, stored.id, "luna");
  let terra = getLatestStageOutput(db, stored.id, "terra");
  const refreshLuna = !luna || media.newAnalysis;
  const refreshTerra = !terra || refreshLuna;
  if (!isLatestRawMessageVersion(db, stored.id)) {
    if (options.positionWorkflows?.supersede) {
      await options.positionWorkflows.supersede(stored.id, "newer_telegram_edit_already_persisted").catch(() => {});
    }
    return {
      rawMessageId: stored.id,
      duplicate: !stored.inserted,
      superseded: true,
      superseded_reason: "newer_telegram_edit_already_persisted",
      luna,
      terra,
      media: media.evidence,
      mediaError: media.error ?? null
    };
  }
  if (!refreshLuna && !MARKET_RELEVANT_CLASSIFICATIONS.has(luna.classification)
      && !humanInterpretationRequest(config, luna, signalHint)) {
    return { rawMessageId: stored.id, duplicate: !stored.inserted, luna, terra: null, media: media.evidence, mediaError: media.error ?? null };
  }
  if (refreshLuna) {
    const lunaSession = nextAnalysisSessionKey(db, "luna", row);
    try {
      const result = await runOpenClawAgent(config, "luna", lunaPrompt(raw), lunaSession);
      luna = applySourceSemantics(config, record, result.output, signalHint);
      if (isResearchOnlyOptionCommentary(record, signalHint)) {
        luna = {
          ...luna,
          classification: "non_signal",
          lifecycle_action: null,
          data_role: "secondary_market_context",
          routing: {
            schema_version: "secondary-router.v2",
            reason: "operator_defined_research_only_option_commentary",
            excluded_from_intraday_option_workflows: true
          }
        };
      }
      requireSchema(luna, "luna.v1");
      appendAnalysis(db, {
        rawMessageId: stored.id, stage: "luna", schemaVersion: "luna.v1",
        model: config.openclaw.agents.luna.model, sessionKey: lunaSession,
        status: "ok", input: raw, output: luna
      });
    } catch (error) {
      appendAnalysis(db, {
        rawMessageId: stored.id, stage: "luna", schemaVersion: "luna.v1",
        model: config.openclaw.agents.luna.model, sessionKey: lunaSession,
        status: "error", input: raw, error: error.message
      });
      throw error;
    }
  }

  if (!isLatestRawMessageVersion(db, stored.id)) {
    if (options.positionWorkflows?.supersede) {
      await options.positionWorkflows.supersede(stored.id, "newer_telegram_edit_arrived_during_luna").catch(() => {});
    }
    return {
      rawMessageId: stored.id,
      superseded: true,
      superseded_reason: "newer_telegram_edit_arrived_during_luna",
      luna,
      terra: null,
      media: media.evidence,
      mediaError: media.error ?? null
    };
  }

  const interpretationRequest = humanInterpretationRequest(config, luna, signalHint);
  if (!MARKET_RELEVANT_CLASSIFICATIONS.has(luna.classification)) {
    const humanInterpretation = interpretationRequest
      ? await captureForHumanInterpretation(config, db, row, luna, signalHint, record, options, interpretationRequest)
      : null;
    return {
      rawMessageId: stored.id,
      luna,
      terra: null,
      humanInterpretation,
      marketSnapshot: humanInterpretation?.marketSnapshot ?? null,
      media: media.evidence,
      mediaError: media.error ?? null
    };
  }

  const context = resolveSignalContext(db, row, luna);
  const signalSnapshot = context ? getLatestMarketSnapshot(db, context.signalRow.id)?.snapshot ?? null : null;
  const marketLuna = context && context.signalRow.id !== row.id ? lunaWithSignalContract(luna, context, signalSnapshot) : luna;
  const promisedMarketSnapshot = options.marketSnapshotPromise
    ? await options.marketSnapshotPromise
    : null;
  let marketSnapshotRecord = getLatestMarketSnapshot(db, stored.id);
  const marketSnapshot = promisedMarketSnapshot ?? marketSnapshotRecord?.snapshot
    ?? await captureMarketSnapshot(config, marketLuna, effectiveMessageTime(record));
  const upgradesPreliminary = marketSnapshotRecord?.snapshot?.capture_stage === "preliminary_quote"
    && marketSnapshot?.capture_stage !== "preliminary_quote";
  if (!marketSnapshotRecord || upgradesPreliminary) {
    const id = appendMarketSnapshot(db, stored.id, marketSnapshot);
    marketSnapshotRecord = { id, snapshot: marketSnapshot, snapshot_json: JSON.stringify(marketSnapshot) };
  }
  const terraInput = terraInputManifest(row, luna, marketSnapshotRecord, raw);
  const openingSignal = luna.classification === "options_signal"
    && luna.contract?.open_action === "buy_to_open";
  let workflowOpen = null;
  if (openingSignal && options.positionWorkflows) {
    workflowOpen = await options.positionWorkflows.open({ row, luna, marketSnapshot, raw });
  }
  let lifecycleReview = null;
  if (luna.lifecycle_action === "sell_to_close" && context) {
    lifecycleReview = reviewSellToClose(db, context, row, marketSnapshot);
  }
  const partialExitFraction = lifecycleReview
    ? sourceExitFraction(record, luna)
    : null;
  const workflowExitHandler = () => {
    if (partialExitFraction != null && options.positionWorkflows?.recordPartialExit) {
      return options.positionWorkflows.recordPartialExit.bind(options.positionWorkflows);
    }
    return options.positionWorkflows?.complete.bind(options.positionWorkflows);
  };
  if (refreshTerra) {
    const terraSession = nextAnalysisSessionKey(db, "terra", row);
    try {
      const result = await runOpenClawAgent(config, "terra", terraPrompt(raw, luna, marketSnapshot), terraSession);
      terra = applyTerraSourceSemantics(config, record, luna, result.output, marketSnapshot);
      requireSchema(terra, "terra.v1");
      if (terra.status === "scored" && !isScorableOptionSnapshot(
        marketSnapshot,
        effectiveMessageTime(record),
        Number(config.marketData?.maxLiveLagSeconds ?? 300)
      )) {
        throw new Error("Terra attempted to score without a time-aligned, exact, executable option quote.");
      }
      appendAnalysis(db, {
        rawMessageId: stored.id, stage: "terra", schemaVersion: "terra.v1",
        model: config.openclaw.agents.terra.model, sessionKey: terraSession,
        status: "ok", input: terraInput, output: terra
      });
    } catch (error) {
      appendAnalysis(db, {
        rawMessageId: stored.id, stage: "terra", schemaVersion: "terra.v1",
        model: config.openclaw.agents.terra.model, sessionKey: terraSession,
        status: "error", input: terraInput, error: error.message
      });
      if (lifecycleReview && options.positionWorkflows) {
        const finish = workflowExitHandler();
        await finish({
          signalRawMessageId: context.signalRow.id,
          exitRawMessageId: row.id,
          lifecycleReview: lifecycleReview.review,
          exitFraction: partialExitFraction,
          terra: null
        }).catch(() => {});
      }
      throw error;
    }
  }
  if (!isLatestRawMessageVersion(db, stored.id)) {
    if (options.positionWorkflows?.supersede) {
      await options.positionWorkflows.supersede(row.id, "newer_telegram_edit_arrived_during_terra");
    }
    return {
      rawMessageId: stored.id,
      superseded: true,
      superseded_reason: "newer_telegram_edit_arrived_during_terra",
      luna,
      terra,
      marketSnapshot,
      media: media.evidence,
      mediaError: media.error ?? null
    };
  }
  let workflowResult = workflowOpen;
  if (openingSignal && options.positionWorkflows) {
    workflowResult = await options.positionWorkflows.enrich(row.id, terra);
  } else if (luna.classification === "update" && context && options.positionWorkflows?.recordPositionUpdate) {
    workflowResult = await options.positionWorkflows.recordPositionUpdate({
      signalRawMessageId: context.signalRow.id,
      updateRawMessageId: row.id,
      luna,
      terra,
      marketSnapshot
    });
  } else if (lifecycleReview && options.positionWorkflows) {
    const finish = workflowExitHandler();
    workflowResult = await finish({
      signalRawMessageId: context.signalRow.id,
      exitRawMessageId: row.id,
      lifecycleReview: lifecycleReview.review,
      exitFraction: partialExitFraction,
      terra
    });
  }
  const humanInterpretation = interpretationRequest
    ? await captureForHumanInterpretation(config, db, row, luna, signalHint, record, options, interpretationRequest)
    : null;
  return {
    rawMessageId: stored.id,
    luna,
    terra,
    marketSnapshot,
    lifecycleReview: lifecycleReview?.review ?? null,
    positionWorkflow: workflowResult,
    humanInterpretation,
    media: media.evidence,
    mediaError: media.error ?? null
  };
}
