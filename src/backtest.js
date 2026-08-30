import { lifecycleReviewSelection } from "./db.js";

const SIGNAL_CLASS = "options_signal";
const FOLLOW_UP_CLASSES = new Set(["update", "cancel", "outcome"]);

const FEATURE_FAMILIES = Object.freeze({
  contract: ["side", "option_type", "strike", "expiry", "dte", "moneyness", "position_size", "stop_loss", "directional_alignment", "spread_ratio", "theta_burn_ratio", "contract_score"],
  underlying: ["ohlcv", "vwap", "multi_horizon_returns", "realized_vol", "gap", "breadth", "sector_and_peer_returns"],
  option_market: ["executable_bid_ask", "spread", "volume", "open_interest", "oi_change", "trade_aggressor", "full_chain_liquidity"],
  volatility: ["iv", "iv_rank", "iv_percentile", "skew", "smile_curvature", "term_structure", "variance_risk_premium"],
  sensitivities: ["delta", "gamma", "theta", "vega", "rho", "vanna", "charm", "vomma", "dealer_gex"],
  regime: ["vix_complex", "rates_curve", "credit", "dollar", "commodities", "correlated_and_inverse_assets", "market_regime"],
  events_and_news: ["earnings", "guidance", "sec_filings", "macro_calendar", "analyst_actions", "sector_news", "headline_sentiment", "event_surprise", "time_since_event"],
  source_behavior: ["channel", "strategy_style", "entry_time", "latency", "add_or_reduce", "holding_language", "historical_calibration"],
  outcomes: ["executable_returns_5_15_30_60m", "eod", "expiry", "mfe", "mae", "slippage", "fees", "triple_barrier_label"]
});

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function latestSuccessfulStage(db, stage) {
  const rows = db.prepare(`
    SELECT a.id, a.raw_message_id, a.output_json
    FROM latest_successful_analysis_runs a
    WHERE a.stage=?
    ORDER BY a.id
  `).all(stage);
  return new Map(rows.map((row) => [Number(row.raw_message_id), parseJson(row.output_json)]));
}

function present(value) {
  return value !== null && value !== undefined && value !== "";
}

function directParentKey(row, luna) {
  const parent = row.reply_to_message_id ?? luna?.follow_up?.parent_message_id ?? luna?.source?.reply_to_message_id;
  return parent == null ? null : `${row.telegram_chat_id}:${String(parent)}`;
}

export function buildSignalLifecycles(db, effectiveSelection = null) {
  const lunaByRaw = latestSuccessfulStage(db, "luna");
  const rows = db.prepare(`
    SELECT r.id,r.channel_key,r.telegram_chat_id,r.telegram_message_id,
           r.event_at AS published_at,r.published_at AS source_published_at,r.reply_to_message_id
    FROM latest_raw_messages r
    ORDER BY r.event_at,r.id
  `).all();
  const rowBySource = new Map(rows.map((row) => [`${row.telegram_chat_id}:${row.telegram_message_id}`, row]));
  const signals = [];
  const signalBySource = new Map();
  const selection = effectiveSelection ?? lifecycleReviewSelection(db);
  const effectiveReviews = Array.isArray(selection) ? selection : selection.effectiveRows;
  const effectiveExitRawIds = new Set(effectiveReviews.map((row) => Number(row.exit_raw_message_id)));
  const reviewedExitRawIds = new Set(Array.isArray(selection)
    ? effectiveReviews.map((row) => Number(row.exit_raw_message_id))
    : selection.reviewedExitRawIds);

  for (const row of rows) {
    const luna = lunaByRaw.get(Number(row.id));
    if (luna?.classification !== SIGNAL_CLASS) continue;
    const contract = luna.contract ?? {};
    const sourceKey = `${row.telegram_chat_id}:${row.telegram_message_id}`;
    const signal = {
      signal_id: luna.signal_id ?? sourceKey,
      channel_key: row.channel_key,
      raw_message_id: Number(row.id),
      telegram_message_id: String(row.telegram_message_id),
      published_at: row.published_at,
      source_published_at: row.source_published_at,
      symbol: contract.symbol ?? null,
      expiry: contract.expiry ?? null,
      strike: contract.strike ?? null,
      option_type: contract.option_type ?? null,
      side: contract.side ?? null,
      size_value: contract.size?.value ?? null,
      size_unit: contract.size?.unit ?? null,
      stop_value: contract.stop_loss?.value ?? null,
      stop_unit: contract.stop_loss?.unit ?? null,
      parser_confidence: luna.confidence?.overall ?? null,
      follow_ups: [],
      self_reported_outcome_count: 0,
      independently_verified_outcome: false
    };
    signals.push(signal);
    signalBySource.set(sourceKey, signal);
  }

  for (const row of rows) {
    const luna = lunaByRaw.get(Number(row.id));
    if (!FOLLOW_UP_CLASSES.has(luna?.classification)) continue;
    if (luna?.classification === "outcome" && reviewedExitRawIds.has(Number(row.id))
        && !effectiveExitRawIds.has(Number(row.id))) continue;
    let parentKey = directParentKey(row, luna);
    const visited = new Set();
    while (parentKey && !visited.has(parentKey)) {
      visited.add(parentKey);
      const signal = signalBySource.get(parentKey);
      if (signal) {
        signal.follow_ups.push({
          classification: luna.classification,
          raw_message_id: Number(row.id),
          telegram_message_id: String(row.telegram_message_id),
          published_at: row.published_at,
          source_published_at: row.source_published_at,
          relation: luna.follow_up?.relation ?? null,
          verified: false
        });
        if (luna.classification === "outcome") signal.self_reported_outcome_count += 1;
        break;
      }
      const parentRow = rowBySource.get(parentKey);
      if (!parentRow) break;
      const parentLuna = lunaByRaw.get(Number(parentRow.id));
      parentKey = directParentKey(parentRow, parentLuna);
    }
  }

  const verifiedIds = new Set(db.prepare("SELECT DISTINCT signal_id FROM outcomes").all().map((row) => String(row.signal_id)));
  for (const signal of signals) signal.independently_verified_outcome = verifiedIds.has(String(signal.signal_id));
  return signals;
}

export function buildBacktestReadiness(db, expectedChannelKeys = []) {
  const lifecycleSelection = lifecycleReviewSelection(db);
  const effectiveLifecycleReviews = lifecycleSelection.effectiveRows;
  const signals = buildSignalLifecycles(db, lifecycleSelection);
  const scalar = (sql) => Number(db.prepare(sql).get().n);
  const channelRows = db.prepare(`
    SELECT r.channel_key,COUNT(*) AS n,MIN(r.event_at) AS first_at,MAX(r.event_at) AS last_at
    FROM latest_raw_messages r
    GROUP BY r.channel_key ORDER BY r.channel_key
  `).all();
  const tiers = db.prepare(`
    SELECT ms.provider,ms.data_tier,COUNT(*) AS n
    FROM market_snapshots ms
    JOIN latest_raw_messages r ON r.id=ms.raw_message_id
    WHERE ms.id=(SELECT MAX(candidate.id) FROM market_snapshots candidate WHERE candidate.raw_message_id=r.id)
    GROUP BY ms.provider,ms.data_tier ORDER BY ms.provider,ms.data_tier
  `).all();
  const pointInTimeSnapshots = scalar(`
    SELECT COUNT(*) AS n
    FROM latest_raw_messages r
    JOIN latest_successful_analysis_runs a ON a.raw_message_id=r.id AND a.stage='luna'
    WHERE json_extract(a.output_json,'$.classification')='options_signal'
      AND EXISTS (
        SELECT 1 FROM market_snapshots ms
        WHERE ms.raw_message_id=r.id
          AND ms.data_tier <> 'text_only'
          AND ABS((julianday(COALESCE(
            json_extract(ms.snapshot_json,'$.target_contract.matched.quote_timestamp'),
            json_extract(ms.snapshot_json,'$.observed_at'),
            json_extract(ms.snapshot_json,'$.captured_at'),
            ms.captured_at,
            ms.as_of
          )) - julianday(r.event_at)) * 86400.0) <= 300
      )
  `);
  const verifiedOutcomes = signals.filter((s) => s.independently_verified_outcome).length;
  const completeContract = signals.filter((s) => [s.symbol, s.expiry, s.strike, s.option_type].every(present)).length;
  const explicitSide = signals.filter((s) => present(s.side)).length;
  const selfReported = signals.filter((s) => s.self_reported_outcome_count > 0).length;
  const mediaAssets = scalar(`
    SELECT COUNT(*) AS n FROM media_assets m
    JOIN latest_raw_messages r ON r.id=m.raw_message_id
  `);
  const mediaVisionOk = scalar(`
    SELECT COUNT(DISTINCT m.id) AS n FROM media_assets m
    JOIN latest_raw_messages r ON r.id=m.raw_message_id
    WHERE EXISTS (SELECT 1 FROM media_analyses a WHERE a.media_asset_id=m.id AND a.status='ok')
  `);
  const lifecycleExits = signals.reduce((count, signal) => count
    + signal.follow_ups.filter((followUp) => followUp.classification === "outcome").length, 0);
  const lifecycleLinked = effectiveLifecycleReviews.length;
  const lifecycleScored = effectiveLifecycleReviews.filter((row) => row.status === "scored").length;
  const observedChannels = new Set(channelRows.map((row) => row.channel_key));
  const missingChannels = expectedChannelKeys.filter((key) => !observedChannels.has(key));
  const blockers = [];
  if (missingChannels.length) blockers.push({ code: "channel_backfill_incomplete", detail: `No stored messages yet for: ${missingChannels.join(", ")}` });
  if (signals.length === 0) blockers.push({ code: "no_signals", detail: "No options signals have been parsed." });
  if (pointInTimeSnapshots === 0) blockers.push({ code: "no_point_in_time_market_data", detail: "Historical quotes/Greeks/news were not captured as-of the signal timestamps." });
  if (verifiedOutcomes === 0) blockers.push({ code: "no_independently_verified_outcomes", detail: "Channel-reported exits are not executable-price outcome labels." });
  if (explicitSide < signals.length) blockers.push({ code: "missing_trade_side", detail: "At least one signal omits buy/sell; option type alone does not establish the trade side." });
  if (mediaAssets > mediaVisionOk) blockers.push({ code: "media_vision_incomplete", detail: "At least one stored Telegram image has not completed vision extraction." });

  return {
    schema_version: "backtest-readiness.v1",
    generated_at: new Date().toISOString(),
    counts: {
      raw_messages: scalar("SELECT COUNT(*) AS n FROM latest_raw_messages"),
      raw_message_versions: scalar("SELECT COUNT(*) AS n FROM raw_messages"),
      canonical_messages: scalar("SELECT COUNT(*) AS n FROM latest_raw_messages"),
      luna_runs: scalar("SELECT COUNT(*) AS n FROM latest_successful_analysis_runs WHERE stage='luna'"),
      terra_runs: scalar("SELECT COUNT(*) AS n FROM latest_successful_analysis_runs WHERE stage='terra'"),
      signals: signals.length,
      complete_contracts: completeContract,
      explicit_side: explicitSide,
      self_reported_outcomes: selfReported,
      point_in_time_snapshots: pointInTimeSnapshots,
      independently_verified_outcomes: verifiedOutcomes,
      media_assets: mediaAssets,
      media_vision_ok: mediaVisionOk,
      lifecycle_exits: lifecycleExits,
      lifecycle_linked: lifecycleLinked,
      lifecycle_scored: lifecycleScored
    },
    channels: channelRows,
    snapshot_tiers: tiers,
    blockers,
    training_allowed: blockers.length === 0,
    feature_families: FEATURE_FAMILIES
  };
}

export function executableOptionPnl({ side, entryBid, entryAsk, exitBid, exitAsk, contracts = 1, fees = 0 }) {
  const numbers = [entryBid, entryAsk, exitBid, exitAsk, contracts, fees].map(Number);
  if (!numbers.every(Number.isFinite) || numbers.slice(0, 4).some((n) => n < 0) || contracts <= 0 || fees < 0) {
    throw new TypeError("Executable P&L requires non-negative finite bid/ask values, positive contracts, and non-negative fees.");
  }
  if (entryBid > entryAsk || exitBid > exitAsk) throw new RangeError("Bid cannot exceed ask.");
  const multiplier = 100 * contracts;
  if (side === "buy") {
    const gross = (exitBid - entryAsk) * multiplier;
    return { entry_fill: entryAsk, exit_fill: exitBid, gross_pnl: gross, net_pnl: gross - fees };
  }
  if (side === "sell") {
    const gross = (entryBid - exitAsk) * multiplier;
    return { entry_fill: entryBid, exit_fill: exitAsk, gross_pnl: gross, net_pnl: gross - fees };
  }
  throw new TypeError("side must be buy or sell");
}

export function promotionGate(metrics, thresholds = {}) {
  const t = {
    independentGroups: thresholds.independentGroups ?? 300,
    outOfSampleMonths: thresholds.outOfSampleMonths ?? 6,
    shadowDays: thresholds.shadowDays ?? 30,
    shadowSignals: thresholds.shadowSignals ?? 100,
    ece: thresholds.ece ?? 0.05,
    calibrationSlopeMin: thresholds.calibrationSlopeMin ?? 0.8,
    calibrationSlopeMax: thresholds.calibrationSlopeMax ?? 1.2,
    calibrationInterceptAbs: thresholds.calibrationInterceptAbs ?? 0.1
  };
  const checks = {
    independent_groups: Number(metrics.independentGroups) >= t.independentGroups,
    oos_months: Number(metrics.outOfSampleMonths) >= t.outOfSampleMonths,
    brier_improvement_ci: Number(metrics.brierImprovementCiLow) > 0,
    logloss_improvement_ci: Number(metrics.loglossImprovementCiLow) > 0,
    calibrated_slope: Number(metrics.calibrationSlope) >= t.calibrationSlopeMin && Number(metrics.calibrationSlope) <= t.calibrationSlopeMax,
    calibrated_intercept: Math.abs(Number(metrics.calibrationIntercept)) <= t.calibrationInterceptAbs,
    ece: Number(metrics.ece) <= t.ece,
    net_ev_ci: Number(metrics.netEvCiLow) > 0,
    double_slippage_nonnegative: Number(metrics.doubleSlippageNetEv) >= 0,
    shadow_run: Number(metrics.shadowDays) >= t.shadowDays && Number(metrics.shadowSignals) >= t.shadowSignals
  };
  return { pass: Object.values(checks).every(Boolean), checks, thresholds: t };
}
