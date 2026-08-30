import { appendLifecycleReview, getLatestStageOutput, getSignalHint, listMediaEvidence } from "./db.js";
import { isAlignedSnapshot, snapshotLagSeconds, snapshotObservedAt } from "./market-data.js";

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function sourceKey(sourceId, messageId) {
  return `${sourceId}:${String(messageId)}`;
}

function rowSourceId(row) {
  return String(row?.telegram_chat_id ?? row?.channel_key ?? "unknown");
}

function signalOutput(db, row) {
  const luna = getLatestStageOutput(db, row.id, "luna");
  if (luna) return luna;
  const hint = getSignalHint(db, row.id);
  if (hint?.classification !== "options_signal") return null;
  return {
    schema_version: "signal-hint-adapter.v1",
    classification: "options_signal",
    signal_id: sourceKey(rowSourceId(row), row.telegram_message_id),
    contract: hint.contract,
    confidence: { overall: 0.5 },
    provenance: "deterministic_signal_hint"
  };
}

function contractScore(wanted, candidate) {
  if (!wanted?.symbol || wanted.symbol.toUpperCase() !== candidate?.symbol?.toUpperCase()) return -1;
  let score = 1;
  for (const field of ["expiry", "strike", "option_type"]) {
    if (wanted[field] == null) continue;
    if (String(wanted[field]).toLowerCase() !== String(candidate?.[field]).toLowerCase()) return -1;
    score += 1;
  }
  return score;
}

export function resolveSignalContext(db, currentRow, currentLuna) {
  if (currentLuna?.classification === "options_signal") {
    return { signalRow: currentRow, signalLuna: currentLuna, chain: [String(currentRow.telegram_message_id)], resolution: "self" };
  }
  const rows = db.prepare(`
    SELECT * FROM latest_raw_messages
    WHERE telegram_chat_id=?
    ORDER BY event_at,id
  `).all(rowSourceId(currentRow));
  const byKey = new Map(rows.map((row) => [sourceKey(rowSourceId(row), row.telegram_message_id), row]));
  let parent = currentRow.reply_to_message_id ?? currentLuna?.follow_up?.parent_message_id ?? currentLuna?.source?.reply_to_message_id;
  const visited = new Set();
  const chain = [String(currentRow.telegram_message_id)];
  while (parent != null) {
    const key = sourceKey(rowSourceId(currentRow), parent);
    if (visited.has(key)) break;
    visited.add(key);
    const row = byKey.get(key);
    if (!row) break;
    chain.push(String(row.telegram_message_id));
    const luna = signalOutput(db, row);
    if (luna?.classification === "options_signal") return { signalRow: row, signalLuna: luna, chain, resolution: "reply_chain" };
    parent = row.reply_to_message_id ?? luna?.follow_up?.parent_message_id ?? luna?.source?.reply_to_message_id;
  }

  // Fall back only when one earlier position uniquely matches the available
  // symbol/contract fields. Ambiguous same-symbol positions remain unlinked.
  const wanted = currentLuna?.contract ?? {};
  if (wanted.symbol) {
    const candidates = [];
    const currentEventAt = Date.parse(currentRow.edited_at ?? currentRow.published_at);
    for (const row of rows) {
      const candidateEventAt = Date.parse(row.event_at);
      if (row.id === currentRow.id
          || candidateEventAt > currentEventAt
          || (candidateEventAt === currentEventAt && row.id >= currentRow.id)) continue;
      const output = signalOutput(db, row);
      if (output?.classification !== "options_signal") continue;
      const score = contractScore(wanted, output.contract);
      if (score >= 1) candidates.push({ row, output, score });
    }
    const bestScore = Math.max(-1, ...candidates.map((candidate) => candidate.score));
    const best = candidates.filter((candidate) => candidate.score === bestScore);
    if (best.length === 1) {
      return {
        signalRow: best[0].row,
        signalLuna: best[0].output,
        chain: [String(currentRow.telegram_message_id), String(best[0].row.telegram_message_id)],
        resolution: "unique_contract_ledger"
      };
    }
  }
  return null;
}

export function lunaWithSignalContract(currentLuna, context, signalSnapshot = null) {
  if (!context || context.signalRow.id === context.currentRawMessageId) return currentLuna;
  const currentContract = Object.fromEntries(Object.entries(currentLuna?.contract ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  const signalContract = { ...(context.signalLuna?.contract ?? {}) };
  const resolvedExpiry = signalSnapshot?.target_contract?.resolved?.expiry
    ?? signalSnapshot?.target_contract?.matched?.expiry
    ?? null;
  if (!signalContract.expiry && resolvedExpiry) {
    signalContract.expiry = resolvedExpiry;
    signalContract.expiry_resolution = {
      policy: signalSnapshot?.target_contract?.resolved?.expiry_policy ?? "nearest_listed_expiry",
      resolved_expiry: resolvedExpiry,
      inferred: signalSnapshot?.target_contract?.resolved?.expiry_inferred === true
    };
  }
  const currentText = String(currentLuna?.evidence?.raw_text ?? "");
  const currentNamesContract = /\b(?:call|put)s?\b/i.test(currentText)
    && /\d+(?:\.\d+)?/.test(currentText);
  const mergedContract = { ...signalContract, ...currentContract };
  if (!currentNamesContract) {
    for (const field of ["symbol", "expiry", "strike", "option_type"]) {
      if (signalContract[field] != null) mergedContract[field] = signalContract[field];
    }
    if (signalContract.expiry_resolution) mergedContract.expiry_resolution = signalContract.expiry_resolution;
  }
  return {
    ...currentLuna,
    contract: mergedContract,
    lifecycle_signal_id: context.signalLuna?.signal_id
      ?? sourceKey(rowSourceId(context.signalRow), context.signalRow.telegram_message_id)
  };
}

function latestSnapshot(db, rawMessageId) {
  const row = db.prepare(`SELECT id,data_tier,provider,as_of,snapshot_json FROM market_snapshots WHERE raw_message_id=? ORDER BY id DESC LIMIT 1`).get(rawMessageId);
  return row ? { ...row, snapshot: parseJson(row.snapshot_json) } : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nestedEntryPrice(contract) {
  const value = typeof contract?.entry_price === "object"
    ? contract.entry_price?.value
    : contract?.entry_price;
  return finite(value);
}

function latestReportedAverageCost(db, context, exitRow) {
  const exitAt = exitRow?.edited_at ?? exitRow?.published_at;
  const rows = db.prepare(`
    SELECT * FROM latest_raw_messages
    WHERE telegram_chat_id=? AND reply_to_message_id=? AND event_at<=?
    ORDER BY event_at DESC,id DESC
  `).all(rowSourceId(context.signalRow), String(context.signalRow.telegram_message_id), exitAt);
  for (const row of rows) {
    const luna = getLatestStageOutput(db, row.id, "luna");
    const structured = finite(luna?.lifecycle?.average_cost);
    const raw = finite(String(row.raw_text ?? "").match(/(?:成本价|成本價|均价|均價)\s*@?\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]);
    const price = raw ?? structured;
    if (price != null && price > 0) {
      return { price, basis: "latest_source_reported_average_cost", evidence: `raw_message_id:${row.id}` };
    }
  }
  return null;
}

function sourceReportedEntry(db, context, exitRow) {
  const updatedAverage = latestReportedAverageCost(db, context, exitRow);
  if (updatedAverage) return updatedAverage;
  const price = nestedEntryPrice(context.signalLuna?.contract);
  const rawMatch = String(context.signalRow?.raw_text ?? "").match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/);
  const rawPrice = finite(rawMatch?.[1]);
  const accepted = rawPrice != null ? rawPrice : price;
  return accepted != null && accepted > 0
    ? { price: accepted, basis: "source_reported_fill", evidence: rawMatch?.[0] ?? "structured_entry_price" }
    : null;
}

function numericCandidates(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) numericCandidates(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) numericCandidates(item, output);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    output.push(value);
  } else if (typeof value === "string") {
    for (const match of value.replaceAll(",", "").matchAll(/(?:\$\s*)?([0-9]+(?:\.[0-9]+)?)/g)) {
      const number = Number(match[1]);
      if (Number.isFinite(number)) output.push(number);
    }
  }
  return output;
}

function mediaExitPrice(db, rawMessageId, entryPrice) {
  const upperBound = Math.max(20, Number(entryPrice ?? 1) * 20);
  const candidates = [];
  for (const media of listMediaEvidence(db, rawMessageId)) {
    const analysis = media.analysis;
    if (!analysis) continue;
    numericCandidates(analysis.entities?.prices, candidates);
    numericCandidates(analysis.market_fields?.option_values, candidates);
    numericCandidates(analysis.market_fields?.option_display, candidates);
    numericCandidates(analysis.market_fields?.displayed_values, candidates);
  }
  const plausible = candidates.filter((value) => value > 0 && value <= upperBound
    && (entryPrice == null || Math.abs(value - entryPrice) > 1e-9));
  return plausible.length ? Math.max(...plausible) : null;
}

function chainRows(db, context) {
  const rows = [];
  for (const messageId of context.chain ?? []) {
    const row = db.prepare(`
      SELECT * FROM latest_raw_messages WHERE telegram_chat_id=? AND telegram_message_id=?
    `).get(rowSourceId(context.signalRow), String(messageId));
    if (row) rows.push(row);
  }
  return rows;
}

function sourceReportedExit(db, context, exitRow, exitLuna, entryPrice) {
  const structured = finite(exitLuna?.lifecycle?.reference_exit_price);
  if (structured != null && structured > 0) {
    return { price: structured, basis: "source_reported_fill", evidence: "luna.lifecycle.reference_exit_price" };
  }
  const raw = String(exitRow.raw_text ?? "");
  const direct = raw.match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/)
    ?? raw.match(/(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s*(?=止盈|止损|停损)/);
  const directPrice = finite(direct?.[1]);
  if (directPrice != null && directPrice > 0) {
    return { price: directPrice, basis: "source_reported_fill", evidence: direct[0].trim() };
  }
  // context.chain is newest-to-oldest. The first screenshot price is therefore
  // the last posted profit-control point, as required by the channel policy.
  for (const row of chainRows(db, context)) {
    if (row.id === context.signalRow.id) continue;
    const price = mediaExitPrice(db, row.id, entryPrice);
    if (price != null) {
      return {
        price,
        basis: "source_reported_screenshot_fill",
        evidence: `raw_message_id:${row.id}`,
        selected_policy: "last_screenshot_exit"
      };
    }
  }
  return null;
}

function contractQuote(snapshot) {
  const matched = snapshot?.target_contract?.matched;
  if (!matched) return null;
  return { bid: finite(matched.bid), ask: finite(matched.ask), timestamp: snapshotObservedAt(snapshot) };
}

export function buildLifecycleReview(db, context, exitRow, exitSnapshot) {
  const signalEventAt = context.signalRow.edited_at ?? context.signalRow.published_at;
  const exitEventAt = exitRow.edited_at ?? exitRow.published_at;
  const entryRecord = latestSnapshot(db, context.signalRow.id);
  const entrySnapshot = entryRecord?.snapshot ?? null;
  const entryQuote = contractQuote(entrySnapshot);
  const exitQuote = contractQuote(exitSnapshot);
  const maxLagSeconds = 300;
  const entryAligned = Boolean(entrySnapshot && isAlignedSnapshot(entrySnapshot, signalEventAt, maxLagSeconds));
  const exitAligned = Boolean(exitSnapshot && isAlignedSnapshot(exitSnapshot, exitEventAt, maxLagSeconds));
  const ocean = entrySnapshot?.ocean_wave ?? null;
  const optionType = context.signalLuna?.contract?.option_type ?? null;
  const exposure = optionType === "call" ? 1 : optionType === "put" ? -1 : null;
  const trend = finite(ocean?.trend_score);
  const alignment = trend == null || exposure == null ? null : trend * exposure;
  const entryAsk = entryQuote?.ask;
  const exitBid = exitQuote?.bid;
  const exitLuna = getLatestStageOutput(db, exitRow.id, "luna");
  const reportedEntry = sourceReportedEntry(db, context, exitRow);
  const reportedExit = sourceReportedExit(db, context, exitRow, exitLuna, reportedEntry?.price ?? entryAsk);
  const entryExecutionPrice = reportedEntry?.price ?? (entryAligned ? entryAsk : null);
  const exitExecutionPrice = reportedExit?.price ?? (exitAligned ? exitBid : null);
  const grossReturn = entryExecutionPrice != null && entryExecutionPrice > 0 && exitExecutionPrice != null
    ? (exitExecutionPrice - entryExecutionPrice) / entryExecutionPrice : null;
  const holdMinutes = Math.max(0, (Date.parse(exitEventAt) - Date.parse(signalEventAt)) / 60000);
  const usablePrediction = entryRecord && entryRecord.data_tier !== "text_only" && entryAligned && ocean;
  const usableEntryExecution = entryExecutionPrice != null && entryExecutionPrice > 0;
  const usableExitExecution = exitExecutionPrice != null && exitExecutionPrice > 0;
  const entryPredictionStatus = usablePrediction ? "scored_point_in_time" : "abstained_missing_point_in_time_input";
  const exitCheckStatus = reportedExit ? "accepted_source_reported_fill"
    : usableExitExecution ? "checked_point_in_time" : "abstained_missing_execution_input";
  const status = usablePrediction && usableEntryExecution && usableExitExecution
    ? "scored" : usableEntryExecution && usableExitExecution
      ? "execution_only_source_reported" : "blocked_missing_execution_data";
  return {
    status,
    inputManifest: {
      entry_snapshot_id: entryRecord?.id ?? null,
      exit_snapshot_as_of: snapshotObservedAt(exitSnapshot) ?? exitEventAt,
      entry_analysis_signal_id: context.signalLuna?.signal_id ?? null,
      entry_execution_price: entryExecutionPrice,
      exit_execution_price: exitExecutionPrice,
      source_reported_entry: reportedEntry,
      source_reported_exit: reportedExit
    },
    review: {
      schema_version: "lifecycle-review.v1.2",
      status,
      signal: {
        raw_message_id: Number(context.signalRow.id),
        channel_key: context.signalRow.channel_key,
        message_id: String(context.signalRow.telegram_message_id),
        published_at: signalEventAt,
        source_published_at: context.signalRow.published_at,
        contract: context.signalLuna?.contract ?? null,
        action: "buy_to_open"
      },
      exit: {
        raw_message_id: Number(exitRow.id),
        message_id: String(exitRow.telegram_message_id),
        published_at: exitEventAt,
        source_published_at: exitRow.published_at,
        action: "sell_to_close",
        hold_minutes: holdMinutes
      },
      entry_prediction: ocean,
      entry_prediction_status: entryPredictionStatus,
      prediction_check: {
        option_exposure: exposure,
        directional_alignment: alignment,
        supported_at_entry: alignment == null ? null : alignment > 0
      },
      execution_check: {
        status: exitCheckStatus,
        entry_ask: entryAsk ?? null,
        exit_bid: exitBid ?? null,
        entry_execution_price: entryExecutionPrice,
        exit_execution_price: exitExecutionPrice,
        entry_basis: reportedEntry?.basis ?? (entryAligned && entryAsk != null ? "point_in_time_ask" : null),
        exit_basis: reportedExit?.basis ?? (exitAligned && exitBid != null ? "point_in_time_bid" : null),
        source_reported_entry: reportedEntry,
        source_reported_exit: reportedExit,
        gross_executable_return: grossReturn,
        accepted_as_executable: usableEntryExecution && usableExitExecution,
        independently_verified: !reportedEntry && !reportedExit && entryAligned && exitAligned,
        source_convention_applied: Boolean(reportedEntry || reportedExit)
      },
      timing: {
        max_lag_seconds: maxLagSeconds,
        entry_lag_seconds: snapshotLagSeconds(entrySnapshot, signalEventAt),
        exit_lag_seconds: snapshotLagSeconds(exitSnapshot, exitEventAt),
        entry_aligned: entryAligned,
        exit_aligned: exitAligned
      },
      missing: [
        ...(!usablePrediction ? ["entry_point_in_time_ocean_wave_prediction"] : []),
        ...(!entryAligned ? ["entry_snapshot_not_time_aligned"] : []),
        ...(!usableEntryExecution ? ["entry_execution_price"] : []),
        ...(!usableExitExecution ? ["exit_execution_price"] : []),
        ...(!exitAligned && !reportedExit ? ["exit_snapshot_not_time_aligned"] : [])
      ],
      reply_chain: context.chain
    }
  };
}

export function reviewSellToClose(db, context, exitRow, exitSnapshot) {
  const built = buildLifecycleReview(db, context, exitRow, exitSnapshot);
  const stored = appendLifecycleReview(db, {
    signalRawMessageId: context.signalRow.id,
    exitRawMessageId: exitRow.id,
    reviewVersion: "lifecycle-review.v1.2",
    inputManifest: built.inputManifest,
    status: built.status,
    review: built.review
  });
  return { ...built, stored };
}

export function backfillLifecycleReviews(db) {
  const rows = db.prepare(`
    SELECT * FROM latest_raw_messages ORDER BY event_at,id
  `).all();
  const summary = { exits: 0, linked: 0, scored: 0, execution_only: 0, blocked: 0, unlinked: 0, appended: 0 };
  for (const row of rows) {
    const luna = getLatestStageOutput(db, row.id, "luna");
    if (luna?.lifecycle_action !== "sell_to_close") continue;
    summary.exits += 1;
    const context = resolveSignalContext(db, row, luna);
    if (!context) { summary.unlinked += 1; continue; }
    summary.linked += 1;
    const exitRecord = latestSnapshot(db, row.id);
    const built = buildLifecycleReview(db, context, row, exitRecord?.snapshot ?? { data_tier: "text_only", as_of: row.edited_at ?? row.published_at });
    if (built.status === "scored") summary.scored += 1;
    else if (built.status === "execution_only_source_reported") summary.execution_only += 1;
    else summary.blocked += 1;
    const result = appendLifecycleReview(db, {
      signalRawMessageId: context.signalRow.id,
      exitRawMessageId: row.id,
      reviewVersion: "lifecycle-review.v1.2",
      inputManifest: built.inputManifest,
      status: built.status,
      review: built.review
    });
    if (result.inserted) summary.appended += 1;
  }
  return summary;
}
