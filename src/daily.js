import { getRawMessage, lifecycleReviewSelection, listDailyInputs, listPendingRawMessages } from "./db.js";
import { resolveSignalContext } from "./lifecycle.js";
import { runOpenClawAgent } from "./openclaw.js";
import { solPrompt } from "./prompts.js";
import { localDateKey, utcRangeForLocalDate } from "./time.js";

const SOL_DECISIONS = new Set(["no_change", "collect_more_data", "backtest_candidate", "shadow_candidate"]);
const SOL_REQUIRED_KEYS = [
  "report_date", "coverage", "lifecycle_links", "style_profile", "performance_bias",
  "data_quality", "candidate_change", "evaluation_gate", "decision"
];

export function readyUnreportedDates(db, timeZone, throughDate) {
  const reported = new Set(db.prepare("SELECT DISTINCT report_date FROM daily_reports").all().map((row) => row.report_date));
  const pending = new Set(listPendingRawMessages(db, 100_000)
    .map((row) => localDateKey(row.edited_at ?? row.published_at, timeZone)));
  const dates = new Set(db.prepare(`
    SELECT event_at FROM latest_raw_messages
  `).all().map((row) => localDateKey(row.event_at, timeZone)));
  return [...dates]
    .filter((date) => date <= throughDate && !reported.has(date) && !pending.has(date))
    .sort();
}

export function scheduledDailyDates(db, timeZone, today) {
  return readyUnreportedDates(db, timeZone, today).filter((date) => date === today);
}

export function validateSolReport(output, reportDate) {
  if (output?.schema_version !== "sol.v1") return "Expected sol.v1 output.";
  if (output.report_date !== reportDate) return `Sol report_date must equal ${reportDate}.`;
  const missing = SOL_REQUIRED_KEYS.filter((key) => !Object.hasOwn(output, key));
  if (missing.length) return `Sol output is missing required keys: ${missing.join(", ")}.`;
  if (!SOL_DECISIONS.has(output.decision)) return "Sol returned an unsupported decision.";
  return true;
}

function ordered(rows) {
  return rows.sort((left, right) => left.published_at.localeCompare(right.published_at)
    || left.raw_message_id - right.raw_message_id
    || left.stage.localeCompare(right.stage));
}

function hasOptionLifecycleFields(luna) {
  const contract = luna?.contract ?? {};
  return Boolean(
    luna?.lifecycle_action
    || luna?.lifecycle?.action
    || contract.symbol
    || contract.strike != null
    || contract.option_type
  );
}

/**
 * Keep option-trade evidence and general market commentary in disjoint data
 * planes.  Only optionTradeRecords are ever passed to Sol's performance and
 * model-change review.  Secondary records remain archived for separate
 * contextual research and are represented in the manifest by IDs only.
 */
export function partitionDailyInputs(db, analysisRows, lifecycleRows, selection = null) {
  const lifecycleSelection = selection ?? lifecycleReviewSelection(db);
  const latestLunaByRaw = new Map();
  for (const row of analysisRows) {
    if (row.stage === "luna" && row.output) latestLunaByRaw.set(Number(row.raw_message_id), row.output);
  }
  const lifecycleRawIds = new Set();
  const lifecycleSignalIds = new Set();
  for (const row of lifecycleRows) {
    lifecycleRawIds.add(Number(row.raw_message_id));
    lifecycleRawIds.add(Number(row.signal_raw_message_id));
    lifecycleSignalIds.add(Number(row.signal_raw_message_id));
  }

  const optionRawIds = new Set(lifecycleRawIds);
  const supersededOptionRawIds = new Set(lifecycleSelection.supersededExitRawIds);
  for (const [rawMessageId, luna] of latestLunaByRaw) {
    if (supersededOptionRawIds.has(rawMessageId)) continue;
    if (luna?.classification === "options_signal") {
      optionRawIds.add(rawMessageId);
      continue;
    }
    if (!["update", "cancel", "outcome"].includes(luna?.classification)) continue;
    const rawRow = getRawMessage(db, rawMessageId);
    const linked = rawRow ? resolveSignalContext(db, rawRow, luna) : null;
    if (luna?.lifecycle_action === "sell_to_close" && linked
        && lifecycleSignalIds.has(Number(linked.signalRow.id))
        && !lifecycleRawIds.has(rawMessageId)) {
      supersededOptionRawIds.add(rawMessageId);
      continue;
    }
    if (linked || hasOptionLifecycleFields(luna)) optionRawIds.add(rawMessageId);
  }

  const optionTradeRecords = ordered([
    ...analysisRows
      .filter((row) => optionRawIds.has(Number(row.raw_message_id)))
      .map((row) => ({ ...row, data_role: "option_trade" })),
    ...lifecycleRows.map((row) => ({ ...row, data_role: "option_trade", outcome_role: "linked_lifecycle" }))
  ]);
  const secondaryMarketContext = ordered(analysisRows
    .filter((row) => !optionRawIds.has(Number(row.raw_message_id))
      && !supersededOptionRawIds.has(Number(row.raw_message_id)))
    .map((row) => ({ ...row, data_role: "secondary_market_context" })));
  return { optionTradeRecords, secondaryMarketContext, supersededOptionRawIds: [...supersededOptionRawIds] };
}

export async function buildDailyReport(config, db, reportDate) {
  const range = utcRangeForLocalDate(reportDate, config.timezone);
  const analysisRows = listDailyInputs(db, range.start, range.end).map((row) => ({
    raw_message_id: row.raw_message_id,
    channel_key: row.channel_key,
    published_at: row.published_at,
    raw_text: row.raw_text,
    stage: row.stage,
    schema_version: row.schema_version,
    output: row.output_json ? JSON.parse(row.output_json) : null
  }));
  const lifecycleSelection = lifecycleReviewSelection(db, { asOfExclusive: range.end });
  const lifecycleRows = lifecycleSelection.effectiveRows
    .filter((row) => row.published_at >= range.start && row.published_at < range.end)
    .map((row) => ({
      raw_message_id: Number(row.exit_raw_message_id),
      signal_raw_message_id: Number(row.signal_raw_message_id),
      channel_key: row.channel_key,
      published_at: row.published_at,
      raw_text: row.raw_text,
      stage: "lifecycle",
      schema_version: row.review_version,
      output: JSON.parse(row.review_json)
    }));
  const { optionTradeRecords, secondaryMarketContext, supersededOptionRawIds } = partitionDailyInputs(
    db,
    analysisRows,
    lifecycleRows,
    lifecycleSelection
  );
  const sessionKey = `daily-${reportDate.replaceAll("-", "")}`;
  const result = await runOpenClawAgent(
    config,
    "sol",
    solPrompt(reportDate, optionTradeRecords, config.channelSemantics),
    sessionKey,
    {
      validateOutput: (output) => validateSolReport(output, reportDate)
    }
  );
  if (result.output?.schema_version !== "sol.v1") throw new Error("Expected sol.v1 output.");
  if (result.output?.decision === "promote") throw new Error("Sol is not allowed to promote a model.");
  db.prepare(`
    INSERT INTO daily_reports(report_date,created_at,model,input_manifest_json,report_json)
    VALUES(?,?,?,?,?)
  `).run(
    reportDate,
    new Date().toISOString(),
    config.openclaw.agents.sol.model,
    JSON.stringify({
      timezone: config.timezone,
      utc_range: range,
      model_input_scope: "option_trade_records_only",
      option_trade_raw_message_ids: [...new Set(optionTradeRecords.map((row) => row.raw_message_id))],
      secondary_market_context_raw_message_ids: [...new Set(secondaryMarketContext.map((row) => row.raw_message_id))],
      superseded_option_exit_raw_message_ids: supersededOptionRawIds,
      secondary_context_policy: "archived_separately_not_passed_to_sol_or_model_optimization"
    }),
    JSON.stringify(result.output)
  );
  return result.output;
}
