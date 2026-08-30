import { getSchwabAccessToken } from "./schwab-oauth.js";

const PRICE_HISTORY_URL = "https://api.schwabapi.com/marketdata/v1/pricehistory";
const MINUTE_MS = 60_000;
const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;

function finite(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function easternParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function sessionCoordinates(value) {
  const parts = easternParts(value);
  return {
    dateKey: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    minute: parts.hour * 60 + parts.minute + parts.second / 60
  };
}

function regularMinuteCandle(candle) {
  const datetime = finite(candle?.datetime);
  const close = finite(candle?.close);
  const volume = finite(candle?.volume);
  if (datetime == null || !(close > 0) || volume == null || volume < 0) return null;
  const session = sessionCoordinates(datetime);
  if (session.minute < REGULAR_OPEN_MINUTE || session.minute >= REGULAR_CLOSE_MINUTE) return null;
  return {
    datetime,
    open: finite(candle.open),
    high: finite(candle.high),
    low: finite(candle.low),
    close,
    volume,
    dateKey: session.dateKey,
    sessionMinute: Math.floor(session.minute - REGULAR_OPEN_MINUTE)
  };
}

function sampleVariance(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/**
 * Build market-state inputs using only regular-session one-minute candles that
 * had completed by targetAt. Prior sessions are used solely as the RVOL
 * baseline, so no post-signal candle from the current session can leak in.
 */
export function deriveCausalIntradayFeatures(candles, targetAt, options = {}) {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) throw new Error(`Invalid target time: ${targetAt}`);
  const target = sessionCoordinates(targetMs);
  const marketPhase = target.minute < REGULAR_OPEN_MINUTE ? "premarket"
    : target.minute < REGULAR_CLOSE_MINUTE ? "regular"
      : "after_hours";
  const minutesFromOpen = marketPhase === "regular"
    ? Math.round((target.minute - REGULAR_OPEN_MINUTE) * 1_000_000) / 1_000_000
    : null;
  const completed = (candles ?? [])
    .map(regularMinuteCandle)
    .filter(Boolean)
    .filter((candle) => candle.datetime + MINUTE_MS <= targetMs)
    .sort((left, right) => left.datetime - right.datetime);
  const current = completed.filter((candle) => candle.dateKey === target.dateKey);
  const latest = current.at(-1) ?? null;
  const features = marketPhase === "regular" ? {
    minutes_from_open: minutesFromOpen,
    minutes_to_close_total: Math.round(Math.max(0, 390 - minutesFromOpen) * 1_000_000) / 1_000_000
  } : {};
  const missing = [];

  if (latest) {
    const weighted = current.reduce((state, candle) => {
      const typical = [candle.high, candle.low, candle.close].every((value) => value != null)
        ? (candle.high + candle.low + candle.close) / 3
        : candle.close;
      state.value += typical * candle.volume;
      state.volume += candle.volume;
      return state;
    }, { value: 0, volume: 0 });
    if (weighted.volume > 0) features.vwap = weighted.value / weighted.volume;
    else missing.push("vwap");

    const closeAtOrBefore = (wantedMs) => [...current].reverse()
      .find((candle) => candle.datetime <= wantedMs)?.close ?? null;
    const prior5 = closeAtOrBefore(latest.datetime - 5 * MINUTE_MS);
    const prior15 = closeAtOrBefore(latest.datetime - 15 * MINUTE_MS);
    if (prior5 > 0) features.return_5m = latest.close / prior5 - 1;
    else missing.push("return_5m");
    if (prior15 > 0) features.return_15m = latest.close / prior15 - 1;
    else missing.push("return_15m");

    const returns = [];
    for (let index = 1; index < current.length; index += 1) {
      if (current[index - 1].close > 0 && current[index].close > 0) {
        returns.push(Math.log(current[index].close / current[index - 1].close));
      }
    }
    const recentReturns = returns.slice(-Number(options.realizedVolWindowMinutes ?? 30));
    const variance = sampleVariance(recentReturns);
    if (recentReturns.length >= Number(options.minimumRealizedVolReturns ?? 5) && variance != null) {
      features.realized_vol = Math.sqrt(Math.max(0, variance) * 252 * 390);
    } else {
      missing.push("realized_vol");
    }

    const sessions = new Map();
    for (const candle of completed) {
      if (candle.dateKey === target.dateKey || candle.sessionMinute > latest.sessionMinute) continue;
      const rows = sessions.get(candle.dateKey) ?? [];
      rows.push(candle);
      sessions.set(candle.dateKey, rows);
    }
    const minimumBaselineSessions = Number(options.minimumRvolSessions ?? 3);
    const maximumBaselineSessions = Number(options.maximumRvolSessions ?? 10);
    const minimumComparableCandles = Math.max(1, Math.floor(current.length * 0.8));
    const comparableVolumes = [...sessions.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([, rows]) => rows)
      .filter((rows) => rows.length >= minimumComparableCandles)
      .map((rows) => rows.reduce((sum, candle) => sum + candle.volume, 0))
      .filter((volume) => volume > 0)
      .slice(0, maximumBaselineSessions);
    const currentVolume = current.reduce((sum, candle) => sum + candle.volume, 0);
    if (currentVolume > 0 && comparableVolumes.length >= minimumBaselineSessions) {
      const baseline = comparableVolumes.reduce((sum, volume) => sum + volume, 0) / comparableVolumes.length;
      if (baseline > 0) features.rvol = currentVolume / baseline;
    }
    if (features.rvol == null) missing.push("rvol");

    return {
      features,
      provenance: {
        schema_version: "causal-intraday-features.v1",
        source: "schwab_price_history_1m",
        market_phase: marketPhase,
        target_at: new Date(targetMs).toISOString(),
        latest_completed_candle_end_at: new Date(latest.datetime + MINUTE_MS).toISOString(),
        causal_cutoff_policy: "regular-session candles with candle_end <= signal timestamp",
        vwap_method: "volume-weighted typical price from completed 1m OHLCV",
        realized_vol_method: "sample variance of up to 30 completed 1m log returns, annualized over 252x390 minutes",
        rvol_method: "completed-session volume divided by comparable-minute mean of prior complete-enough sessions",
        current_session_candles: current.length,
        rvol_baseline_sessions: comparableVolumes.length,
        missing_fields: [...new Set(missing)]
      }
    };
  }

  return {
    features,
    provenance: {
      schema_version: "causal-intraday-features.v1",
      source: "schwab_price_history_1m",
      market_phase: marketPhase,
      target_at: new Date(targetMs).toISOString(),
      latest_completed_candle_end_at: null,
      causal_cutoff_policy: "regular-session candles with candle_end <= signal timestamp",
      current_session_candles: 0,
      rvol_baseline_sessions: 0,
      missing_fields: ["vwap", "rvol", "realized_vol", "return_5m", "return_15m"]
    }
  };
}

export async function fetchSchwabIntradayFeatures(root, symbol, targetAt, dependencies = {}) {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) throw new Error(`Invalid target time: ${targetAt}`);
  const token = dependencies.accessToken
    ?? await (dependencies.getAccessToken ?? getSchwabAccessToken)(root);
  const url = new URL(PRICE_HISTORY_URL);
  const historyDays = Math.max(7, Number(dependencies.historyDays ?? 14));
  for (const [key, value] of Object.entries({
    symbol: String(symbol).trim().toUpperCase(),
    periodType: "day",
    frequencyType: "minute",
    frequency: "1",
    startDate: String(targetMs - historyDays * 86400_000),
    endDate: String(targetMs),
    needExtendedHoursData: "false",
    needPreviousClose: "true"
  })) url.searchParams.set(key, value);
  const response = await (dependencies.fetch ?? fetch)(url, {
    signal: dependencies.signal,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Schwab intraday price history failed (${response.status})`);
  return deriveCausalIntradayFeatures(payload.candles, targetAt, dependencies);
}

export function selectMinuteCandle(candles, targetAt) {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) throw new Error(`Invalid target time: ${targetAt}`);
  const valid = (candles ?? []).filter((candle) => Number.isFinite(Number(candle?.datetime))
    && Number.isFinite(Number(candle?.close)) && Number(candle.close) > 0);
  const containing = valid.find((candle) => Number(candle.datetime) <= targetMs
    && targetMs < Number(candle.datetime) + 60_000);
  if (containing) return containing;
  const nearest = valid
    .map((candle) => ({ candle, distance: Math.abs(Number(candle.datetime) + 60_000 - targetMs) }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (!nearest || nearest.distance > 120_000) return null;
  return nearest.candle;
}

export async function fetchSchwabMinuteClose(root, symbol, targetAt, dependencies = {}) {
  const token = await (dependencies.getAccessToken ?? getSchwabAccessToken)(root);
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) throw new Error(`Invalid target time: ${targetAt}`);
  const url = new URL(PRICE_HISTORY_URL);
  for (const [key, value] of Object.entries({
    symbol: String(symbol).trim().toUpperCase(),
    periodType: "day",
    period: "1",
    frequencyType: "minute",
    frequency: "1",
    startDate: String(targetMs - 120_000),
    endDate: String(targetMs + 120_000),
    needExtendedHoursData: "false",
    needPreviousClose: "true"
  })) url.searchParams.set(key, value);
  const response = await (dependencies.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Schwab price history failed (${response.status})`);
  const candle = selectMinuteCandle(payload.candles, targetAt);
  if (!candle) throw new Error(`Schwab returned no minute candle near ${targetAt}`);
  return {
    provider: "schwab",
    data_tier: "historical_1m",
    symbol: String(symbol).trim().toUpperCase(),
    price: Number(candle.close),
    observed_at: new Date(Number(candle.datetime) + 60_000).toISOString(),
    candle: {
      start_at: new Date(Number(candle.datetime)).toISOString(),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume)
    },
    selection_policy: "close of the one-minute candle containing due_at"
  };
}
