import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./atomic-file.js";
import {
  appendIntradayEvent,
  checkpointAndCloseDatabase,
  getOperationalState,
  listIntradayEvents,
  openDatabase,
  setOperationalState
} from "./db.js";
import { IntradayResearchOrchestrator, BoundedTaskQueue } from "./intraday-research.js";
import { JsonLineWorker } from "./json-line-worker.js";
import { startKeepAwake } from "./keep-awake.js";
import { captureMarketSnapshot } from "./market-data.js";
import { runOpenClawAgent } from "./openclaw.js";
import { intradaySolPrompt } from "./prompts.js";
import { fetchEquityMarketHours } from "./schwab-market-hours.js";
import { fetchSchwabMinuteClose } from "./schwab-history.js";
import { getSchwabAccessToken, isSchwabReauthorizationError } from "./schwab-oauth.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_WORKER_SCRIPT = path.resolve(MODULE_DIR, "../scripts/intraday-channel-worker.js");
const CONTROL_FILES = Object.freeze({
  state: "intraday-runtime.json",
  request: "intraday-stop-request.json",
  owner: "intraday-owner.lock",
  watchdog: "intraday-watchdog.json"
});
const MINUTE_MS = 60_000;
const CRITICAL_INTRADAY_MARKET_FIELDS = Object.freeze([
  "vwap",
  "rvol",
  "return_5m",
  "return_15m",
  "realized_vol",
  "minutes_from_open"
]);

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 10) {
  return Number(Number(value).toFixed(digits));
}

function safeError(error) {
  const message = String(error?.message ?? error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_\s-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
  return {
    name: String(error?.name ?? "Error"),
    message,
    ...(error?.code ? { code: String(error.code) } : {})
  };
}

function quoteTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function quotePrice(quote) {
  const bid = finite(quote?.bidPrice ?? quote?.bid);
  const ask = finite(quote?.askPrice ?? quote?.ask);
  if (bid != null && ask != null && bid > 0 && ask >= bid) return (bid + ask) / 2;
  for (const value of [quote?.mark, quote?.lastPrice, quote?.last, quote?.closePrice]) {
    const number = finite(value);
    if (number != null && number > 0) return number;
  }
  return null;
}

function normalizeSchwabBatch(payload, symbols, capturedAt, {
  maximumQuoteAgeSeconds,
  maximumQuoteSkewMilliseconds
}) {
  const capturedMs = Date.parse(capturedAt);
  const maximumFutureAgeSeconds = Math.max(0, Number(maximumQuoteSkewMilliseconds) || 0) / 1_000;
  const quotes = {};
  const observedTimes = [];
  for (const symbol of symbols) {
    const item = payload?.[symbol] ?? payload?.[symbol.toUpperCase()];
    const quote = item?.quote ?? item?.regular ?? item;
    const observedAt = quoteTimestamp(quote?.quoteTime ?? quote?.tradeTime ?? item?.regular?.regularMarketTradeTime);
    const price = quotePrice(quote);
    if (!observedAt || !(price > 0)) throw new Error(`Schwab batch quote is incomplete for ${symbol}`);
    const observedMs = Date.parse(observedAt);
    const ageSeconds = (capturedMs - observedMs) / 1_000;
    if (!Number.isFinite(ageSeconds)
      || ageSeconds < -maximumFutureAgeSeconds
      || ageSeconds > maximumQuoteAgeSeconds) {
      throw new Error(`Schwab ${symbol} quote age ${round(ageSeconds, 3)}s is outside the live-data limit`);
    }
    observedTimes.push(observedMs);
    const bid = finite(quote?.bidPrice ?? quote?.bid);
    const ask = finite(quote?.askPrice ?? quote?.ask);
    const totalVolume = finite(quote?.totalVolume ?? quote?.volume);
    quotes[symbol] = {
      price: round(price, 6),
      bid,
      ask,
      volume: totalVolume,
      observedAt,
      provider: "schwab",
      sourceRole: "primary",
      dataTier: "realtime_underlying",
      crossValidation: { status: "pending", provider: "fidelity_web", blocking: false },
      features: {
        open: finite(quote?.openPrice),
        high: finite(quote?.highPrice),
        low: finite(quote?.lowPrice),
        previous_close: finite(quote?.closePrice ?? item?.reference?.previousClose),
        total_volume: totalVolume,
        volume_semantics: "cumulative_session",
        stock_dollar_volume: totalVolume == null ? null : round(totalVolume * price, 2),
        quote_age_seconds: round(ageSeconds, 3),
        data_confidence: round(clamp(1 - Math.max(0, ageSeconds) / Math.max(1, maximumQuoteAgeSeconds), 0, 1), 6)
      }
    };
  }
  const skewMs = Math.max(...observedTimes) - Math.min(...observedTimes);
  if (skewMs > maximumQuoteSkewMilliseconds) {
    throw new Error(`Schwab QQQ/SPY quote skew ${skewMs}ms exceeds ${maximumQuoteSkewMilliseconds}ms`);
  }
  return { quotes, skewMs };
}

function schwabRegimeContext(payload, coreQuotes, contextSymbols, capturedAt, {
  maximumQuoteAgeSeconds,
  maximumQuoteSkewMilliseconds
}) {
  const maximumFutureAgeSeconds = Math.max(0, Number(maximumQuoteSkewMilliseconds) || 0) / 1_000;
  const returns = {};
  const missing = [];
  for (const symbol of contextSymbols) {
    const item = payload?.[symbol];
    const quote = item?.quote ?? item?.regular ?? item;
    const observedAt = quoteTimestamp(quote?.quoteTime ?? quote?.tradeTime ?? item?.regular?.regularMarketTradeTime);
    const price = quotePrice(quote);
    const previousClose = finite(quote?.closePrice ?? item?.reference?.previousClose);
    const age = observedAt ? (Date.parse(capturedAt) - Date.parse(observedAt)) / 1_000 : Infinity;
    if (!(price > 0)
      || !(previousClose > 0)
      || age < -maximumFutureAgeSeconds
      || age > maximumQuoteAgeSeconds) {
      missing.push(symbol);
      continue;
    }
    returns[symbol] = price / previousClose - 1;
  }
  for (const [symbol, quote] of Object.entries(coreQuotes)) {
    const previousClose = finite(quote.features?.previous_close);
    if (previousClose > 0) returns[symbol] = quote.price / previousClose - 1;
  }
  const average = (symbols) => {
    const values = symbols.map((symbol) => returns[symbol]).filter(Number.isFinite);
    return values.length === symbols.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const expected = contextSymbols.length;
  const qqqMinusSpy = Number.isFinite(returns.QQQ) && Number.isFinite(returns.SPY)
    ? returns.QQQ - returns.SPY : null;
  const riskOnIwmDia = average(["IWM", "DIA"]);
  const stressComponents = {
    qqq_spy_dispersion: qqqMinusSpy == null ? null : Math.abs(qqqMinusSpy) / 0.005,
    rates_proxy_move: Number.isFinite(returns.TLT) ? Math.abs(returns.TLT) / 0.005 : null,
    real_asset_move: Number.isFinite(returns.GLD) ? Math.abs(returns.GLD) / 0.015 : null,
    small_industrial_move: riskOnIwmDia == null ? null : Math.abs(riskOnIwmDia) / 0.01
  };
  const stressValues = Object.values(stressComponents).filter(Number.isFinite);
  const crossAssetStress = stressValues.length
    ? clamp(Math.max(...stressValues), 0, 3) / 3 : null;
  return {
    schemaVersion: "intraday-regime-context.v1",
    researchOnly: true,
    independentSignalsAllowed: false,
    returns: Object.fromEntries(Object.entries(returns).map(([symbol, value]) => [symbol, round(value)])),
    qqqMinusSpy: qqqMinusSpy == null ? null : round(qqqMinusSpy),
    riskOnIwmDia,
    ratesProxyTlt: Number.isFinite(returns.TLT) ? round(returns.TLT) : null,
    defensiveRealAssetGld: Number.isFinite(returns.GLD) ? round(returns.GLD) : null,
    crossAssetStress: {
      score: crossAssetStress == null ? null : round(crossAssetStress, 6),
      level: crossAssetStress == null ? "unavailable" : crossAssetStress >= 2 / 3 ? "high"
        : crossAssetStress >= 1 / 3 ? "elevated" : "normal",
      components: Object.fromEntries(Object.entries(stressComponents)
        .map(([key, value]) => [key, value == null ? null : round(value, 6)])),
      semantics: "bounded_cross_asset_dislocation_proxy_not_event_calendar",
      productionDirectionChanged: false
    },
    quality: {
      status: missing.length === 0 ? "complete" : missing.length === expected ? "unavailable" : "partial",
      missingSymbols: missing,
      confidence: expected === 0 ? 0 : round((expected - missing.length) / expected, 6)
    }
  };
}

function fidelityPoint(snapshot, symbol, asOf, maximumQuoteAgeSeconds) {
  const price = finite(snapshot?.market_state?.underlying_price ?? snapshot?.market_state?.spot);
  const observedAt = snapshot?.observed_at ?? snapshot?.as_of ?? snapshot?.captured_at;
  if (!(price > 0) || !Number.isFinite(Date.parse(observedAt ?? ""))) {
    throw new Error(`Fidelity fallback quote is incomplete for ${symbol}`);
  }
  const lagSeconds = Math.abs(Date.parse(asOf) - Date.parse(observedAt)) / 1_000;
  if (!Number.isFinite(lagSeconds) || lagSeconds > maximumQuoteAgeSeconds || snapshot?.time_alignment?.aligned === false) {
    throw new Error(`Fidelity fallback quote is stale for ${symbol}`);
  }
  return {
    price,
    observedAt: new Date(observedAt).toISOString(),
    provider: "fidelity_web",
    sourceRole: "fallback",
    dataTier: "realtime_underlying"
  };
}

function compareCrossValidation(primaryQuotes, fidelityQuotes, {
  maximumDifferenceBps = 25,
  maximumTimeSkewSeconds = 15
} = {}) {
  const checks = {};
  for (const [symbol, primary] of Object.entries(primaryQuotes)) {
    const secondary = fidelityQuotes?.[symbol];
    if (!secondary) {
      checks[symbol] = { status: "unavailable", provider: "fidelity_web", blocking: false };
      continue;
    }
    const timeSkewSeconds = Math.abs(Date.parse(primary.observedAt) - Date.parse(secondary.observedAt)) / 1_000;
    const differenceBps = Math.abs(primary.price - secondary.price) / primary.price * 10_000;
    const status = timeSkewSeconds > maximumTimeSkewSeconds ? "stale"
      : differenceBps > maximumDifferenceBps ? "warning" : "pass";
    checks[symbol] = {
      status,
      provider: "fidelity_web",
      blocking: false,
      primaryPrice: primary.price,
      secondaryPrice: secondary.price,
      differenceBps: round(differenceBps, 4),
      timeSkewSeconds: round(timeSkewSeconds, 3)
    };
  }
  return checks;
}

export function createSchwabBatchSampler(config, {
  getAccessToken = getSchwabAccessToken,
  fetchImpl = fetch,
  fidelityQuote = null,
  fetchHistory = fetchSchwabMinuteClose,
  now = () => new Date(),
  onCrossValidation = async () => {}
} = {}) {
  const settings = config.intradayResearch ?? {};
  const market = config.marketData ?? {};
  const maximumQuoteAgeSeconds = Number(settings.maximumQuoteAgeSeconds ?? 15);
  const maximumQuoteSkewMilliseconds = Number(settings.maximumQuoteSkewMilliseconds ?? 3_000);
  const crossCheckFidelity = (market.crossCheck ?? []).includes("fidelity_web");
  const fallbackFidelity = (market.fallback ?? []).includes("fidelity_web");
  const pendingCrossChecks = new Set();
  const defaultFidelityQuote = async (symbol, asOf) => captureMarketSnapshot({
    ...config,
    marketData: { ...market, primary: "fidelity_web", crossCheck: [], fallback: [] }
  }, {
    classification: "market_forecast",
    human_interpretation_context_only: true,
    contract: { symbol }
  }, asOf);
  const resolveFidelity = fidelityQuote ?? defaultFidelityQuote;

  async function fidelityBatch(symbols, asOf) {
    const settled = await Promise.allSettled(symbols.map((symbol) => resolveFidelity(symbol, asOf)));
    const quotes = {};
    const errors = {};
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index];
      if (settled[index].status === "fulfilled") {
        try { quotes[symbol] = fidelityPoint(settled[index].value, symbol, asOf, maximumQuoteAgeSeconds); }
        catch (error) { errors[symbol] = safeError(error); }
      } else {
        errors[symbol] = safeError(settled[index].reason);
      }
    }
    return { quotes, errors };
  }

  return {
    async sample({ symbols, asOf, session, historical = false }) {
      const requestedSymbols = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase()))];
      const contextSymbols = [...new Set((settings.contextSymbols ?? ["IWM", "DIA", "TLT", "GLD"])
        .map((symbol) => String(symbol).toUpperCase())
        .filter((symbol) => !requestedSymbols.includes(symbol)))];
      const batchSymbols = [...requestedSymbols, ...contextSymbols];
      const capturedAt = iso(now());
      if (historical) {
        const targetAt = new Date(Date.parse(asOf) - 1).toISOString();
        const candles = await Promise.all(requestedSymbols.map((symbol) => fetchHistory(config.__root, symbol, targetAt, {
          getAccessToken,
          fetch: fetchImpl
        })));
        return {
          schemaVersion: "intraday-market-sample.v1",
          observedAt: asOf,
          provider: "schwab",
          sourceRole: "historical_recovery",
          dataTier: "historical_1m",
          crossValidation: { status: "not_applicable_historical", blocking: false },
          quotes: Object.fromEntries(candles.map((candle) => [candle.symbol, {
            price: candle.price,
            bid: null,
            ask: null,
            volume: candle.candle.volume,
            observedAt: candle.observed_at,
            provider: "schwab",
            sourceRole: "historical_recovery",
            dataTier: "historical_1m",
            crossValidation: { status: "not_applicable_historical", blocking: false },
            features: {
              high: candle.candle.high,
              low: candle.candle.low,
              total_volume: candle.candle.volume,
              minute_volume: candle.candle.volume,
              volume_semantics: "per_minute",
              minutes_from_open: Math.max(0, (Date.parse(asOf) - Date.parse(session.openAt)) / MINUTE_MS),
              minutes_to_close_total: Math.max(0, (Date.parse(session.closeAt) - Date.parse(asOf)) / MINUTE_MS),
              data_confidence: 1,
              regime_context: {
                schemaVersion: "intraday-regime-context.v1",
                quality: { status: "unavailable_historical_recovery", missingSymbols: contextSymbols, confidence: 0 },
                independentSignalsAllowed: false
              }
            }
          }]))
        };
      }
      let primary;
      try {
        const token = await getAccessToken(config.__root);
        const url = new URL("https://api.schwabapi.com/marketdata/v1/quotes");
        url.searchParams.set("symbols", batchSymbols.join(","));
        url.searchParams.set("indicative", "false");
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Schwab batch quotes failed (${response.status})`);
        primary = normalizeSchwabBatch(payload, requestedSymbols, capturedAt, {
          maximumQuoteAgeSeconds,
          maximumQuoteSkewMilliseconds
        });
        const regimeContext = schwabRegimeContext(payload, primary.quotes, contextSymbols, capturedAt, {
          maximumQuoteAgeSeconds,
          maximumQuoteSkewMilliseconds
        });
        for (const quote of Object.values(primary.quotes)) quote.features.regime_context = regimeContext;
      } catch (error) {
        if (!fallbackFidelity) throw error;
        const fallback = await fidelityBatch(requestedSymbols, asOf);
        if (!requestedSymbols.every((symbol) => fallback.quotes[symbol])) {
          const failure = new Error("Schwab primary failed and Fidelity did not provide a complete QQQ/SPY fallback batch");
          failure.cause = error;
          throw failure;
        }
        return {
          schemaVersion: "intraday-market-sample.v1",
          observedAt: capturedAt,
          provider: "fidelity_web",
          sourceRole: "fallback",
          dataTier: "realtime_underlying",
          crossValidation: { status: "primary_unavailable", primaryError: safeError(error) },
          quotes: Object.fromEntries(requestedSymbols.map((symbol) => [symbol, {
            ...fallback.quotes[symbol],
            crossValidation: { status: "primary_unavailable", blocking: false },
            features: {
              data_confidence: 0.5,
              regime_context: {
                schemaVersion: "intraday-regime-context.v1",
                researchOnly: true,
                independentSignalsAllowed: false,
                quality: { status: "unavailable", missingSymbols: contextSymbols, confidence: 0 }
              },
              minutes_from_open: Math.max(0, (Date.parse(asOf) - Date.parse(session.openAt)) / MINUTE_MS),
              minutes_to_close_total: Math.max(0, (Date.parse(session.closeAt) - Date.parse(asOf)) / MINUTE_MS)
            }
          }]))
        };
      }

      const slot = Math.floor((Date.parse(asOf) - Date.parse(session.openAt)) / MINUTE_MS);
      const forecastOrigin = Date.parse(asOf) >= Date.parse(session.openAt)
        && Date.parse(asOf) < Date.parse(session.closeAt)
        && slot >= 0 && slot % Number(settings.forecastIntervalMinutes ?? 30) === 0;
      const fidelityFlight = crossCheckFidelity && forecastOrigin
        ? fidelityBatch(requestedSymbols, asOf)
        : null;
      if (fidelityFlight && crossCheckFidelity) {
        const graceMilliseconds = Number(market.crossCheckWaitMilliseconds ?? 1_000);
        let timer;
        const grace = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, graceMilliseconds));
          timer.unref?.();
        });
        const bounded = Promise.race([fidelityFlight.then((fallback) => ({ fallback })), grace]);
        // The underlying browser task remains handled if it finishes after the
        // grace deadline, but it can never hold Schwab sampling or prediction.
        fidelityFlight.catch(() => {});
        const followup = bounded.then(async (outcome) => {
          clearTimeout(timer);
          if (outcome.timedOut) {
            await onCrossValidation({
              asOf,
              session,
              provider: "fidelity_web",
              sourceRole: "cross_check",
              status: "unavailable",
              blocking: false,
              reason: `Fidelity exceeded the ${graceMilliseconds}ms asynchronous grace`
            });
            return;
          }
          const fallback = outcome.fallback;
          const checks = compareCrossValidation(primary.quotes, fallback.quotes, {
            maximumDifferenceBps: Number(market.validation?.maxUnderlyingDifferenceBps ?? 25),
            maximumTimeSkewSeconds: Number(market.validation?.maxCrossCheckTimeSkewSeconds ?? 90)
          });
          await onCrossValidation({
            asOf,
            session,
            provider: "fidelity_web",
            sourceRole: "cross_check",
            status: Object.values(checks).some((item) => item.status === "stale") ? "stale"
              : Object.values(checks).some((item) => item.status === "warning") ? "warning"
                : Object.values(checks).every((item) => item.status === "pass") ? "pass" : "unavailable",
            checks,
            errors: fallback.errors
          });
        }).catch(async (error) => onCrossValidation({
          asOf,
          session,
          provider: "fidelity_web",
          sourceRole: "cross_check",
          status: "unavailable",
          error: safeError(error)
        })).finally(() => pendingCrossChecks.delete(followup));
        pendingCrossChecks.add(followup);
      } else {
        const status = crossCheckFidelity ? "not_scheduled" : "not_configured";
        for (const quote of Object.values(primary.quotes)) quote.crossValidation = { status, blocking: false };
      }
      for (const quote of Object.values(primary.quotes)) {
        quote.features.minutes_from_open = Math.max(0, (Date.parse(asOf) - Date.parse(session.openAt)) / MINUTE_MS);
        quote.features.minutes_to_close_total = Math.max(0, (Date.parse(session.closeAt) - Date.parse(asOf)) / MINUTE_MS);
      }
      return {
        schemaVersion: "intraday-market-sample.v1",
        observedAt: capturedAt,
        provider: "schwab",
        sourceRole: "primary",
        dataTier: "realtime_underlying",
        quoteSkewMs: primary.skewMs,
        crossValidation: {
          status: fidelityFlight && crossCheckFidelity ? "pending" : crossCheckFidelity ? "not_scheduled" : "not_configured",
          blocking: false
        },
        quotes: primary.quotes
      };
    },
    async close() {
      await Promise.allSettled([...pendingCrossChecks]);
    }
  };
}

function exchangeDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function createOfficialSessionResolver(config, {
  fetchHours = fetchEquityMarketHours,
  now = () => Date.now(),
  failureBackoffMilliseconds = 60_000
} = {}) {
  const timeZone = config.intradayResearch?.marketTimeZone ?? "America/New_York";
  const cache = new Map();
  const failures = new Map();
  return {
    timeZone,
    async resolve(value) {
      const at = value instanceof Date ? value : new Date(value);
      const dateKey = exchangeDate(at, timeZone);
      if (cache.has(dateKey)) return { ...cache.get(dateKey) };
      const failed = failures.get(dateKey);
      if (failed && now() - failed.at < failureBackoffMilliseconds) throw failed.error;
      try {
        const hours = await fetchHours(config.__root, { at, timeZone });
        const session = hours.is_open ? {
          dateKey: hours.date,
          isTradingDay: true,
          timeZone,
          openAt: iso(hours.regular_open),
          closeAt: iso(hours.regular_close),
          earlyClose: (Date.parse(hours.regular_close) - Date.parse(hours.regular_open)) < 6.5 * 60 * MINUTE_MS,
          calendarSource: "schwab_official_market_hours"
        } : {
          dateKey: hours.date,
          isTradingDay: false,
          timeZone,
          calendarSource: "schwab_official_market_hours"
        };
        cache.set(dateKey, session);
        failures.delete(dateKey);
        while (cache.size > 8) cache.delete(cache.keys().next().value);
        return { ...session };
      } catch (error) {
        failures.set(dateKey, { at: now(), error });
        throw error;
      }
    }
  };
}

function nearestPointAtOrBefore(points, targetAt, maximumFutureSkewMilliseconds = 2_000) {
  const targetMs = Date.parse(targetAt);
  const tolerance = Math.max(0, Number(maximumFutureSkewMilliseconds) || 0);
  return [...points].reverse().find((point) => Date.parse(point.observedAt) <= targetMs + tolerance) ?? null;
}

function finiteIfPresent(value, fallback = null) {
  if (value == null || value === "") return fallback;
  return finite(value, fallback);
}

function validCriticalMarketField(field, value) {
  if (value == null || value === "") return false;
  const number = finiteIfPresent(value);
  if (number == null) return false;
  if (["vwap", "rvol", "realized_vol"].includes(field)) return number > 0;
  if (field === "minutes_from_open") return number >= 0;
  return true;
}

/**
 * Build a causal market-state override and an explicit quality envelope.
 *
 * A small provider-clock lead is still accepted for quote synchronization,
 * but a precomputed feature is reusable only when its own point timestamp is
 * at or before issuedAt. This prevents a buffered post-signal feature from
 * silently becoming forecast input.
 */
export function assessCausalMarketState(request, maximumFutureSkewMilliseconds = 2_000) {
  const issuedMs = Date.parse(request.issuedAt);
  const futureSkewMilliseconds = Math.max(0, Number(maximumFutureSkewMilliseconds) || 0);
  const causalCutoffMs = issuedMs + futureSkewMilliseconds;
  const points = (request.recentPoints?.[request.symbol] ?? [])
    .filter((point) => finite(point.price) > 0
      && Number.isFinite(Date.parse(point.observedAt))
      && Date.parse(point.observedAt) <= causalCutoffMs)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const entryObservedMs = Date.parse(request.entryPoint?.observedAt ?? "");
  const strictlyCausalPoints = points.filter((point) => Date.parse(point.observedAt) <= issuedMs);
  if (finite(request.entryPoint?.price) > 0 && Number.isFinite(entryObservedMs) && entryObservedMs <= issuedMs
    && !strictlyCausalPoints.some((point) => point === request.entryPoint)) {
    strictlyCausalPoints.push(request.entryPoint);
    strictlyCausalPoints.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  }
  const synchronizedCurrent = points.at(-1) ?? request.entryPoint;
  const causalCurrent = strictlyCausalPoints.at(-1) ?? null;
  const price = finite(causalCurrent?.price);
  const featureSources = {};
  const fallbackFeature = (field) => {
    for (let index = strictlyCausalPoints.length - 1; index >= 0; index -= 1) {
      const value = finiteIfPresent(strictlyCausalPoints[index]?.features?.[field]);
      if (validCriticalMarketField(field, value)) {
        featureSources[field] = "precomputed_at_or_before_issued_at";
        return value;
      }
    }
    return null;
  };
  if (!(price > 0)) {
    const missingReasons = Object.fromEntries(CRITICAL_INTRADAY_MARKET_FIELDS.map((field) => [
      field,
      "no_causal_price_or_precomputed_feature_at_or_before_issued_at"
    ]));
    return {
      overrides: {},
      quality: {
        schema_version: "intraday-market-data-quality.v1",
        status: "invalid",
        required_fields: [...CRITICAL_INTRADAY_MARKET_FIELDS],
        present_fields: [],
        missing_fields: [...CRITICAL_INTRADAY_MARKET_FIELDS],
        missing_reasons: missingReasons,
        feature_sources: {},
        completeness: 0,
        source_confidence: null,
        effective_data_confidence: 0,
        causal_cutoff_at: request.issuedAt,
        accepted_provider_clock_skew_ms: futureSkewMilliseconds,
        valid_for_learning: false
      }
    };
  }
  const priceMinutesAgo = (minutes) => finite(nearestPointAtOrBefore(
    strictlyCausalPoints,
    new Date(issuedMs - minutes * MINUTE_MS),
    0
  )?.price);
  const prior5 = priceMinutesAgo(5);
  const prior15 = priceMinutesAgo(15);
  const logReturns = [];
  for (let index = 1; index < strictlyCausalPoints.length; index += 1) {
    const left = finite(strictlyCausalPoints[index - 1].price);
    const right = finite(strictlyCausalPoints[index].price);
    if (left > 0 && right > 0) logReturns.push(Math.log(right / left));
  }
  const recentReturns = logReturns.slice(-30);
  const mean = recentReturns.length ? recentReturns.reduce((sum, value) => sum + value, 0) / recentReturns.length : 0;
  const variance = recentReturns.length > 1
    ? recentReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (recentReturns.length - 1)
    : 0;
  let weightedValue = 0;
  let weightedVolume = 0;
  for (let index = 0; index < strictlyCausalPoints.length; index += 1) {
    const currentVolume = finite(strictlyCausalPoints[index].volume);
    const priorVolume = index > 0 ? finite(strictlyCausalPoints[index - 1].volume) : null;
    const currentSemantics = strictlyCausalPoints[index]?.features?.volume_semantics;
    const priorSemantics = index > 0 ? strictlyCausalPoints[index - 1]?.features?.volume_semantics : null;
    const delta = currentSemantics === "per_minute" ? Math.max(0, currentVolume ?? 0)
      : currentSemantics === "cumulative_session" && priorSemantics === "cumulative_session"
        && currentVolume != null && priorVolume != null ? Math.max(0, currentVolume - priorVolume) : 0;
    weightedValue += delta * Number(strictlyCausalPoints[index].price);
    weightedVolume += delta;
  }
  const computed = {
    vwap: weightedVolume > 0 ? weightedValue / weightedVolume : null,
    rvol: null,
    return_5m: prior5 > 0 ? round(price / prior5 - 1) : null,
    return_15m: prior15 > 0 ? round(price / prior15 - 1) : null,
    realized_vol: recentReturns.length >= 5 ? Math.sqrt(variance * 252 * 390) : null,
    minutes_from_open: null
  };
  for (const field of CRITICAL_INTRADAY_MARKET_FIELDS) {
    if (validCriticalMarketField(field, computed[field])) featureSources[field] = "derived_from_causal_points";
    else computed[field] = fallbackFeature(field);
  }
  const presentFields = CRITICAL_INTRADAY_MARKET_FIELDS.filter((field) => validCriticalMarketField(field, computed[field]));
  const missingFields = CRITICAL_INTRADAY_MARKET_FIELDS.filter((field) => !presentFields.includes(field));
  const missingReasons = Object.fromEntries(missingFields.map((field) => [field,
    field === "rvol" ? "no_precomputed_comparable-session_volume_baseline_at_or_before_issued_at"
      : field === "vwap" ? "no_causal_volume_weight_or_precomputed_vwap_at_or_before_issued_at"
        : field === "realized_vol" ? "fewer_than_five_causal_returns_and_no_precomputed_realized_vol"
          : field === "return_5m" ? "no_causal_5m_reference_or_precomputed_return"
            : field === "return_15m" ? "no_causal_15m_reference_or_precomputed_return"
              : "no_precomputed_session_clock_at_or_before_issued_at"]));
  const completeness = presentFields.length / CRITICAL_INTRADAY_MARKET_FIELDS.length;
  const sourceConfidence = finiteIfPresent(causalCurrent?.features?.data_confidence);
  const effectiveDataConfidence = round(clamp((sourceConfidence == null ? 1 : sourceConfidence) * completeness, 0, 1), 6);
  const synchronizedPrices = points.map((point) => Number(point.price)).filter(Number.isFinite);
  const raw = {
    high: Math.max(...synchronizedPrices, finiteIfPresent(synchronizedCurrent?.features?.high, -Infinity)),
    low: Math.min(...synchronizedPrices, finiteIfPresent(synchronizedCurrent?.features?.low, Infinity)),
    ...computed,
    minutes_to_close_total: finiteIfPresent(causalCurrent?.features?.minutes_to_close_total),
    previous_close: finiteIfPresent(causalCurrent?.features?.previous_close),
    stock_volume: finiteIfPresent(causalCurrent?.volume),
    stock_dollar_volume: finiteIfPresent(causalCurrent?.features?.stock_dollar_volume),
    data_confidence: effectiveDataConfidence
  };
  return {
    overrides: Object.fromEntries(Object.entries(raw).filter(([, value]) => value != null && Number.isFinite(value))),
    quality: {
      schema_version: "intraday-market-data-quality.v1",
      status: missingFields.length === 0 ? "complete" : presentFields.length === 0 ? "invalid" : "incomplete",
      required_fields: [...CRITICAL_INTRADAY_MARKET_FIELDS],
      present_fields: presentFields,
      missing_fields: missingFields,
      missing_reasons: missingReasons,
      feature_sources: featureSources,
      completeness: round(completeness, 6),
      source_confidence: sourceConfidence,
      effective_data_confidence: effectiveDataConfidence,
      causal_cutoff_at: request.issuedAt,
      accepted_provider_clock_skew_ms: futureSkewMilliseconds,
      valid_for_learning: missingFields.length === 0
    }
  };
}

export function causalMarketStateOverrides(request, maximumFutureSkewMilliseconds = 2_000) {
  return assessCausalMarketState(request, maximumFutureSkewMilliseconds).overrides;
}

function expectation(snapshot, horizon) {
  const expectations = snapshot?.ocean_wave?.expectations ?? {};
  return expectations[String(horizon)] ?? expectations[String(Number(horizon).toFixed(1))]
    ?? Object.entries(expectations).find(([key]) => Number(key) === Number(horizon))?.[1]
    ?? null;
}

export function evaluateIntradayActionability({
  expectedReturn,
  probabilityUp,
  returnVariance,
  entryPrice,
  entryBid,
  entryAsk,
  minimumProbabilityEdge = 0.02,
  minimumExpectedReturnBps = 3,
  dataQuality = null,
  trainingDayValid = true,
  modelActionability = null,
  modelAbstainReason = null
} = {}) {
  const expected = finiteIfPresent(expectedReturn);
  const rawProbability = finiteIfPresent(probabilityUp);
  const probability = rawProbability != null && rawProbability >= 0 && rawProbability <= 1 ? rawProbability : null;
  const price = finiteIfPresent(entryPrice);
  const bid = finiteIfPresent(entryBid);
  const ask = finiteIfPresent(entryAsk);
  const rawDirection = expected > 0 ? "up" : expected < 0 ? "down" : "flat";
  const probabilityThreshold = Math.max(0, finite(minimumProbabilityEdge, 0.02));
  const probabilityEdge = probability == null ? null : Math.abs(probability - 0.5);
  const spreadCost = price > 0 && bid > 0 && ask >= bid ? (ask - bid) / price : 0;
  const minimumReturn = Math.max(Math.max(0, finite(minimumExpectedReturnBps, 3)) / 10_000, spreadCost);
  const variance = finiteIfPresent(returnVariance);
  const returnSigma = variance != null && variance > 0 ? Math.sqrt(variance) : null;
  const signalToNoise = expected != null && returnSigma > 0 ? Math.abs(expected) / returnSigma : null;
  const reasons = [];
  if (expected == null) reasons.push("missing_expected_return");
  if (probability == null) reasons.push(rawProbability == null ? "missing_probability_up" : "invalid_probability_up");
  if (rawDirection === "flat") reasons.push("zero_expected_return");
  if (expected != null && Math.abs(expected) < minimumReturn) reasons.push("below_cost_and_minimum_return");
  if (probabilityEdge != null && probabilityEdge < probabilityThreshold) reasons.push("below_probability_edge");
  for (const field of dataQuality?.missing_fields ?? []) reasons.push(`missing_market_feature_${field}`);
  if (trainingDayValid !== true) reasons.push("invalid_training_day");
  if (String(modelActionability ?? "").toLowerCase() === "abstain") {
    const normalized = String(modelAbstainReason ?? "model_abstain").trim().toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    reasons.push(normalized || "model_abstain");
  }
  const uniqueReasons = [...new Set(reasons)];
  const actionable = uniqueReasons.length === 0;
  const validForLearning = trainingDayValid === true && dataQuality?.valid_for_learning !== false;
  const invalidForLearningReasons = [
    ...(trainingDayValid === true ? [] : ["invalid_training_day"]),
    ...((dataQuality?.missing_fields ?? []).map((field) => `missing_market_feature_${field}`))
  ];
  return {
    actionable,
    rawDirection,
    actionableDirection: actionable ? rawDirection : "flat",
    status: actionable ? "actionable" : "abstain",
    policy: "cost_probability_and_data_quality.v2",
    reason: actionable ? "actionable_edge" : uniqueReasons.join("+") || "not_actionable",
    abstain_reason: actionable ? null : uniqueReasons.join("+") || "not_actionable",
    reasons: uniqueReasons,
    expected_return: expected,
    probability_up: probability,
    probability_edge: probabilityEdge,
    minimum_probability_edge: probabilityThreshold,
    estimated_round_trip_spread_cost: spreadCost,
    minimum_expected_return: minimumReturn,
    return_sigma: returnSigma,
    signal_to_noise: signalToNoise,
    data_quality: dataQuality,
    training_day_valid: trainingDayValid === true,
    valid_for_learning: validForLearning,
    invalid_for_learning_reason: validForLearning ? null : [...new Set(invalidForLearningReasons)].join("+")
  };
}

export function createOceanWaveIntradayPool(config, {
  workerFactory = (options) => new JsonLineWorker(options),
  getAccessToken = getSchwabAccessToken
} = {}) {
  const settings = config.intradayResearch ?? {};
  const market = config.marketData ?? {};
  const symbols = settings.symbols ?? ["QQQ", "SPY"];
  const horizons = Array.from({ length: 30 }, (_, index) => index + 1);
  const python = path.resolve(config.__root, market.python ?? ".venv/Scripts/python.exe");
  const script = path.resolve(config.__root, market.workerScript ?? "scripts/realtime_worker.py");
  const stateRoot = path.resolve(config.__root, settings.stateDir ?? "data/intraday-state");
  const workers = new Map();
  for (const symbol of symbols) {
    const env = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
    delete env.SCHWAB_ACCESS_TOKEN;
    workers.set(symbol, workerFactory({
      file: python,
      args: [
        "-u", script,
        "--state-dir", path.join(stateRoot, symbol.toLowerCase()),
        "--horizons", horizons.join(","),
        "--strike-count", String(market.strikeCount ?? 40),
        "--max-symbols", "1",
        "--max-requests", "10000",
        "--feedback-learning-rate", String(config.positionWorkflow?.feedbackLearningRate ?? 0.025),
        "--feedback-minimum-samples", String(config.positionWorkflow?.feedbackMinimumSamples ?? 30),
        "--feedback-minimum-promotion-samples", String(settings.minimumPromotionForecasts ?? 500),
        "--feedback-minimum-valid-days", String(settings.minimumPromotionTradingDays ?? 40)
      ],
      cwd: config.__root,
      env,
      startupTimeoutMs: Number(market.workerStartupTimeoutSeconds ?? 15) * 1_000,
      requestTimeoutMs: Number(market.timeoutSeconds ?? 30) * 1_000,
      shutdownTimeoutMs: Number(market.workerShutdownTimeoutSeconds ?? 15) * 1_000,
      maxLineBytes: Number(market.maxProcessOutputBytes ?? 4 * 1024 * 1024),
      validateReady: (message) => message.schema_version === "ocean-wave-worker.v1"
        && (market.requireNativeCore === false || message.native_core === true)
    }));
  }
  return {
    async start() {
      // Native workers can start without a broker token. A forecast obtains
      // Schwab credentials lazily, while the sampler may continue on Fidelity.
      await Promise.all([...workers.values()].map((worker) => worker.start()));
    },
    async forecast(request) {
      const worker = workers.get(request.symbol);
      if (!worker) throw new Error(`No intraday Ocean Wave worker for ${request.symbol}`);
      const accessToken = await getAccessToken(config.__root);
      const maximumFutureSkewMilliseconds = Math.max(
        0,
        Number(settings.maximumQuoteSkewMilliseconds ?? 3_000) || 0
      );
      const causalMarketState = assessCausalMarketState(request, maximumFutureSkewMilliseconds);
      const overrides = causalMarketState.overrides;
      const trainingDayValid = request.trainingDayValid !== false && request.invalidTrainingDay !== true;
      const causalCutoffMs = Date.parse(request.issuedAt) + maximumFutureSkewMilliseconds;
      const prices = (request.recentPoints?.[request.symbol] ?? [])
        .filter((point) => Date.parse(point.observedAt) <= causalCutoffMs)
        .map((point) => finite(point.price))
        .filter((price) => price > 0)
        .slice(-Number(settings.fourierWindowMinutes ?? 120));
      const minimumFourierSamples = Number(settings.minimumFourierSamples ?? 32);
      const spectralDiagnostics = prices.length < minimumFourierSamples
        ? {
          schema_version: "intraday_price_features.v1",
          status: "abstain",
          reason: "cold_start_insufficient_causal_samples",
          price_sample_count: prices.length,
          minimum_price_samples: minimumFourierSamples,
          native_required: true,
          python_spectral_fallback: false
        }
        : await worker.request({
          command: "intraday_features",
          prices,
          valid_length: prices.length,
          max_harmonics: 64,
          sample_interval_minutes: 1
        });
      const snapshot = await worker.request({
        command: "predict",
        symbol: request.symbol,
        signal_published_at: request.issuedAt,
        access_token: accessToken,
        horizons,
        strike_count: Number(market.strikeCount ?? 40),
        market_state_overrides: overrides,
        training_day_valid: trainingDayValid
      });
      const observedAt = snapshot?.observed_at;
      const issuedMs = Date.parse(request.issuedAt);
      const observedMs = Date.parse(observedAt ?? "");
      const quoteAgeSeconds = (issuedMs - observedMs) / 1_000;
      const sourceOffsetSeconds = (observedMs - issuedMs) / 1_000;
      const maximumQuoteAgeSeconds = Number(settings.maximumQuoteAgeSeconds ?? 15);
      const maximumFutureSkewSeconds = maximumFutureSkewMilliseconds / 1_000;
      if (snapshot?.data_tier !== "realtime" || !Number.isFinite(quoteAgeSeconds)
        || quoteAgeSeconds > maximumQuoteAgeSeconds || quoteAgeSeconds < -maximumFutureSkewSeconds) {
        throw new Error(`Ocean Wave ${request.symbol} option-chain snapshot failed the issued-time realtime gate`);
      }
      const target = expectation(snapshot, 30);
      if (!target) throw new Error(`Ocean Wave did not return a 30-minute ${request.symbol} expectation`);
      const horizonPath = Object.fromEntries(horizons.map((horizon) => [horizon, expectation(snapshot, horizon)]));
      const rawProbabilityUp = finite(target.raw_probability_up
        ?? snapshot?.ocean_wave?.raw_probability
        ?? target.probability_up);
      const calibratedProbabilityUp = finite(target.calibrated_probability_up
        ?? snapshot?.ocean_wave?.calibrated_probability
        ?? target.probability_up);
      const actionability = evaluateIntradayActionability({
        expectedReturn: target.expected_return,
        probabilityUp: calibratedProbabilityUp,
        returnVariance: target.return_variance,
        entryPrice: request.entryPoint?.price,
        entryBid: request.entryPoint?.bid,
        entryAsk: request.entryPoint?.ask,
        minimumProbabilityEdge: Number(settings.minimumActionableProbabilityEdge ?? 0.02),
        minimumExpectedReturnBps: Number(settings.minimumActionableExpectedReturnBps ?? 3),
        dataQuality: causalMarketState.quality,
        trainingDayValid,
        modelActionability: snapshot?.ocean_wave?.actionability,
        modelAbstainReason: snapshot?.ocean_wave?.abstain_reason
      });
      return {
        direction: actionability.rawDirection,
        rawDirection: actionability.rawDirection,
        actionableDirection: actionability.actionableDirection,
        actionable: actionability.actionable,
        actionability,
        actionabilityStatus: actionability.status,
        abstainReason: actionability.abstain_reason,
        expectedReturn: finite(target.expected_return),
        probabilityUp: finite(target.probability_up),
        rawProbabilityUp,
        calibratedProbabilityUp,
        expectedPrice: finite(target.expected_price),
        confidence: finite(snapshot?.ocean_wave?.confidence),
        evidenceQuality: finite(snapshot?.ocean_wave?.evidence_quality ?? snapshot?.ocean_wave?.confidence),
        directionalEdge: Math.abs(2 * finite(target.probability_up, 0.5) - 1),
        confidenceSemantics: "input_quality_not_win_probability",
        validForLearning: actionability.valid_for_learning,
        invalidForLearningReason: actionability.invalid_for_learning_reason,
        modelVersion: `${snapshot.schema_version}:${snapshot?.ocean_wave?.native_core ? "cpp" : "non-native"}`,
        features: {
          marketStateOverrides: overrides,
          marketDataQuality: causalMarketState.quality,
          learningEligibility: {
            valid: actionability.valid_for_learning,
            reason: actionability.invalid_for_learning_reason,
            policy: "complete_causal_features_and_valid_training_day.v1"
          },
          spectralDiagnostics,
          regimeContext: request.entryPoint?.features?.regime_context ?? {
            quality: { status: "unavailable", confidence: 0 },
            independentSignalsAllowed: false
          },
          horizonPath,
          trendScore: finite(snapshot?.ocean_wave?.trend_score),
          diagnostics: snapshot?.ocean_wave?.diagnostics ?? null,
          chainFactors: snapshot?.ocean_wave?.chain_factors ?? null,
          provider: snapshot.provider,
          issuedAt: request.issuedAt,
          observedAt,
          generatedAt: snapshot.completed_at ?? snapshot.captured_at ?? null,
          sourceOffsetSeconds: round(sourceOffsetSeconds, 3),
          absoluteAlignmentSeconds: round(Math.abs(sourceOffsetSeconds), 3),
          quoteAgeSeconds: round(quoteAgeSeconds, 3),
          lagSeconds: round(sourceOffsetSeconds, 3),
          lagSemantics: "observed_at_minus_issued_at",
          nativeCore: snapshot?.ocean_wave?.native_core === true
        }
      };
    },
    async intradayFeatures(symbol, prices, options = {}) {
      const worker = workers.get(symbol);
      if (!worker) throw new Error(`No intraday Ocean Wave worker for ${symbol}`);
      const boundedPrices = prices.map(Number).filter((value) => Number.isFinite(value) && value > 0).slice(-390);
      const minimum = Number(settings.minimumFourierSamples ?? 32);
      if (boundedPrices.length < minimum) {
        return {
          schema_version: "intraday_price_features.v1",
          status: "abstain",
          reason: "full_session_insufficient_causal_samples",
          price_sample_count: boundedPrices.length,
          minimum_price_samples: minimum,
          native_required: true,
          python_spectral_fallback: false
        };
      }
      return worker.request({
        command: "intraday_features",
        prices: boundedPrices,
        valid_length: boundedPrices.length,
        max_harmonics: options.maxHarmonics ?? 195,
        sample_interval_minutes: 1
      });
    },
    status() {
      return Object.fromEntries([...workers].map(([symbol, worker]) => [symbol, worker.status()]));
    },
    async close() {
      await Promise.allSettled([...workers.values()].map((worker) => worker.close()));
    }
  };
}

function logit(probability) {
  const bounded = clamp(probability, 1e-6, 1 - 1e-6);
  return Math.log(bounded / (1 - bounded));
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function huber(error, delta = 0.001) {
  const absolute = Math.abs(error);
  return absolute <= delta ? 0.5 * error ** 2 : delta * (absolute - 0.5 * delta);
}

function newLeadCalibrationState() {
  return {
    schema_version: "intraday-lead-shadow-calibration.v2",
    deployment_status: "shadow_only",
    eligibility_policy: "closed_session_without_training_day_invalidation.v1",
    effective_weight_per_observation: 1 / 30,
    updated_at: null,
    buckets: {},
    recent_event_ids: [],
    eligible_sessions: [],
    source_event_count: 0,
    last_rebuild_at: null
  };
}

export class SqliteLeadShadowCalibrator {
  constructor(db, {
    stateKey = "intraday_research:lead_shadow_calibration:v2",
    effectiveWeight = 1 / 30,
    learningRate = 0.025,
    recentEventLimit = 1_024
  } = {}) {
    this.db = db;
    this.stateKey = stateKey;
    this.effectiveWeight = effectiveWeight;
    this.learningRate = learningRate;
    this.recentEventLimit = recentEventLimit;
  }

  load() {
    const state = getOperationalState(this.db, this.stateKey);
    return state?.schema_version === "intraday-lead-shadow-calibration.v2" ? state : newLeadCalibrationState();
  }

  applyToState(state, {
    forecastId,
    symbol,
    leadMinutes,
    probabilityUp,
    expectedReturn,
    actualReturn,
    observedAt,
    validForLearning = true
  }) {
    if (validForLearning !== true) {
      return { applied: false, reason: "forecast_invalid_for_learning", deployment_status: "shadow_only" };
    }
    const lead = Math.max(1, Math.min(30, Math.trunc(Number(leadMinutes))));
    const eventId = `${forecastId}:${lead}`;
    const rawProbability = probabilityUp == null ? null : Number(probabilityUp);
    const probability = rawProbability == null ? null : clamp(rawProbability, 1e-6, 1 - 1e-6);
    if (!forecastId || !["QQQ", "SPY"].includes(symbol) || !Number.isFinite(probability)
      || expectedReturn == null || !Number.isFinite(expectedReturn) || !Number.isFinite(actualReturn)) {
      return { applied: false, reason: "incomplete_lead_metrics", deployment_status: "shadow_only" };
    }
    if (state.recent_event_ids.includes(eventId)) {
      return { applied: false, reason: "duplicate_forecast_lead", eventId, deployment_status: "shadow_only" };
    }
    const key = `${symbol}:${lead}`;
    const bucket = {
      effective_samples: 0,
      observations: 0,
      probability_intercept: 0,
      probability_slope: 1,
      return_bias: 0,
      mean_brier: 0,
      mean_log_loss: 0,
      mean_huber: 0,
      ...(state.buckets[key] ?? {})
    };
    const outcome = actualReturn > 0 ? 1 : 0;
    const brier = (probability - outcome) ** 2;
    const logLoss = -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability));
    const residual = actualReturn - expectedReturn;
    const huberLoss = huber(residual);
    const priorWeight = Number(bucket.effective_samples) || 0;
    const nextWeight = priorWeight + this.effectiveWeight;
    const calibrated = sigmoid(bucket.probability_intercept + bucket.probability_slope * logit(probability));
    const probabilityError = outcome - calibrated;
    const step = this.learningRate * this.effectiveWeight / Math.sqrt(1 + priorWeight / 25);
    bucket.effective_samples = round(nextWeight, 10);
    bucket.observations = Number(bucket.observations) + 1;
    bucket.probability_intercept = round(clamp(bucket.probability_intercept + step * probabilityError, -1.5, 1.5));
    bucket.probability_slope = round(clamp(bucket.probability_slope + step * probabilityError * logit(probability), 0.5, 1.5));
    bucket.return_bias = round(clamp(bucket.return_bias + step * residual, -0.02, 0.02));
    bucket.mean_brier = round((bucket.mean_brier * priorWeight + brier * this.effectiveWeight) / nextWeight);
    bucket.mean_log_loss = round((bucket.mean_log_loss * priorWeight + logLoss * this.effectiveWeight) / nextWeight);
    bucket.mean_huber = round((bucket.mean_huber * priorWeight + huberLoss * this.effectiveWeight) / nextWeight, 14);
    bucket.last_event_at = observedAt;
    state.buckets[key] = bucket;
    state.updated_at = observedAt;
    state.effective_weight_per_observation = this.effectiveWeight;
    state.recent_event_ids = [...state.recent_event_ids, eventId].slice(-this.recentEventLimit);
    return {
      applied: true,
      eventId,
      bucket: key,
      effectiveWeight: this.effectiveWeight,
      deployment_status: "shadow_only",
      production_prediction_changed: false,
      metrics: {
        brier: round(brier),
        logLoss: round(logLoss),
        huber: round(huberLoss, 14),
        residual: round(residual)
      },
      state: { effectiveSamples: bucket.effective_samples, observations: bucket.observations }
    };
  }

  update(event) {
    const state = this.load();
    const result = this.applyToState(state, event);
    if (!result.applied) return result;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      setOperationalState(this.db, this.stateKey, state);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the state-write error. */ }
      throw error;
    }
    return result;
  }

  rebuildEligibleHistory() {
    const eligibleSessions = this.db.prepare(`
      SELECT DISTINCT closed.session_date
      FROM intraday_events closed
      WHERE closed.event_type='session_closed'
        AND NOT EXISTS (
          SELECT 1 FROM intraday_events invalid
          WHERE invalid.session_date=closed.session_date
            AND invalid.event_type='training_day_invalidated'
        )
      ORDER BY closed.session_date
    `).all().map((row) => String(row.session_date));
    const prior = this.load();
    if (JSON.stringify(prior.eligible_sessions ?? []) === JSON.stringify(eligibleSessions)) {
      return { rebuilt: false, eligible_sessions: eligibleSessions, source_event_count: prior.source_event_count ?? 0 };
    }
    const state = newLeadCalibrationState();
    const eligible = new Set(eligibleSessions);
    const rows = this.db.prepare(`
      SELECT session_date,forecast_id,symbol,event_at,payload_json
      FROM intraday_events
      WHERE event_type='trajectory_observed'
      ORDER BY event_at,id
    `).all();
    let applied = 0;
    for (const row of rows) {
      if (!eligible.has(String(row.session_date))) continue;
      let result;
      try { result = JSON.parse(row.payload_json)?.result; }
      catch { continue; }
      const update = this.applyToState(state, {
        forecastId: row.forecast_id,
        symbol: String(row.symbol ?? "").toUpperCase(),
        leadMinutes: result?.leadMinutes,
        probabilityUp: result?.probabilityUp,
        expectedReturn: result?.expectedReturn,
        actualReturn: result?.actualReturn,
        observedAt: row.event_at,
        validForLearning: result?.validForLearning !== false
      });
      if (update.applied) applied += 1;
    }
    state.eligible_sessions = eligibleSessions;
    state.source_event_count = applied;
    state.last_rebuild_at = new Date().toISOString();
    setOperationalState(this.db, this.stateKey, state);
    return { rebuilt: true, eligible_sessions: eligibleSessions, source_event_count: applied };
  }
}

export function createMinuteTrajectoryObserver({ leadCalibrator = null } = {}) {
  return {
    async observe({ forecast, point, elapsedMinutes }) {
      const lead = Math.max(1, Math.min(30, Math.round(elapsedMinutes)));
      const path = forecast.prediction?.features?.horizonPath ?? {};
      const expected = path[String(lead)] ?? path[lead] ?? null;
      const actualReturn = point.price / forecast.entryPrice - 1;
      const expectedReturn = finite(expected?.expected_return);
      const probabilityUp = finite(expected?.probability_up);
      const learningEligibility = forecast.prediction?.features?.learningEligibility ?? null;
      const validForLearning = learningEligibility?.valid !== false;
      const calibration = !validForLearning
        ? {
          applied: false,
          reason: learningEligibility?.reason ?? "forecast_invalid_for_learning",
          deployment_status: "shadow_only",
          state_schema: "intraday-lead-shadow-calibration.v2"
        }
        : leadCalibrator
        ? {
          applied: false,
          reason: "staged_in_event_log_until_session_eligibility_is_known",
          deployment_status: "shadow_only",
          state_schema: "intraday-lead-shadow-calibration.v2"
        }
        : { applied: false, reason: "calibrator_not_configured", deployment_status: "shadow_only" };
      const outcome = actualReturn > 0 ? 1 : 0;
      return {
        leadMinutes: lead,
        expectedReturn,
        probabilityUp,
        actualReturn: round(actualReturn),
        residual: expectedReturn == null ? null : round(actualReturn - expectedReturn),
        brier: probabilityUp == null ? null : round((probabilityUp - outcome) ** 2),
        logLoss: probabilityUp == null ? null : round(-(outcome * Math.log(clamp(probabilityUp, 1e-6, 1 - 1e-6))
          + (1 - outcome) * Math.log(1 - clamp(probabilityUp, 1e-6, 1 - 1e-6)))),
        huber: expectedReturn == null ? null : round(huber(actualReturn - expectedReturn), 14),
        effectiveWeight: 1 / 30,
        validForLearning,
        invalidForLearningReason: validForLearning ? null
          : learningEligibility?.reason ?? "forecast_invalid_for_learning",
        calibration,
        correctionPolicy: "rebuild_from_closed_eligible_sessions_before_next_session",
        productionPredictionChanged: false
      };
    }
  };
}

export class SqliteIntradayStore {
  constructor(db, { stateKey = "intraday_research:orchestrator_state:v1" } = {}) {
    this.db = db;
    this.stateKey = stateKey;
  }

  loadState() {
    return getOperationalState(this.db, this.stateKey);
  }

  commit(event, state) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      appendIntradayEvent(this.db, event);
      setOperationalState(this.db, this.stateKey, state);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the transaction's original error. */ }
      throw error;
    }
  }

  commitBatch(events, state) {
    if (!Array.isArray(events) || events.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) appendIntradayEvent(this.db, event);
      setOperationalState(this.db, this.stateKey, state);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the transaction's original error. */ }
      throw error;
    }
  }
}

export function summarizeNativeSpectralDiagnostics(forecasts, symbol) {
  const snapshots = forecasts
    .filter((forecast) => forecast.symbol === symbol)
    .map((forecast) => ({
      forecastId: forecast.forecastId,
      issuedAt: forecast.issuedAt,
      diagnostics: forecast.prediction?.features?.spectralDiagnostics ?? null
    }))
    .filter((item) => item.diagnostics != null);
  return {
    schemaVersion: "intraday-native-spectral-history.v1",
    symbol,
    status: snapshots.some((item) => item.diagnostics.status === "ok") ? "ok" : "abstain",
    source: "ocean_wave_cpp_only",
    pythonOrJavascriptFallback: false,
    snapshots
  };
}

function parsePayload(row) {
  if (row?.payload && typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row?.payload_json ?? "{}"); }
  catch { return {}; }
}

export function buildIntradayEodManifest(db, request, config) {
  const sessionDate = request.sessionDate;
  const events = listIntradayEvents(db, { sessionDate, limit: 100_000 });
  const points = Object.fromEntries((config.intradayResearch?.symbols ?? ["QQQ", "SPY"]).map((symbol) => [symbol, []]));
  for (const event of events) {
    if (!["minute_sample_batch", "historical_minute_sample_batch", "close_sample_batch"].includes(event.event_type)) continue;
    const payload = parsePayload(event);
    for (const [symbol, point] of Object.entries(payload.points ?? {})) {
      if (points[symbol]) points[symbol].push(point);
    }
  }
  const ownForecasts = events
    .filter((event) => event.event_type === "forecast_created" && event.source === "ocean_wave")
    .map(parsePayload);
  const spectral = Object.fromEntries(Object.keys(points).map((symbol) => [
    symbol,
    summarizeNativeSpectralDiagnostics(ownForecasts, symbol)
  ]));
  const leadCalibration = getOperationalState(db, "intraday_research:lead_shadow_calibration:v2") ?? newLeadCalibrationState();
  const { recent_event_ids: recentLeadEvents = [], ...boundedLeadCalibration } = leadCalibration;
  return {
    schema_version: "intraday-eod-manifest.v1",
    report_date: sessionDate,
    generated_at: new Date().toISOString(),
    immutable_event_range: {
      first_id: events[0]?.id ?? null,
      last_id: events.at(-1)?.id ?? null,
      count: events.length
    },
    research_only: true,
    production_weights_mutable: false,
    own_model: {
      forecasts: ownForecasts,
      scores: events.filter((event) => event.event_type === "forecast_scored" && event.source === "ocean_wave").map(parsePayload)
    },
    channel_forecasts: {
      forecasts: events.filter((event) => ["channel_forecast", "channel_forecast_created"].includes(event.event_type)).map((event) => ({
        id: event.id,
        source: event.source,
        payload: parsePayload(event)
      })),
      scores: events.filter((event) => event.event_type === "forecast_scored" && event.source !== "ocean_wave").map(parsePayload)
    },
    minute_quality: {
      point_counts: Object.fromEntries(Object.entries(points).map(([symbol, values]) => [symbol, values.length])),
      price_series: Object.fromEntries(Object.entries(points).map(([symbol, values]) => [
        symbol,
        values.map((point) => finite(point.price)).filter((value) => value > 0).slice(-390)
      ])),
      rejected_samples: events.filter((event) => event.event_type === "sample_rejected").map(parsePayload),
      missed_maturities: events.filter((event) => event.event_type === "forecast_maturity_missed").map(parsePayload),
      cross_validation: events.filter((event) => event.event_type === "minute_cross_validation").map(parsePayload)
    },
    spectral,
    lead_shadow_calibration: {
      ...boundedLeadCalibration,
      recent_event_count: recentLeadEvents.length
    },
    orchestrator_summary: {
      researchOnly: request.researchOnly,
      prohibitedActions: request.prohibitedActions,
      method: request.method,
      sourceMetrics: request.evidence?.sourceMetrics ?? {},
      minutePointCounts: request.evidence?.minutePointCounts ?? {},
      forecastCount: request.evidence?.forecastCount ?? request.evidence?.forecasts?.length ?? 0,
      scoreCount: request.evidence?.scoreCount ?? request.evidence?.scores?.length ?? 0,
      trajectoryObservationCount: request.evidence?.trajectoryObservationCount
        ?? request.evidence?.trajectoryObservations?.length ?? 0,
      channelMessageCount: request.evidence?.channelMessageCount ?? request.evidence?.channelMessages?.length ?? 0
    },
    promotion_gates: {
      minimum_trading_days: Number(config.intradayResearch?.minimumPromotionTradingDays ?? 40),
      minimum_forecasts: Number(config.intradayResearch?.minimumPromotionForecasts ?? 500),
      same_day_promotion_allowed: false
    }
  };
}

const INTRADAY_SOL_DECISIONS = new Set(["no_change", "collect_more_data", "backtest_candidate", "shadow_candidate"]);
const INTRADAY_SOL_REQUIRED_KEYS = [
  "report_date", "coverage", "data_quality", "own_model", "channel_forecasts",
  "regime_and_spectral_review", "failure_analysis", "candidate_change",
  "evaluation_gate", "resource_review", "decision"
];

export function validateIntradaySolReview(output, reportDate) {
  if (output?.schema_version !== "intraday-sol.v1") return "Expected schema_version intraday-sol.v1.";
  if (output.report_date !== reportDate) return `Expected report_date ${reportDate}.`;
  const missing = INTRADAY_SOL_REQUIRED_KEYS.filter((key) => !Object.hasOwn(output, key));
  if (missing.length) return `Missing required intraday Sol keys: ${missing.join(", ")}.`;
  if (typeof output.decision !== "string" || !INTRADAY_SOL_DECISIONS.has(output.decision)) {
    return "decision must be a JSON string: no_change, collect_more_data, backtest_candidate, or shadow_candidate.";
  }
  return true;
}

function degradedIntradaySolReview(request, reason, attempts = 1) {
  return {
    schema_version: "intraday-sol.v1",
    report_date: request.sessionDate,
    review_status: "degraded",
    research_only: true,
    training_day_eligible: request.trainingDayEligible === true,
    decision: "collect_more_data",
    candidate_change: null,
    degradation: {
      code: "invalid_schema",
      reason: String(reason ?? "Invalid intraday Sol review").replace(/\s+/g, " ").slice(0, 500)
    },
    deployment_status: "proposal_only",
    applied_to_production: false,
    openclaw_attempts: Math.max(1, Number(attempts) || 1)
  };
}

export function createIntradaySolSummarizer(config, db, {
  runAgent = runOpenClawAgent,
  spectralProvider = null,
  now = () => new Date()
} = {}) {
  return {
    async run(request) {
      const manifest = buildIntradayEodManifest(db, request, config);
      const fullSession = {};
      for (const symbol of config.intradayResearch?.symbols ?? ["QQQ", "SPY"]) {
        const prices = manifest.minute_quality.price_series[symbol] ?? [];
        const result = spectralProvider?.intradayFeatures
          ? await spectralProvider.intradayFeatures(symbol, prices, { maxHarmonics: 195 })
          : {
            schema_version: "intraday_price_features.v1",
            status: "abstain",
            reason: "native_spectral_provider_unavailable",
            native_required: true,
            python_spectral_fallback: false
          };
        fullSession[symbol] = {
          ...result,
          causal_cutoff: request.evidence?.session?.closeAt ?? null,
          usage: "next_session_challenger_evidence_only",
          same_day_prediction_changed: false
        };
        appendRuntimeEvent(db, {
          eventKey: `${request.sessionDate}:full-session-native-spectral:${symbol}`,
          sessionDate: request.sessionDate,
          eventType: "full_session_native_spectral",
          eventAt: now(),
          symbol,
          source: "ocean_wave_cpp",
          payload: fullSession[symbol]
        });
      }
      manifest.spectral.full_session = fullSession;
      let result;
      try {
        result = await runAgent(
          config,
          "sol",
          intradaySolPrompt(request.sessionDate, manifest),
          `intraday-sol:${request.sessionDate}`,
          { validateOutput: (output) => validateIntradaySolReview(output, request.sessionDate) }
        );
      } catch (error) {
        if (error?.code === "OPENCLAW_INVALID_SCHEMA") {
          return degradedIntradaySolReview(request, error.message, config.openclaw?.transientAttempts);
        }
        throw error;
      }
      const output = result?.output;
      const validation = validateIntradaySolReview(output, request.sessionDate);
      if (validation !== true) {
        return degradedIntradaySolReview(request, validation, result?.attempts);
      }
      return {
        ...output,
        review_status: "accepted",
        deployment_status: "proposal_only",
        applied_to_production: false,
        openclaw_attempts: result.attempts ?? 1
      };
    }
  };
}

class RestrictedChannelWorker {
  constructor({
    script = CHANNEL_WORKER_SCRIPT,
    spawnImpl = spawn,
    startupTimeoutMilliseconds = 5_000,
    requestTimeoutMilliseconds = 5_000,
    shutdownTimeoutMilliseconds = 3_000
  } = {}) {
    this.script = script;
    this.spawnImpl = spawnImpl;
    this.startupTimeoutMilliseconds = startupTimeoutMilliseconds;
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.shutdownTimeoutMilliseconds = shutdownTimeoutMilliseconds;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.ready = null;
  }

  async start() {
    if (this.child) return this.ready;
    const env = Object.fromEntries([
      "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"
    ].filter((key) => process.env[key] != null).map((key) => [key, process.env[key]]));
    const child = this.spawnImpl(process.execPath, ["--max-old-space-size=64", this.script], {
      cwd: path.dirname(this.script),
      env: { ...env, NODE_NO_WARNINGS: "1" },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Dedicated channel worker startup timed out")), this.startupTimeoutMilliseconds);
      timer.unref?.();
      const onReady = (message) => {
        if (message?.schema_version !== "intraday-channel-worker.v1" || message?.event !== "ready") return;
        clearTimeout(timer);
        this.onReady = null;
        resolve({ pid: child.pid });
      };
      this.onReady = onReady;
    });
    child.stdout.on("data", (chunk) => this.#stdout(chunk));
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.#fail(new Error(`Dedicated channel worker exited (${code ?? signal ?? "unknown"})`));
    });
    return this.ready;
  }

  async request(payload) {
    await this.start();
    const id = crypto.randomUUID();
    const line = Buffer.from(`${JSON.stringify({ ...payload, id })}\n`, "utf8");
    if (line.byteLength > 128 * 1024) throw new Error("Dedicated channel request exceeds 128 KiB");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Dedicated channel worker request timed out"));
      }, this.requestTimeoutMilliseconds);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    this.child.stdin.write(line, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error);
    });
    return response;
  }

  #stdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > 256 * 1024 && this.buffer.indexOf(0x0a) < 0) {
      this.#fail(new Error("Dedicated channel worker output exceeded limit"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(raw.toString("utf8")); }
      catch { this.#fail(new Error("Dedicated channel worker returned malformed JSON")); return; }
      if (message.event === "ready") {
        this.onReady?.(message);
        continue;
      }
      const pending = this.pending.get(String(message.id ?? ""));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(`Dedicated channel worker rejected request: ${String(message.error ?? "unknown").slice(0, 500)}`));
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  status() {
    return { pid: this.child?.pid ?? null, running: Boolean(this.child && !this.child.killed), pending: this.pending.size };
  }

  async close() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { await this.request({ command: "shutdown" }); } catch { /* Bounded forced exit below. */ }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.shutdownTimeoutMilliseconds);
      timer.unref?.();
    });
    const outcome = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (outcome === "timeout" && !child.killed) {
      child.kill();
      await exited;
    }
    this.child = null;
    this.buffer = Buffer.alloc(0);
  }
}

export function createDedicatedChannelProcessRunner(config, {
  spawnImpl = spawn,
  workerScript = CHANNEL_WORKER_SCRIPT
} = {}) {
  const maximum = Number(config.intradayResearch?.maximumActiveChannelWorkers ?? 8);
  const workers = new Set();
  return {
    async start(request) {
      if (workers.size >= maximum) {
        const error = new Error(`Active channel forecast worker limit reached (${maximum})`);
        error.code = "CHANNEL_WORKER_LIMIT";
        throw error;
      }
      const worker = new RestrictedChannelWorker({ script: workerScript, spawnImpl });
      workers.add(worker);
      try {
        const ready = await worker.start();
        const forecast = await worker.request({ command: "initialize", forecast: request.payload });
        return {
          isolatedProcess: true,
          processRef: `pid:${ready.pid}`,
          handle: worker,
          forecast
        };
      } catch (error) {
        workers.delete(worker);
        await worker.close().catch(() => {});
        throw error;
      }
    },
    async stop(handle) {
      if (!(handle instanceof RestrictedChannelWorker)) return;
      workers.delete(handle);
      await handle.close();
    },
    status() {
      return { active: workers.size, maximum, workers: [...workers].map((worker) => worker.status()) };
    },
    async close() {
      const active = [...workers];
      workers.clear();
      await Promise.allSettled(active.map((worker) => worker.close()));
    }
  };
}

function intradayControlPaths(config) {
  const directory = path.dirname(config.data.database);
  return {
    state: path.join(directory, CONTROL_FILES.state),
    request: path.join(directory, CONTROL_FILES.request),
    owner: path.join(directory, CONTROL_FILES.owner),
    watchdog: path.join(directory, CONTROL_FILES.watchdog)
  };
}

function readControl(filename, label, { lenientMissing = true } = {}) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) {
    if (lenientMissing && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular control file`);
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return { value, stat };
  } catch (error) {
    throw new Error(`${label} is malformed: ${error.message}`);
  }
}

function writeControl(filename, value) {
  return atomicWriteFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    allowCopyFallback: true
  });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (["EPERM", "EACCES"].includes(error.code)) return true;
    throw error;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireIntradayOwnership(files, instanceId, isProcessAlive) {
  fs.mkdirSync(path.dirname(files.owner), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(files.owner, "wx", 0o600);
      const record = {
        schema_version: "intraday-owner.v1",
        instance_id: instanceId,
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return { descriptor, record };
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch { /* Best effort after exclusive-create failure. */ }
        try { fs.rmSync(files.owner, { force: true }); } catch { /* Preserve the original error. */ }
      }
      if (error.code !== "EEXIST") throw error;
      const existing = readControl(files.owner, "Intraday ownership lock");
      const pid = Number(existing?.value?.pid);
      if (!existing?.value?.instance_id || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Intraday ownership lock is malformed; refusing unsafe recovery");
      }
      if (isProcessAlive(pid)) throw new Error(`Intraday research is already running (PID ${pid})`);
      const current = fs.lstatSync(files.owner);
      if (!sameFile(existing.stat, current)) throw new Error("Intraday ownership changed during stale-lock recovery");
      fs.unlinkSync(files.owner);
    }
  }
  throw new Error("Could not acquire intraday ownership after bounded recovery");
}

export function createIntradayControl(config, onStop, {
  pollMilliseconds = 250,
  isProcessAlive = processAlive,
  heartbeatWriteMilliseconds = 10_000,
  nowMilliseconds = () => Date.now()
} = {}) {
  const files = intradayControlPaths(config);
  const instanceId = crypto.randomUUID();
  const ownership = acquireIntradayOwnership(files, instanceId, isProcessAlive);
  let closed = false;
  let recoveredFailure = null;
  let state = {
    schema_version: "intraday-runtime.v1",
    instance_id: instanceId,
    pid: process.pid,
    status: "initializing",
    invalid_training_day: false,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const release = () => {
    try { fs.closeSync(ownership.descriptor); } catch { /* Path ownership check remains authoritative. */ }
    try {
      const current = readControl(files.owner, "Intraday ownership lock")?.value;
      if (current?.instance_id === instanceId && Number(current.pid) === process.pid) fs.rmSync(files.owner, { force: true });
    } catch { /* Final state still records the completed shutdown. */ }
  };
  const owned = () => {
    if (closed) return false;
    try {
      const owner = readControl(files.owner, "Intraday ownership lock")?.value;
      return owner?.instance_id === instanceId && Number(owner.pid) === process.pid;
    } catch { return false; }
  };
  try {
    const prior = readControl(files.state, "Intraday runtime state")?.value;
    const priorPid = Number(prior?.pid);
    if (prior && !["stopped", "failed"].includes(prior.status) && isProcessAlive(priorPid)) {
      throw new Error(`A legacy intraday process is still active (PID ${priorPid})`);
    }
    if (prior && !["stopped", "failed"].includes(prior.status)) {
      recoveredFailure = {
        kind: "unexpected_process_exit",
        prior_instance_id: prior.instance_id ?? null,
        prior_pid: Number.isSafeInteger(priorPid) && priorPid > 0 ? priorPid : null,
        prior_status: prior.status ?? null,
        prior_phase: prior.phase ?? null,
        prior_updated_at: prior.updated_at ?? null,
        session_date: prior.session_date ?? null,
        detected_at: new Date().toISOString()
      };
      state.recovered_failure = recoveredFailure;
    }
    fs.rmSync(files.request, { force: true });
    writeControl(files.state, state);
  } catch (error) {
    release();
    throw error;
  }
  const heartbeatWriteInterval = Math.max(1_000, Number(heartbeatWriteMilliseconds) || 10_000);
  let lastStateWriteAt = Number(nowMilliseconds());
  const persist = (status, details = {}) => {
    if (!owned()) return false;
    const writtenAt = Number(nowMilliseconds());
    state = { ...state, ...details, status, updated_at: new Date(writtenAt).toISOString() };
    writeControl(files.state, state);
    lastStateWriteAt = writtenAt;
    return true;
  };
  let stopFlight = null;
  const timer = setInterval(() => {
    if (stopFlight) return;
    try {
      const request = readControl(files.request, "Intraday stop request")?.value;
      if (!request || request.target_instance_id !== instanceId) return;
      fs.rmSync(files.request, { force: true });
      persist("stop_requested", { stop_reason: request.reason ?? "safe_stop" });
      stopFlight = Promise.resolve(onStop(request.reason ?? "safe_stop")).catch(() => {});
    } catch { /* A temporary control-file lock is retried on the next poll. */ }
  }, Math.max(100, Number(pollMilliseconds) || 250));
  timer.unref?.();
  return {
    instanceId,
    recoveredFailure,
    ownsInstance: owned,
    update: persist,
    heartbeat(details = {}) {
      if (!owned()) return false;
      state = { ...state, ...details };
      const writtenAt = Number(nowMilliseconds());
      const elapsed = writtenAt - lastStateWriteAt;
      if (elapsed >= 0 && elapsed < heartbeatWriteInterval) return true;
      state.updated_at = new Date(writtenAt).toISOString();
      writeControl(files.state, state);
      lastStateWriteAt = writtenAt;
      return true;
    },
    close(status = "stopped", details = {}) {
      if (closed) return;
      clearInterval(timer);
      try {
        persist(status, { ...details, stopped_at: new Date().toISOString() });
        try {
          const request = readControl(files.request, "Intraday stop request")?.value;
          if (!request || request.target_instance_id === instanceId) fs.rmSync(files.request, { force: true });
        } catch { /* Advisory request cleanup only. */ }
      } finally {
        closed = true;
        release();
      }
    }
  };
}

function exchangeTimeParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute)
  };
}

function clockMinute(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? fallback));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return clockMinute(fallback, "09:30");
  return Number(match[1]) * 60 + Number(match[2]);
}

function invalidateStoredIntradayTrainingDay(config, {
  sessionDate,
  reason,
  error = null,
  invalidatedAt = new Date().toISOString()
}) {
  if (!sessionDate) return { invalidated: false, reason: "session_unknown" };
  const db = openDatabase(config.data.database);
  try {
    const store = new SqliteIntradayStore(db);
    const state = store.loadState();
    if (!state || state.session?.dateKey !== sessionDate) return { invalidated: false, reason: "session_mismatch" };
    if (state.invalidTrainingDay === true) return { invalidated: false, reason: "already_invalid" };
    state.invalidTrainingDay = true;
    state.trainingDayInvalidatedAt = invalidatedAt;
    state.trainingDayInvalidReason = String(reason || "unexpected_process_exit").slice(0, 128);
    state.revision = Math.max(0, Number(state.revision) || 0) + 1;
    state.updatedAt = invalidatedAt;
    store.commit({
      eventKey: `${sessionDate}:training-day:invalid`,
      sessionDate,
      eventType: "training_day_invalidated",
      eventAt: invalidatedAt,
      source: "system",
      payload: {
        reason: state.trainingDayInvalidReason,
        error: error == null ? null : safeError(error),
        detected_by: "intraday_watchdog"
      }
    }, state);
    return { invalidated: true, reason: state.trainingDayInvalidReason };
  } finally {
    db.close();
  }
}

/**
 * Reconciles a dead runtime without starting it. The scheduled watchdog calls
 * this first, then starts the task only when restart_recommended is true.
 */
export function reconcileIntradayRuntimeState(config, {
  at = new Date(),
  isProcessAlive = processAlive,
  claimRestart = false,
  maximumRestartsPerSession = 3,
  restartCooldownMilliseconds = 5 * 60_000,
  heartbeatStaleMilliseconds = 120_000,
  closeRecoveryMinutes = 30
} = {}) {
  const now = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid watchdog timestamp: ${at}`);
  const files = intradayControlPaths(config);
  const timeZone = config.intradayResearch?.marketTimeZone ?? "America/New_York";
  const time = exchangeTimeParts(now, timeZone);
  const activeStatuses = new Set(["initializing", "starting", "ready", "draining", "stop_requested"]);
  let state = readControl(files.state, "Intraday runtime state")?.value ?? null;
  let detectedFailure = null;
  let invalidation = null;

  if (state && activeStatuses.has(String(state.status)) && !isProcessAlive(Number(state.pid))) {
    let owner = null;
    try { owner = readControl(files.owner, "Intraday ownership lock"); }
    catch (error) {
      return { status: "unsafe_owner_state", restart_recommended: false, error: safeError(error) };
    }
    if (owner && (owner.value?.instance_id !== state.instance_id || Number(owner.value?.pid) !== Number(state.pid))) {
      return { status: "owner_changed", restart_recommended: false };
    }
    const detectedAt = now.toISOString();
    detectedFailure = {
      kind: "unexpected_process_exit",
      prior_status: state.status,
      prior_phase: state.phase ?? null,
      prior_updated_at: state.updated_at ?? null,
      heartbeat_age_seconds: Number.isFinite(Date.parse(state.updated_at))
        ? Math.max(0, Math.round((now.getTime() - Date.parse(state.updated_at)) / 1_000))
        : null,
      detected_at: detectedAt
    };
    state = {
      ...state,
      status: "failed",
      invalid_training_day: true,
      incomplete_session: true,
      failure: detectedFailure,
      stopped_at: detectedAt,
      updated_at: detectedAt
    };
    writeControl(files.state, state);
    if (owner) {
      try {
        const current = fs.lstatSync(files.owner);
        if (sameFile(owner.stat, current) && !isProcessAlive(Number(owner.value.pid))) fs.unlinkSync(files.owner);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      invalidation = invalidateStoredIntradayTrainingDay(config, {
        sessionDate: state.session_date,
        reason: "unexpected_process_exit",
        error: new Error(`Intraday PID ${state.pid ?? "unknown"} exited while status=${detectedFailure.prior_status}`),
        invalidatedAt: detectedAt
      });
    } catch (error) {
      invalidation = { invalidated: false, reason: "persistence_failed", error: safeError(error) };
      state = { ...state, invalidation_error: invalidation.error, updated_at: new Date().toISOString() };
      writeControl(files.state, state);
    }
  }

  if (state && isProcessAlive(Number(state.pid))) {
    const updatedMs = Date.parse(state.updated_at);
    const heartbeatAgeMilliseconds = Number.isFinite(updatedMs) ? Math.max(0, now.getTime() - updatedMs) : Number.POSITIVE_INFINITY;
    const heartbeatStale = activeStatuses.has(String(state.status))
      && heartbeatAgeMilliseconds > Math.max(10_000, Number(heartbeatStaleMilliseconds) || 120_000);
    return {
      status: heartbeatStale ? "heartbeat_stale" : "running",
      restart_recommended: false,
      pid: Number(state.pid),
      heartbeat_age_seconds: Number.isFinite(heartbeatAgeMilliseconds) ? Math.round(heartbeatAgeMilliseconds / 1_000) : null,
      invalid_training_day: state.invalid_training_day === true
    };
  }

  const weekday = !["Sat", "Sun"].includes(time.weekday);
  const openMinute = clockMinute(config.intradayResearch?.fallbackOpenLocalTime, "09:30");
  const closeMinute = clockMinute(config.intradayResearch?.fallbackCloseLocalTime, "16:00") + Math.max(0, Number(closeRecoveryMinutes) || 0);
  const inRecoveryWindow = weekday && time.minuteOfDay >= openMinute && time.minuteOfDay <= closeMinute;
  const sameSession = state?.session_date === time.dateKey;
  const terminalForSession = sameSession && (state?.status === "stopped" || state?.phase === "closed" || state?.phase === "waiting_non_trading_day");
  if (!inRecoveryWindow || terminalForSession) {
    return {
      status: detectedFailure ? "failed_detected" : terminalForSession ? "session_complete" : "outside_recovery_window",
      restart_recommended: false,
      invalid_training_day: state?.invalid_training_day === true,
      detected_failure: detectedFailure,
      invalidation
    };
  }

  if (sameSession && state?.status === "failed" && isSchwabReauthorizationError(state.error)) {
    return {
      status: "schwab_reauthorization_required",
      restart_recommended: false,
      session_date: time.dateKey,
      invalid_training_day: state.invalid_training_day === true,
      reason: "Schwab authorization must be renewed before an Ocean Wave restart can restore option-chain forecasts"
    };
  }

  const watchdog = readControl(files.watchdog, "Intraday watchdog state")?.value;
  const priorAttempts = watchdog?.session_date === time.dateKey ? Math.max(0, Number(watchdog.restart_attempts) || 0) : 0;
  const lastRestartMs = watchdog?.session_date === time.dateKey ? Date.parse(watchdog.last_restart_at) : Number.NaN;
  const pendingExpiryMs = watchdog?.session_date === time.dateKey ? Date.parse(watchdog.pending_claim?.expires_at) : Number.NaN;
  const pendingClaimActive = Number.isFinite(pendingExpiryMs) && now.getTime() < pendingExpiryMs;
  const cooldownActive = pendingClaimActive
    || (Number.isFinite(lastRestartMs) && now.getTime() - lastRestartMs < Math.max(1_000, restartCooldownMilliseconds));
  const maximum = Math.max(0, Math.trunc(Number(maximumRestartsPerSession) || 0));
  const restartRecommended = priorAttempts < maximum && !cooldownActive;
  let nextWatchdog = watchdog ?? null;
  let claimId = null;
  if (restartRecommended && claimRestart) {
    claimId = crypto.randomUUID();
    nextWatchdog = {
      schema_version: "intraday-watchdog.v1",
      session_date: time.dateKey,
      restart_attempts: priorAttempts,
      last_restart_at: Number.isFinite(lastRestartMs) ? new Date(lastRestartMs).toISOString() : null,
      pending_claim: {
        id: claimId,
        claimed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + Math.max(1_000, restartCooldownMilliseconds)).toISOString()
      },
      reason: detectedFailure ? "unexpected_process_exit" : state?.status === "failed" ? "failed_runtime" : "missing_runtime"
    };
    writeControl(files.watchdog, nextWatchdog);
  }
  return {
    status: detectedFailure ? "failed_detected" : restartRecommended ? "restart_due" : cooldownActive ? "restart_cooldown" : "restart_limit_reached",
    restart_recommended: restartRecommended,
    restart_claimed: restartRecommended && claimRestart,
    claim_id: claimId,
    session_date: time.dateKey,
    restart_attempts: priorAttempts,
    maximum_restarts: maximum,
    invalid_training_day: state?.invalid_training_day === true,
    detected_failure: detectedFailure,
    invalidation,
    watchdog: nextWatchdog
  };
}

export function settleIntradayWatchdogClaim(config, claimId, {
  confirmed,
  at = new Date()
} = {}) {
  if (!claimId) throw new Error("Watchdog claim id is required");
  const files = intradayControlPaths(config);
  const watchdog = readControl(files.watchdog, "Intraday watchdog state")?.value;
  if (!watchdog || watchdog.pending_claim?.id !== claimId) return { settled: false, reason: "claim_mismatch" };
  const settledAt = (at instanceof Date ? at : new Date(at)).toISOString();
  const next = {
    ...watchdog,
    pending_claim: null,
    last_claim_id: claimId,
    last_claim_status: confirmed ? "confirmed" : "released",
    last_claim_settled_at: settledAt
  };
  if (confirmed) {
    next.restart_attempts = Math.max(0, Number(watchdog.restart_attempts) || 0) + 1;
    next.last_restart_at = settledAt;
  }
  writeControl(files.watchdog, next);
  return { settled: true, confirmed: Boolean(confirmed), restart_attempts: Math.max(0, Number(next.restart_attempts) || 0) };
}

export async function requestIntradayShutdown(config, options = {}) {
  const resolved = typeof options === "number" ? { timeoutMilliseconds: options } : options;
  const timeoutMilliseconds = Number(resolved.timeoutMilliseconds ?? 10 * 60_000);
  const pollMilliseconds = Number(resolved.pollMilliseconds ?? 250);
  const isProcessAlive = resolved.isProcessAlive ?? processAlive;
  const files = intradayControlPaths(config);
  const state = readControl(files.state, "Intraday runtime state")?.value;
  if (!state || ["stopped", "failed"].includes(state.status) || !isProcessAlive(Number(state.pid))) {
    fs.rmSync(files.request, { force: true });
    return { status: "already_stopped", previous: state?.status ?? null };
  }
  const requestedAt = new Date().toISOString();
  writeControl(files.request, {
    schema_version: "intraday-stop-request.v1",
    target_instance_id: state.instance_id,
    requested_at: requestedAt,
    requested_by_pid: process.pid,
    reason: "user_safe_stop"
  });
  const deadline = Date.now() + Math.max(1_000, timeoutMilliseconds);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMilliseconds)));
    const current = readControl(files.state, "Intraday runtime state")?.value;
    if (!current || current.instance_id !== state.instance_id || ["stopped", "failed"].includes(current.status)) {
      fs.rmSync(files.request, { force: true });
      return { status: current?.status === "failed" ? "failed" : "stopped", stopped_at: current?.stopped_at ?? null };
    }
    if (!isProcessAlive(Number(current.pid))) {
      fs.rmSync(files.request, { force: true });
      return { status: "process_exited", requested_at: requestedAt };
    }
  }
  throw new Error("Intraday safe stop timed out; the process was left intact");
}

function appendRuntimeEvent(db, record) {
  return appendIntradayEvent(db, {
    eventKey: record.eventKey,
    sessionDate: record.sessionDate,
    eventType: record.eventType,
    symbol: record.symbol ?? null,
    source: record.source ?? "system",
    eventAt: record.eventAt ?? new Date().toISOString(),
    forecastId: record.forecastId ?? null,
    maturesAt: record.maturesAt ?? null,
    payload: record.payload ?? {}
  });
}

function channelMessageFromRow(row, session) {
  const payload = parsePayload(row);
  let horizonMinutes = finite(payload.horizon_minutes ?? payload.horizonMinutes);
  if (!(horizonMinutes > 0) && payload.maturity_policy === "regular_close" && session?.closeAt) {
    horizonMinutes = (Date.parse(session.closeAt) - Date.parse(row.event_at)) / MINUTE_MS;
  }
  const maturesAt = row.matures_at ?? (horizonMinutes > 0
    ? new Date(Date.parse(row.event_at) + horizonMinutes * MINUTE_MS).toISOString()
    : null);
  return {
    scoreable: horizonMinutes >= 1 && horizonMinutes <= 390 && Number.isFinite(Date.parse(maturesAt ?? "")),
    maturesAt,
    message: {
      channel: String(row.source ?? "telegram:unknown").replace(/^telegram:/, ""),
      messageId: `intraday-event-${row.id}`,
      publishedAt: row.event_at,
      symbol: row.symbol,
      payload: {
        ...payload,
        symbol: row.symbol,
        horizonMinutes,
        source_event_id: row.id,
        evidence_hash: payload.evidence == null
          ? null
          : crypto.createHash("sha256").update(String(payload.evidence)).digest("hex")
      }
    }
  };
}

export function createIntradayRuntime(config, dependencies = {}) {
  if (config.safety?.readOnly !== true || config.safety?.allowTrading !== false) {
    throw new Error("Intraday runtime requires the read-only, no-trading safety contract");
  }
  if (config.intradayResearch?.enabled !== true) throw new Error("Intraday research is disabled");
  const db = dependencies.db ?? openDatabase(config.data.database);
  const closeDatabase = dependencies.closeDatabase ?? checkpointAndCloseDatabase;
  const store = dependencies.store ?? new SqliteIntradayStore(db);
  const clock = dependencies.clock ?? { now: () => new Date() };
  const scheduler = dependencies.scheduler ?? { setInterval, clearInterval };
  const sessionResolver = dependencies.sessionResolver ?? createOfficialSessionResolver(config, dependencies.sessionDependencies);
  let sampler;
  const onCrossValidation = async (result) => {
    const sessionDate = result.session?.dateKey ?? exchangeDate(result.asOf, config.intradayResearch.marketTimeZone);
    appendRuntimeEvent(db, {
      eventKey: `${sessionDate}:cross-validation:${result.asOf}`,
      sessionDate,
      eventType: "minute_cross_validation",
      eventAt: result.asOf,
      source: "fidelity_web",
      payload: result
    });
  };
  sampler = dependencies.sampler ?? createSchwabBatchSampler(config, {
    ...dependencies.samplerDependencies,
    now: () => clock.now(),
    onCrossValidation
  });
  const oceanPool = dependencies.oceanPool ?? createOceanWaveIntradayPool(config, dependencies.oceanPoolDependencies);
  const channelRunner = dependencies.channelRunner ?? createDedicatedChannelProcessRunner(config, dependencies.channelRunnerDependencies);
  const leadCalibrator = dependencies.leadCalibrator ?? new SqliteLeadShadowCalibrator(db);
  leadCalibrator.rebuildEligibleHistory?.();
  const closeSummarizer = dependencies.closeSummarizer ?? createIntradaySolSummarizer(config, db, {
    ...dependencies.solDependencies,
    spectralProvider: oceanPool,
    now: () => clock.now()
  });
  let orchestrator = dependencies.orchestrator ?? null;
  if (!orchestrator) {
    const trainingAwarePredictor = {
      forecast(request) {
        const state = typeof orchestrator?.statusView === "function"
          ? orchestrator.statusView() : orchestrator?.snapshot?.();
        return oceanPool.forecast({
          ...request,
          trainingDayValid: state?.invalidTrainingDay !== true
        });
      }
    };
    orchestrator = new IntradayResearchOrchestrator({
      symbols: config.intradayResearch.symbols,
      sessionResolver,
      sampler,
      predictor: trainingAwarePredictor,
      trajectoryObserver: createMinuteTrajectoryObserver({ leadCalibrator }),
      // Lead 30 is already present in the immutable minute trajectory. A second
      // endpoint update would double-count the same outcome and previously mixed
      // underlying direction labels into the option-profit calibrator.
      matureLearner: null,
      channelProcessRunner: channelRunner,
      closeSummarizer,
      store,
      clock,
      scheduler,
      sampleIntervalMs: Number(config.intradayResearch.sampleIntervalSeconds) * 1_000,
      forecastIntervalMinutes: Number(config.intradayResearch.forecastIntervalMinutes),
      horizonMinutes: Number(config.intradayResearch.forecastHorizonMinutes),
      maximumQuoteSkewMs: Number(config.intradayResearch.maximumQuoteSkewMilliseconds ?? 3_000),
      maximumScoreAlignmentMs: Number(config.intradayResearch.maximumScoreAlignmentSeconds ?? 5) * 1_000,
      maximumCatchupSlotsPerAdvance: Number(config.intradayResearch.maximumCatchupSlotsPerAdvance ?? 2),
      logger: dependencies.logger ?? console
    });
  }
  const tickQueue = new BoundedTaskQueue({ concurrency: 1, maximumPending: 2 });
  const startKeepAwakeImpl = dependencies.startKeepAwake ?? startKeepAwake;
  const controlFactory = dependencies.controlFactory ?? createIntradayControl;
  const intervalMilliseconds = Number(dependencies.pollMilliseconds ?? 1_000);
  let control = null;
  let stopKeepAwake = () => {};
  let timer = null;
  let started = false;
  let closing = false;
  let closed = false;
  let shutdownFlight = null;
  let targetSessionDate = null;
  let orchestratorSessionBound = false;
  let startupFailurePersisted = false;
  function readOrchestratorStatus(candidate = null) {
    if (candidate && typeof candidate === "object" && typeof candidate.phase === "string") return candidate;
    if (typeof orchestrator.statusView === "function") return orchestrator.statusView();
    return orchestrator.snapshot();
  }
  const initialOrchestratorRevision = Number(readOrchestratorStatus()?.revision ?? 0);
  let channelCursor = Number(getOperationalState(db, "intraday_research:channel_cursor:v1")?.id ?? 0);
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function persistUnboundStartupFailure(reason, error) {
    if (startupFailurePersisted) return null;
    startupFailurePersisted = true;
    const occurredAt = iso(clock.now());
    const sessionDate = targetSessionDate
      ?? exchangeDate(clock.now(), config.intradayResearch?.marketTimeZone ?? "America/New_York");
    const failure = safeError(error ?? new Error(reason));
    const instanceId = String(control?.instanceId ?? `unowned-${occurredAt}`);
    const payload = {
      reason: String(reason || "startup_failed").slice(0, 128),
      error: failure,
      incomplete_session: true,
      invalid_training_day: true,
      orchestrator_session_bound: false,
      prior_orchestrator_session_date: readOrchestratorStatus()?.session?.dateKey ?? null
    };
    const startupEvent = appendRuntimeEvent(db, {
      eventKey: `${sessionDate}:startup-failure:${instanceId}`,
      sessionDate,
      eventType: "startup_failure",
      eventAt: occurredAt,
      source: "system",
      payload
    });
    appendRuntimeEvent(db, {
      eventKey: `${sessionDate}:training-day:invalid`,
      sessionDate,
      eventType: "training_day_invalidated",
      eventAt: occurredAt,
      source: "system",
      payload: { ...payload, detected_by: "intraday_startup" }
    });
    setOperationalState(db, `intraday_research:session_health:v1:${sessionDate}`, {
      schema_version: "intraday-session-health.v1",
      session_date: sessionDate,
      status: "invalid",
      incomplete_session: true,
      invalid_training_day: true,
      failure_kind: "startup_failure",
      failed_at: occurredAt,
      error: failure
    });
    return { sessionDate, startupEvent };
  }

  async function pollChannelForecasts(statusState = null) {
    const state = readOrchestratorStatus(statusState);
    const session = state.session;
    const rows = listIntradayEvents(db, { eventType: "channel_forecast", afterId: channelCursor, limit: 100 });
    for (const row of rows) {
      try {
        if (!session || row.session_date !== session.dateKey || state.phase !== "open") continue;
        const converted = channelMessageFromRow(row, session);
        if (!converted.scoreable || Date.parse(converted.maturesAt) <= clock.now().getTime()) {
          appendRuntimeEvent(db, {
            eventKey: `${row.event_key}:runtime-unscored`,
            sessionDate: row.session_date,
            eventType: "channel_forecast_unscored",
            eventAt: clock.now(),
            symbol: row.symbol,
            source: row.source,
            forecastId: row.forecast_id,
            maturesAt: converted.maturesAt,
            payload: { reason: converted.scoreable ? "maturity_elapsed_before_runtime" : "not_scoreable" }
          });
          continue;
        }
        await orchestrator.ingestChannelPrediction(converted.message);
      } catch (error) {
        appendRuntimeEvent(db, {
          eventKey: `${row.event_key}:runtime-error`,
          sessionDate: row.session_date,
          eventType: "channel_forecast_runtime_error",
          eventAt: clock.now(),
          symbol: row.symbol,
          source: row.source,
          forecastId: row.forecast_id,
          maturesAt: row.matures_at,
          payload: safeError(error)
        });
      } finally {
        channelCursor = Math.max(channelCursor, Number(row.id));
        setOperationalState(db, "intraday_research:channel_cursor:v1", { id: channelCursor });
      }
    }
  }

  async function performTick() {
    const at = clock.now();
    const advancedState = readOrchestratorStatus(await orchestrator.advance(at));
    await pollChannelForecasts(advancedState);
    const state = readOrchestratorStatus();
    control?.heartbeat({
      phase: state.phase,
      session_date: state.session?.dateKey ?? null,
      last_minute_slot: state.lastMinuteSlot,
      invalid_training_day: state.invalidTrainingDay === true,
      ocean_workers: oceanPool.status?.() ?? null,
      channel_workers: channelRunner.status?.() ?? null
    });
    if (["closed", "waiting_non_trading_day"].includes(state.phase) && !closing) {
      queueMicrotask(() => { void close(state.phase === "closed" ? "market_closed" : "non_trading_day"); });
    }
    return state;
  }

  function tick() {
    const second = Math.floor(clock.now().getTime() / 1_000);
    return tickQueue.add(`tick:${second}`, performTick).catch((error) => {
      if (error.code === "QUEUE_FULL") return null;
      control?.heartbeat({ last_error: safeError(error), last_error_at: new Date().toISOString() });
      throw error;
    });
  }

  async function start() {
    if (started) return status();
    started = true;
    targetSessionDate = exchangeDate(clock.now(), config.intradayResearch?.marketTimeZone ?? "America/New_York");
    try {
      control = controlFactory(config, (reason) => close(reason));
      if (control?.recoveredFailure && orchestrator.invalidateTrainingDay) {
        await orchestrator.invalidateTrainingDay({
          reason: "unexpected_process_exit",
          error: new Error(`Recovered dead intraday PID ${control.recoveredFailure.prior_pid ?? "unknown"}`),
          at: clock.now(),
          sessionDate: control.recoveredFailure.session_date
        });
      }
      const keepAwakeManagedByLauncher = process.env.OCEAN_WAVE_EXTERNAL_KEEP_AWAKE === "1";
      stopKeepAwake = startKeepAwakeImpl(config.keepAwake !== false && !keepAwakeManagedByLauncher, (error) => {
        control?.heartbeat({ keep_awake_error: safeError(error) });
      });
      control.update("starting", { session_date: targetSessionDate, phase: "startup" });
      const session = await sessionResolver.resolve(clock.now());
      targetSessionDate = session?.dateKey ?? targetSessionDate;
      control.update("starting", {
        session_date: targetSessionDate,
        official_calendar: session?.calendarSource ?? null,
        phase: "startup"
      });
      if (session.isTradingDay && clock.now().getTime() < Date.parse(session.closeAt)) await oceanPool.start();
      await tick();
      if (!closing) {
        let state = readOrchestratorStatus();
        orchestratorSessionBound = state.session?.dateKey === targetSessionDate;
        const priorSessionHealth = targetSessionDate
          ? getOperationalState(db, `intraday_research:session_health:v1:${targetSessionDate}`)
          : null;
        if (orchestratorSessionBound
          && priorSessionHealth?.invalid_training_day === true
          && state.invalidTrainingDay !== true
          && orchestrator.invalidateTrainingDay) {
          const priorFailure = new Error(priorSessionHealth.error?.message ?? "Earlier startup failure invalidated this session");
          if (priorSessionHealth.error?.code) priorFailure.code = priorSessionHealth.error.code;
          await orchestrator.invalidateTrainingDay({
            reason: priorSessionHealth.failure_kind ?? "startup_failure",
            error: priorFailure,
            at: clock.now(),
            sessionDate: targetSessionDate
          });
          state = readOrchestratorStatus();
        }
        control.update("ready", {
          session_date: session.dateKey,
          official_calendar: session.calendarSource,
          phase: state.phase,
          invalid_training_day: state.invalidTrainingDay === true
        });
        timer = scheduler.setInterval(() => {
          tick().catch((error) => {
            dependencies.logger?.error?.("intraday tick failed", safeError(error));
            void close("tick_failed", { failed: true, error }).catch((closeError) => {
              dependencies.logger?.error?.("intraday fatal shutdown failed", safeError(closeError));
            });
          });
        }, Math.max(250, intervalMilliseconds));
      }
      return status();
    } catch (error) {
      const failedState = readOrchestratorStatus();
      if (!orchestratorSessionBound
        && failedState.session?.dateKey === targetSessionDate
        && Number(failedState.revision ?? 0) > initialOrchestratorRevision) {
        orchestratorSessionBound = true;
      }
      await close("startup_failed", { failed: true, error });
      throw error;
    }
  }

  async function close(reason = "safe_stop", { failed = false, error = null } = {}) {
    if (closed) return { status: failed ? "failed" : "stopped" };
    if (shutdownFlight) return shutdownFlight;
    closing = true;
    shutdownFlight = (async () => {
      if (timer != null) {
        scheduler.clearInterval(timer);
        timer = null;
      }
      let shutdownError = error;
      const safely = async (operation) => {
        try { await operation(); }
        catch (caught) { shutdownError ??= caught; }
      };
      try {
        await safely(() => control?.update("draining", {
          stop_reason: reason,
          ...(targetSessionDate ? { session_date: targetSessionDate } : {}),
          ...(!orchestratorSessionBound && (failed || shutdownError != null) ? { phase: "startup_failed" } : {})
        }));
        await safely(() => tickQueue.drain());
        if ((failed || shutdownError != null) && orchestratorSessionBound && orchestrator.invalidateTrainingDay) {
          await safely(() => orchestrator.invalidateTrainingDay({ reason, error: shutdownError, at: clock.now() }));
        }
        if ((failed || shutdownError != null) && !orchestratorSessionBound) {
          await safely(() => persistUnboundStartupFailure(reason, shutdownError));
        }
        if (orchestratorSessionBound) await safely(() => orchestrator.stop());
        await safely(() => sampler.close?.());
        await safely(() => oceanPool.close?.());
        await safely(() => channelRunner.close?.());
        await safely(() => closeDatabase(db));
        let finalFailed = failed || shutdownError != null;
        try {
          control?.close(finalFailed ? "failed" : "stopped", {
            stop_reason: reason,
            ...(targetSessionDate ? { session_date: targetSessionDate } : {}),
            ...(finalFailed && !orchestratorSessionBound ? { phase: "startup_failed", incomplete_session: true } : {}),
            invalid_training_day: finalFailed || readOrchestratorStatus().invalidTrainingDay === true,
            ocean_workers: oceanPool.status?.() ?? null,
            channel_workers: channelRunner.status?.() ?? null,
            error: shutdownError ? safeError(shutdownError) : null
          });
        } catch (caught) {
          shutdownError ??= caught;
          finalFailed = true;
        }
        closed = true;
        const outcome = { status: finalFailed ? "failed" : "stopped", reason, error: shutdownError ? safeError(shutdownError) : null };
        resolveClosed(outcome);
        return outcome;
      } finally {
        try { stopKeepAwake(); } catch { /* Process exit still must complete. */ }
        process.removeListener("SIGINT", signalStop);
        process.removeListener("SIGTERM", signalStop);
      }
    })();
    return shutdownFlight;
  }

  function signalStop(signal) {
    void close(`signal:${signal}`);
  }

  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);

  function status() {
    return {
      started,
      closing,
      closed,
      orchestrator: orchestrator.snapshot(),
      oceanWorkers: oceanPool.status?.() ?? null,
      channelWorkers: channelRunner.status?.() ?? null,
      channelCursor
    };
  }

  return {
    start,
    tick,
    close,
    status,
    waitUntilClosed: () => closedPromise,
    orchestrator,
    sampler,
    oceanPool,
    channelRunner
  };
}
