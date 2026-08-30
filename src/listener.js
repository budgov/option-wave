import {
  appendRawMessage,
  appendMarketSnapshot,
  appendSignalHint,
  getSignalHint,
  getLatestMarketSnapshot,
  getOperationalState,
  getRawMessage,
  listPendingRawMessages,
  setOperationalState
} from "./db.js";
import { captureMarketSnapshot } from "./market-data.js";
import { captureNotification, exceptionNotification, interpretationNotification, signalNotification } from "./notifier.js";
import {
  archiveSecondaryContext,
  canArchiveAsSecondaryContext,
  effectiveMessageTime,
  messageClockDeltaMilliseconds,
  processMessage
} from "./pipeline.js";
import { detectSignalHint } from "./signal-detector.js";
import { latestMessageId, messageRecord, messagesAfter } from "./telegram-client.js";
import { lunaWithSignalContract, resolveSignalContext } from "./lifecycle.js";
import { AI_CIRCUIT_KEY, classifyAiAvailabilityError, isAiCircuitOpen } from "./ai-circuit.js";
import { persistMessageMedia } from "./media.js";
import { detectChannelForecastCandidate, recordVerifiedChannelForecasts } from "./channel-forecast.js";

const IMPORTANT_CLASSIFICATIONS = new Set(["options_signal", "update", "cancel", "outcome"]);

function cursorKey(channelKey) {
  return `telegram_cursor:${channelKey}`;
}

export function channelCursor(db, channelKey) {
  return Number(getOperationalState(db, cursorKey(channelKey))?.message_id ?? 0);
}

function advanceChannelCursor(db, record) {
  const messageId = Number(record.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error(`Invalid Telegram message id: ${record.messageId}`);
  const current = channelCursor(db, record.channelKey);
  if (messageId <= current) return current;
  setOperationalState(db, cursorKey(record.channelKey), {
    message_id: messageId,
    published_at: record.publishedAt,
    captured_at: new Date().toISOString()
  });
  return messageId;
}

export async function initializeCursorBaselines(db, client, channels) {
  const initialized = [];
  for (const channel of channels) {
    if (getOperationalState(db, cursorKey(channel.key))) continue;
    const messageId = await latestMessageId(client, channel);
    setOperationalState(db, cursorKey(channel.key), {
      message_id: messageId,
      published_at: null,
      captured_at: new Date().toISOString(),
      baseline_only: true
    });
    initialized.push({ channel_key: channel.key, message_id: messageId });
  }
  return initialized;
}

function recordFromRow(row) {
  return {
    channelKey: row.channel_key,
    chatId: row.telegram_chat_id,
    messageId: row.telegram_message_id,
    publishedAt: row.published_at,
    receivedAt: row.received_at,
    editedAt: row.edited_at,
    eventAt: row.edited_at ?? row.published_at,
    replyToMessageId: row.reply_to_message_id,
    rawText: row.raw_text,
    raw: JSON.parse(row.raw_json)
  };
}

function earlySnapshot(config, db, rawMessageId, hint, publishedAt, marketCapture, positionWorkflows, logger) {
  if (!IMPORTANT_CLASSIFICATIONS.has(hint.classification) && hint.needs_human_interpretation !== true) return null;
  const row = getRawMessage(db, rawMessageId);
  const quick = {
    classification: hint.classification,
    lifecycle_action: hint.action === "sell_to_close" ? "sell_to_close" : null,
    contract: hint.contract,
    evidence: { raw_text: row?.raw_text ?? "" },
    follow_up: { parent_message_id: hint.reply_to_message_id }
  };
  const context = resolveSignalContext(db, row, quick);
  const signalSnapshot = context ? getLatestMarketSnapshot(db, context.signalRow.id)?.snapshot ?? null : null;
  let marketInput = context && context.signalRow.id !== row.id ? lunaWithSignalContract(quick, context, signalSnapshot) : quick;
  if (!marketInput.contract?.symbol && hint.needs_human_interpretation === true) {
    marketInput = {
      ...marketInput,
      contract: {
        ...(marketInput.contract ?? {}),
        symbol: String(config.listener?.humanInterpretationDefaultSymbol ?? "SPY").toUpperCase()
      },
      human_interpretation_context_only: true
    };
  }
  if (!marketInput.contract?.symbol) return null;
  let capture;
  try {
    // Start the quote request in the same intake turn so its timestamp remains
    // aligned with the Telegram signal; attach rejection handling immediately.
    capture = marketCapture(config, marketInput, publishedAt, {
      onPreliminarySnapshot(snapshot) {
        if (!getLatestMarketSnapshot(db, rawMessageId)) {
          appendMarketSnapshot(db, rawMessageId, snapshot);
        }
      }
    });
  } catch (error) {
    capture = Promise.reject(error);
  }
  return Promise.resolve(capture)
    .catch((error) => {
      const capturedAt = new Date().toISOString();
      return {
        schema_version: "market-snapshot.v2",
        provider: config.marketData?.primary ?? "none",
        source_role: "unavailable",
        data_tier: "text_only",
        signal_published_at: publishedAt,
        observed_at: null,
        as_of: capturedAt,
        captured_at: capturedAt,
        execution_eligible: false,
        missing_reason: `Market capture failed: ${String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300)}`
      };
    })
    .then(async (snapshot) => {
      const latest = getLatestMarketSnapshot(db, rawMessageId)?.snapshot ?? null;
      if (!latest || (latest.capture_stage === "preliminary_quote" && snapshot.capture_stage !== "preliminary_quote")) {
        appendMarketSnapshot(db, rawMessageId, snapshot);
      }
      const primeEligible = hint?.explicit === true
        && hint?.classification === "options_signal"
        && hint?.action === "buy_to_open";
      if (primeEligible && positionWorkflows?.prime) {
        try {
          await positionWorkflows.prime({
            row: getRawMessage(db, rawMessageId),
            hint,
            marketSnapshot: snapshot
          });
        } catch (error) {
          logger?.error?.(`Early position prediction failed for raw ${rawMessageId}: ${error.stack ?? error.message}`);
        }
      }
      return snapshot;
    });
}

export function createMessageCoordinator({
  config,
  db,
  client,
  notifier,
  logger = console,
  processor = processMessage,
  positionWorkflows = null,
  marketCapture = captureMarketSnapshot,
  mediaCapture = persistMessageMedia
}) {
  const channelQueues = new Map();
  const queued = new Set();
  const retryState = new Map();
  const maxQueuedMessages = Number(config.listener?.maxQueuedMessages ?? 250);
  const maxRetryEntries = Math.max(1000, maxQueuedMessages * 4);
  let aiCircuit = getOperationalState(db, AI_CIRCUIT_KEY);
  let accepting = true;

  function activeAiCircuit() {
    return isAiCircuitOpen(aiCircuit) ? aiCircuit : null;
  }

  const initialAiPause = activeAiCircuit();
  if (initialAiPause) {
    logger.log(`AI analysis paused until ${initialAiPause.retry_after}: ${initialAiPause.summary}`);
  }

  function openAiCircuit(classification) {
    const existing = activeAiCircuit();
    aiCircuit = {
      status: "open",
      kind: classification.kind,
      retry_after: classification.retry_after,
      summary: classification.summary,
      opened_at: existing?.opened_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setOperationalState(db, AI_CIRCUIT_KEY, aiCircuit);
    return !existing;
  }

  async function closeAiCircuitIfNeeded() {
    if (aiCircuit?.status !== "open") return;
    aiCircuit = { ...aiCircuit, status: "closed", recovered_at: new Date().toISOString() };
    setOperationalState(db, AI_CIRCUIT_KEY, aiCircuit);
    await notifier.send("recovery", "Ocean-Wave AI 深度分析已恢复，待处理消息正在自动补做。");
  }

  function rememberRetry(rawMessageId, retry) {
    retryState.set(rawMessageId, { ...retry, failedAt: Date.now() });
    if (retryState.size <= maxRetryEntries) return;
    const oldest = [...retryState.entries()]
      .sort((left, right) => left[1].failedAt - right[1].failedAt)
      .slice(0, retryState.size - maxRetryEntries);
    for (const [id] of oldest) retryState.delete(id);
  }

  function trackChannelTask(stored, record, task) {
    const guarded = Promise.resolve(task).catch((error) => {
      const prior = retryState.get(stored.id);
      rememberRetry(stored.id, {
        attempts: Math.max(1, Number(prior?.attempts ?? 0)),
        retryAfter: prior?.retryAfter ?? Date.now() + 30_000,
        alerted: prior?.alerted === true
      });
      logger.error(`Channel task failure for ${record.channelKey} #${record.messageId}: ${error.stack ?? error.message}`);
    });
    channelQueues.set(record.channelKey, guarded);
    const release = () => {
      if (channelQueues.get(record.channelKey) === guarded) channelQueues.delete(record.channelKey);
    };
    void guarded.then(release, release);
  }

  async function preserveDeferredEvidence(stored, record, telegramMessage, marketSnapshotPromise, pause) {
    const media = client && telegramMessage
      ? await mediaCapture(config, db, client, stored.id, record, telegramMessage)
      : { evidence: [], newAnalysis: false, error: null };
    if (marketSnapshotPromise) await marketSnapshotPromise;
    if (media.error) {
      rememberRetry(stored.id, { attempts: 1, retryAfter: Date.now() + 30_000 });
      await notifier.send("error", `Ocean-Wave 图片保存待重试\n${record.channelKey} #${record.messageId}\n${media.error}`);
    } else {
      rememberRetry(stored.id, { attempts: 0, retryAfter: Date.parse(pause.retry_after) });
    }
    const mediaCount = media.evidence?.length ?? 0;
    logger.log(`${record.channelKey} #${record.messageId}: evidence saved; AI deferred${mediaCount ? ` media=${mediaCount}` : ""}`);
  }

  function enqueue(stored, record, telegramMessage, source, hint, marketSnapshotFactory = null, intakeMetrics = null) {
    if (queued.has(stored.id)) return { rawMessageId: stored.id, inserted: stored.inserted, hint, queued: false };
    const paused = activeAiCircuit();
    if (stored.inserted) {
      const timing = intakeMetrics
        ? ` transport=${Number.isFinite(intakeMetrics.transportMs) ? Math.round(intakeMetrics.transportMs) : "unknown"}ms clock_delta=${Number.isFinite(intakeMetrics.clockDeltaMs) ? Math.round(intakeMetrics.clockDeltaMs) : "unknown"}ms durable=${intakeMetrics.durableMs.toFixed(1)}ms`
        : "";
      logger.log(`${record.channelKey} #${record.messageId}: captured (${source})${timing}`);
      if (hint.explicit) {
        void Promise.resolve().then(() => notifier.send("capture", captureNotification(config, record, hint, source, {
          aiPausedUntil: paused?.retry_after ?? null
        }))).catch((error) => {
          logger.error(`Capture notification error for ${record.channelKey} #${record.messageId}: ${error.message}`);
        });
      }
    }
    const channelForecastCandidate = detectChannelForecastCandidate(record);
    if (canArchiveAsSecondaryContext(record, hint) && !channelForecastCandidate.eligible) {
      const archived = archiveSecondaryContext(db, record, stored.id, hint);
      retryState.delete(stored.id);
      logger.log(`${record.channelKey} #${record.messageId}: secondary market context archived locally${archived.inserted ? "" : " (existing)"}`);
      return {
        rawMessageId: stored.id,
        inserted: stored.inserted,
        hint,
        queued: false,
        secondaryContext: true
      };
    }
    const marketSnapshotPromise = marketSnapshotFactory?.() ?? null;
    if (queued.size >= maxQueuedMessages) {
      if (marketSnapshotPromise) void Promise.resolve(marketSnapshotPromise).catch((error) => {
        logger.error(`Deferred market snapshot error for ${record.channelKey} #${record.messageId}: ${error.message}`);
      });
      logger.error(`${record.channelKey} #${record.messageId}: analysis deferred; queue limit ${maxQueuedMessages} reached`);
      return { rawMessageId: stored.id, inserted: stored.inserted, hint, queued: false, deferred: true };
    }

    if (paused) {
      queued.add(stored.id);
      const priorQueue = channelQueues.get(record.channelKey) ?? Promise.resolve();
      const task = priorQueue.then(() => preserveDeferredEvidence(
        stored, record, telegramMessage, marketSnapshotPromise, paused
      )).catch(async (error) => {
        rememberRetry(stored.id, { attempts: 1, retryAfter: Date.now() + 30_000 });
        logger.error(`Deferred evidence error for ${record.channelKey} #${record.messageId}: ${error.message}`);
        await notifier.send("error", exceptionNotification(`evidence ${record.channelKey} #${record.messageId}`, error));
      }).finally(() => {
        queued.delete(stored.id);
      });
      trackChannelTask(stored, record, task);
      return { rawMessageId: stored.id, inserted: stored.inserted, hint, queued: true, deferred: true, aiPaused: true };
    }

    queued.add(stored.id);
    const priorQueue = channelQueues.get(record.channelKey) ?? Promise.resolve();
    const task = priorQueue.then(async () => {
      try {
        const currentPause = activeAiCircuit();
        if (currentPause) {
          await preserveDeferredEvidence(stored, record, telegramMessage, marketSnapshotPromise, currentPause);
          return;
        }
        const result = await processor(config, db, record, { client, message: telegramMessage }, {
          stored,
          signalHint: hint,
          marketSnapshotPromise,
          marketCapture,
          positionWorkflows
        });
        const channelForecastEvents = recordVerifiedChannelForecasts(config, db, record, stored.id, result.luna);
        if (channelForecastEvents.some((event) => event.inserted)) {
          logger.log(`${record.channelKey} #${record.messageId}: verified market forecast queued on isolated data plane`);
        }
        if (marketSnapshotPromise) await marketSnapshotPromise;
        const priorFailure = retryState.get(stored.id);
        retryState.delete(stored.id);
        await closeAiCircuitIfNeeded();
        const mediaCount = result.media?.length ?? 0;
        logger.log(`${record.channelKey} #${record.messageId}: ${result.duplicate ? "already analyzed" : "analyzed"}${mediaCount ? ` media=${mediaCount}` : ""}`);
        if (result.mediaError) {
          await notifier.send("error", `Ocean-Wave 图片待重试\n${record.channelKey} #${record.messageId}\n${result.mediaError}`);
        }
        // Startup/backoff retries repair the stored analysis silently. The
        // original fast capture alert was already sent, so replaying every
        // enhanced result would create a notification burst after recovery.
        if (source !== "retry" && !result.superseded && IMPORTANT_CLASSIFICATIONS.has(result.luna?.classification)) {
          await notifier.send("signal", signalNotification(config, record, result));
        }
        if (source !== "retry" && result.humanInterpretation?.newly_queued) {
          await notifier.send("interpretation", interpretationNotification(config, record, result.humanInterpretation));
        }
        if (priorFailure?.alerted) {
          await notifier.send("recovery", `Ocean-Wave 自动修复完成\n${record.channelKey} #${record.messageId}\n分析记录已补齐。`);
        }
      } catch (error) {
        const availability = classifyAiAvailabilityError(error);
        if (availability) {
          rememberRetry(stored.id, { attempts: 0, retryAfter: Date.parse(availability.retry_after) });
          const newlyOpened = openAiCircuit(availability);
          logger.error(`AI analysis paused until ${availability.retry_after}: ${availability.summary}`);
          if (newlyOpened) {
            await notifier.send("error", [
              "Ocean-Wave AI 深度分析暂时暂停",
              availability.summary,
              `自动重试时间: ${availability.retry_after}`,
              "Telegram 原文、快速信号和实时行情仍会继续保存；待处理消息不会丢失。"
            ].join("\n"));
          }
          return;
        }
        const prior = retryState.get(stored.id) ?? { attempts: 0, alerted: false };
        const persistedFailures = Number(db.prepare(
          "SELECT COUNT(*) AS count FROM analysis_runs WHERE raw_message_id=? AND status='error'"
        ).get(Number(stored.id)).count);
        const attempts = Math.max(prior.attempts + 1, persistedFailures);
        const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 5));
        const alertAfterAttempts = Number(config.listener?.analysisAlertAfterAttempts ?? 2);
        const shouldAlert = attempts >= alertAfterAttempts && prior.alerted !== true;
        rememberRetry(stored.id, {
          attempts,
          retryAfter: Date.now() + backoffMs,
          alerted: prior.alerted === true || shouldAlert
        });
        logger.error(`Pipeline error for ${record.channelKey} #${record.messageId}: ${error.stack ?? error.message}`);
        if (shouldAlert) {
          await notifier.send("error", exceptionNotification(`pipeline ${record.channelKey} #${record.messageId}`, error));
        } else {
          logger.log(`${record.channelKey} #${record.messageId}: transient analysis failure retained for silent retry (${attempts}/${alertAfterAttempts}).`);
        }
      } finally {
        queued.delete(stored.id);
      }
    });
    trackChannelTask(stored, record, task);
    return { rawMessageId: stored.id, inserted: stored.inserted, hint, queued: true };
  }

  function schedule(record, telegramMessage, source = "telegram") {
    if (!accepting) return { queued: false, stopping: true };
    const hint = detectSignalHint(record);
    const durableStarted = performance.now();
    let stored;
    // One immediate transaction makes the raw message, deterministic hint and
    // cursor durable together with one WAL sync instead of three independent
    // commits. No OCR, network or model work occurs while the lock is held.
    db.exec("BEGIN IMMEDIATE");
    try {
      stored = appendRawMessage(db, record);
      appendSignalHint(db, stored.id, hint);
      advanceChannelCursor(db, record);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    const clockDeltaMs = messageClockDeltaMilliseconds(record);
    const intakeMetrics = {
      durableMs: performance.now() - durableStarted,
      transportMs: clockDeltaMs == null ? null : Math.max(0, clockDeltaMs),
      clockDeltaMs
    };
    return enqueue(stored, record, telegramMessage, source, hint,
      () => earlySnapshot(
        config, db, stored.id, hint, effectiveMessageTime(record), marketCapture, positionWorkflows, logger
      ), intakeMetrics);
  }

  function scheduleStored(row, telegramMessage, source = "retry") {
    if (!accepting) return { queued: false, stopping: true };
    const record = recordFromRow(row);
    const hint = getSignalHint(db, Number(row.id)) ?? detectSignalHint(record);
    appendSignalHint(db, Number(row.id), hint);
    return enqueue({ id: Number(row.id), inserted: false }, record, telegramMessage, source, hint,
      () => earlySnapshot(
        config, db, Number(row.id), hint, effectiveMessageTime(record), marketCapture, positionWorkflows, logger
      ));
  }

  async function retryPending(channels, limit = 2) {
    if (!accepting) return 0;
    const byKey = new Map(channels.map((channel) => [channel.key, channel]));
    const scheduledChannels = new Set();
    let scheduled = 0;
    // Inspect a bounded window larger than the dispatch limit so one busy
    // channel cannot hide pending work from the other. Dispatch at most one
    // item per channel per sweep, leaving live messages nearly unblocked.
    const scanLimit = Math.max(limit, Math.min(500, limit * Math.max(10, channels.length)));
    for (const row of listPendingRawMessages(db, scanLimit)) {
      if (scheduled >= limit) break;
      if (scheduledChannels.has(row.channel_key)) continue;
      // Never append repair work behind live or gap-recovery work already in
      // this channel. A later sweep will pick it up when the channel is idle.
      if (channelQueues.has(row.channel_key)) continue;
      if (queued.has(Number(row.id))) continue;
      const retry = retryState.get(Number(row.id));
      if (retry && retry.retryAfter > Date.now()) continue;
      const channel = byKey.get(row.channel_key);
      if (!channel) continue;
      let telegramMessage;
      try {
        telegramMessage = (await client.getMessages(channel.entity, { ids: Number(row.telegram_message_id) }))[0];
      } catch (error) {
        logger.error(`Pending message fetch failed for ${row.channel_key} #${row.telegram_message_id}: ${error.message}`);
      }
      const record = recordFromRow(row);
      const currentMediaId = telegramMessage?.media?.photo?.id ?? telegramMessage?.media?.document?.id;
      if (record.raw?.media_id && currentMediaId != null && String(currentMediaId) !== String(record.raw.media_id)) {
        telegramMessage = undefined;
      }
      if (scheduleStored(row, telegramMessage, "retry").queued) {
        scheduled += 1;
        scheduledChannels.add(row.channel_key);
      }
    }
    return scheduled;
  }

  return {
    schedule,
    retryPending,
    analysisStatus: () => {
      const active = activeAiCircuit();
      return active
        ? { status: "paused", reason: active.summary, retry_after: active.retry_after }
        : { status: "ready" };
    },
    stopAccepting: () => { accepting = false; },
    drain: () => Promise.all([...channelQueues.values()]),
    queuedCount: () => queued.size
  };
}

export async function pollChannelsOnce(db, client, channels, schedule, batchSize = 100) {
  let captured = 0;
  for (const channel of channels) {
    const cursor = channelCursor(db, channel.key);
    const messages = await messagesAfter(client, channel, cursor, batchSize);
    for (const message of messages) {
      schedule(messageRecord(channel, message, false), message, "cursor_recovery");
      captured += 1;
    }
  }
  return captured;
}
