import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendIntradayEvent, getOperationalState, listIntradayEvents, openDatabase, setOperationalState } from "../src/db.js";
import {
  SqliteIntradayStore,
  SqliteLeadShadowCalibrator,
  assessCausalMarketState,
  causalMarketStateOverrides,
  createDedicatedChannelProcessRunner,
  createIntradayControl,
  createIntradayRuntime,
  createIntradaySolSummarizer,
  createOceanWaveIntradayPool,
  createOfficialSessionResolver,
  createSchwabBatchSampler,
  createMinuteTrajectoryObserver,
  evaluateIntradayActionability,
  reconcileIntradayRuntimeState,
  requestIntradayShutdown,
  settleIntradayWatchdogClaim,
  summarizeNativeSpectralDiagnostics,
  validateIntradaySolReview
} from "../src/intraday-runtime.js";

const OPEN = "2026-08-24T13:30:00.000Z";
const CLOSE = "2026-08-24T20:00:00.000Z";

function validIntradaySolReview(overrides = {}) {
  return {
    schema_version: "intraday-sol.v1",
    report_date: "2026-08-24",
    coverage: {},
    data_quality: {},
    own_model: {},
    channel_forecasts: {},
    regime_and_spectral_review: {},
    failure_analysis: {},
    candidate_change: null,
    evaluation_gate: {},
    resource_review: {},
    decision: "backtest_candidate",
    ...overrides
  };
}

function baseConfig(root) {
  return {
    __root: root,
    data: { database: path.join(root, "ocean-wave.sqlite") },
    keepAwake: true,
    safety: { readOnly: true, allowTrading: false, allowOutboundTelegram: false },
    intradayResearch: {
      enabled: true,
      symbols: ["QQQ", "SPY"],
      contextSymbols: ["IWM", "DIA", "TLT", "GLD"],
      sampleIntervalSeconds: 60,
      forecastIntervalMinutes: 30,
      forecastHorizonMinutes: 30,
      marketTimeZone: "America/New_York",
      maximumQuoteAgeSeconds: 15,
      maximumActiveChannelWorkers: 4,
      fourierWindowMinutes: 120,
      minimumFourierSamples: 32,
      minimumPromotionTradingDays: 40,
      minimumPromotionForecasts: 500,
      stateDir: "data/intraday-state"
    },
    marketData: {
      crossCheck: ["fidelity_web"],
      fallback: ["fidelity_web"],
      crossCheckWaitMilliseconds: 10,
      strikeCount: 20,
      timeoutSeconds: 5,
      requireNativeCore: true,
      validation: { maxUnderlyingDifferenceBps: 25, maxCrossCheckTimeSkewSeconds: 90 }
    },
    positionWorkflow: { feedbackLearningRate: 0.025, feedbackMinimumSamples: 30 },
    openclaw: { agents: { sol: { thinking: "high" } } }
  };
}

function schwabPayload(observedAt) {
  const quoteTime = Date.parse(observedAt);
  const values = { QQQ: 700, SPY: 650, IWM: 240, DIA: 460, TLT: 90, GLD: 310 };
  return Object.fromEntries(Object.entries(values).map(([symbol, price]) => [symbol, {
    quote: {
      bidPrice: price - 0.01,
      askPrice: price + 0.01,
      lastPrice: price,
      closePrice: price * 0.99,
      highPrice: price * 1.01,
      lowPrice: price * 0.98,
      totalVolume: 1_000_000,
      quoteTime
    }
  }]));
}

function fidelitySnapshot(symbol, observedAt, price = symbol === "QQQ" ? 700 : 650) {
  return { observed_at: observedAt, market_state: { underlying_price: price } };
}

test("one Schwab batch includes regime symbols while Fidelity runs only at 30-minute origins without blocking", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-sampler-"));
  try {
    const config = baseConfig(root);
    const fetchCalls = [];
    const fidelityCalls = [];
    const cross = [];
    const sampler = createSchwabBatchSampler(config, {
      getAccessToken: async () => "secret-token",
      now: () => new Date("2026-08-24T13:30:02.000Z"),
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return { ok: true, json: async () => schwabPayload("2026-08-24T13:30:01.000Z") };
      },
      fidelityQuote: async (symbol, asOf) => {
        fidelityCalls.push(symbol);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return fidelitySnapshot(symbol, asOf);
      },
      onCrossValidation: async (value) => cross.push(value)
    });
    const session = { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE };
    const started = Date.now();
    const sample = await sampler.sample({ symbols: ["QQQ", "SPY"], asOf: OPEN, session });
    assert.ok(Date.now() - started < 30, "Fidelity must not block the Schwab primary sample");
    assert.equal(fetchCalls.length, 1);
    for (const symbol of ["QQQ", "SPY", "IWM", "DIA", "TLT", "GLD"]) assert.match(fetchCalls[0], new RegExp(symbol));
    assert.equal(sample.provider, "schwab");
    assert.equal(sample.sourceRole, "primary");
    assert.equal(sample.quotes.QQQ.crossValidation.status, "pending");
    assert.equal(sample.quotes.QQQ.features.regime_context.quality.status, "complete");
    assert.equal(sample.quotes.QQQ.features.regime_context.independentSignalsAllowed, false);
    await sampler.close();
    assert.equal(fidelityCalls.length, 2);
    assert.equal(cross.length, 1);
    assert.equal(cross[0].status, "unavailable");

    const offOrigin = createSchwabBatchSampler(config, {
      getAccessToken: async () => "secret-token",
      now: () => new Date("2026-08-24T13:31:02.000Z"),
      fetchImpl: async () => ({ ok: true, json: async () => schwabPayload("2026-08-24T13:31:01.000Z") }),
      fidelityQuote: async () => { throw new Error("must not run"); }
    });
    const ordinary = await offOrigin.sample({ symbols: ["QQQ", "SPY"], asOf: "2026-08-24T13:31:00.000Z", session });
    assert.equal(ordinary.crossValidation.status, "not_scheduled");
    await offOrigin.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Fidelity is awaited only as a complete underlying fallback when Schwab fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-fallback-"));
  try {
    const config = baseConfig(root);
    const sampler = createSchwabBatchSampler(config, {
      getAccessToken: async () => "secret-token",
      now: () => new Date("2026-08-24T13:31:02.000Z"),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      fidelityQuote: async (symbol, asOf) => fidelitySnapshot(symbol, asOf)
    });
    const sample = await sampler.sample({
      symbols: ["QQQ", "SPY"],
      asOf: "2026-08-24T13:31:00.000Z",
      session: { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE }
    });
    assert.equal(sample.provider, "fidelity_web");
    assert.equal(sample.sourceRole, "fallback");
    assert.equal(sample.quotes.SPY.features.regime_context.quality.confidence, 0);
    await sampler.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Fidelity fallback is rejected instead of becoming a training point", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-fidelity-stale-"));
  try {
    const config = baseConfig(root);
    const sampler = createSchwabBatchSampler(config, {
      getAccessToken: async () => { throw new Error("Schwab unavailable"); },
      now: () => new Date("2026-08-24T13:31:02.000Z"),
      fidelityQuote: async (symbol) => fidelitySnapshot(symbol, "2026-08-24T13:15:00.000Z")
    });
    await assert.rejects(sampler.sample({
      symbols: ["QQQ", "SPY"],
      asOf: "2026-08-24T13:31:00.000Z",
      session: { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE }
    }), /complete QQQ\/SPY fallback batch/);
    await sampler.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Schwab batch accepts bounded provider clock lead and rejects lead beyond the configured skew", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-provider-clock-skew-"));
  try {
    const config = baseConfig(root);
    config.marketData.fallback = [];
    config.intradayResearch.maximumQuoteSkewMilliseconds = 3_000;
    const session = { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE };
    const accepted = createSchwabBatchSampler(config, {
      getAccessToken: async () => "token",
      now: () => new Date("2026-08-24T13:30:02.000Z"),
      fetchImpl: async () => ({
        ok: true,
        json: async () => schwabPayload("2026-08-24T13:30:04.500Z")
      })
    });
    const sample = await accepted.sample({ symbols: ["QQQ", "SPY"], asOf: OPEN, session });
    assert.equal(sample.provider, "schwab");
    assert.equal(sample.quotes.QQQ.features.quote_age_seconds, -2.5);
    await accepted.close();

    const rejected = createSchwabBatchSampler(config, {
      getAccessToken: async () => "token",
      now: () => new Date("2026-08-24T13:30:02.000Z"),
      fetchImpl: async () => ({
        ok: true,
        json: async () => schwabPayload("2026-08-24T13:30:05.500Z")
      })
    });
    await assert.rejects(
      rejected.sample({ symbols: ["QQQ", "SPY"], asOf: OPEN, session }),
      /outside the live-data limit/
    );
    await rejected.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Schwab batch fails closed on stale or skewed core quotes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-stale-"));
  try {
    const config = baseConfig(root);
    config.marketData.fallback = [];
    const payload = schwabPayload("2026-08-24T13:30:01.000Z");
    payload.SPY.quote.quoteTime = Date.parse("2026-08-24T13:29:50.000Z");
    const sampler = createSchwabBatchSampler(config, {
      getAccessToken: async () => "token",
      now: () => new Date("2026-08-24T13:30:02.000Z"),
      fetchImpl: async () => ({ ok: true, json: async () => payload })
    });
    await assert.rejects(sampler.sample({
      symbols: ["QQQ", "SPY"],
      asOf: OPEN,
      session: { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE }
    }), /quote skew/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official Schwab calendar is cached and preserves an early close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-hours-"));
  try {
    let calls = 0;
    const resolver = createOfficialSessionResolver(baseConfig(root), {
      fetchHours: async () => {
        calls += 1;
        return {
          date: "2026-11-27",
          is_open: true,
          regular_open: "2026-11-27T14:30:00.000Z",
          regular_close: "2026-11-27T18:00:00.000Z"
        };
      }
    });
    const first = await resolver.resolve("2026-11-27T15:00:00.000Z");
    const second = await resolver.resolve("2026-11-27T17:00:00.000Z");
    assert.equal(calls, 1);
    assert.equal(first.earlyClose, true);
    assert.equal(first.calendarSource, "schwab_official_market_hours");
    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("causal feature extraction excludes any reusable-buffer point after the forecast cutoff", () => {
  const features = causalMarketStateOverrides({
    symbol: "QQQ",
    issuedAt: "2026-08-24T13:35:00.000Z",
    recentPoints: {
      QQQ: [
        { observedAt: "2026-08-24T13:30:00.000Z", price: 100, volume: 100, features: { previous_close: 99 } },
        { observedAt: "2026-08-24T13:35:00.000Z", price: 101, volume: 200, features: { previous_close: 99 } },
        { observedAt: "2026-08-24T13:35:02.500Z", price: 102, volume: 250, features: { previous_close: 99 } },
        { observedAt: "2026-08-24T13:36:00.000Z", price: 1_000, volume: 300, features: { previous_close: 99 } }
      ]
    },
    entryPoint: { price: 101 }
  });
  assert.equal(features.high, 101);
  assert.equal(features.return_5m, 0.01);
  assert.notEqual(features.vwap, 1_000);
  const configuredSkewFeatures = causalMarketStateOverrides({
    symbol: "QQQ",
    issuedAt: "2026-08-24T13:35:00.000Z",
    recentPoints: {
      QQQ: [
        { observedAt: "2026-08-24T13:35:00.000Z", price: 101, features: { previous_close: 99 } },
        { observedAt: "2026-08-24T13:35:02.500Z", price: 102, features: { previous_close: 99 } }
      ]
    },
    entryPoint: { price: 102 }
  }, 3_000);
  assert.equal(configuredSkewFeatures.high, 102);
});

test("each missing critical market field stays missing, lowers confidence, and is never invented", () => {
  const complete = {
    vwap: 100.5,
    rvol: 1.2,
    return_5m: 0.002,
    return_15m: -0.001,
    realized_vol: 0.24,
    minutes_from_open: 35,
    data_confidence: 0.9
  };
  for (const missingField of ["vwap", "rvol", "return_5m", "return_15m", "realized_vol", "minutes_from_open"]) {
    const features = { ...complete };
    delete features[missingField];
    const assessed = assessCausalMarketState({
      symbol: "QQQ",
      issuedAt: "2026-08-24T14:05:00.000Z",
      entryPoint: { observedAt: "2026-08-24T14:05:00.000Z", price: 101, features },
      recentPoints: {
        QQQ: [{ observedAt: "2026-08-24T14:05:00.000Z", price: 101, features }]
      }
    });
    assert.deepEqual(assessed.quality.missing_fields, [missingField]);
    assert.equal(Object.hasOwn(assessed.overrides, missingField), false);
    assert.equal(assessed.quality.valid_for_learning, false);
    assert.equal(assessed.quality.completeness, 0.833333);
    assert.equal(assessed.overrides.data_confidence, 0.75);
    assert.match(assessed.quality.missing_reasons[missingField], /causal|precomputed|session/);
    assert.equal(Object.hasOwn(assessed.overrides, "quality"), false, "legacy override remains a flat numeric object");
  }
});

test("precomputed features after issuedAt cannot fill a causal data-quality gap", () => {
  const assessed = assessCausalMarketState({
    symbol: "QQQ",
    issuedAt: "2026-08-24T14:05:00.000Z",
    entryPoint: { observedAt: "2026-08-24T14:05:00.000Z", price: 101 },
    recentPoints: {
      QQQ: [
        {
          observedAt: "2026-08-24T14:05:00.000Z",
          price: 101,
          features: { vwap: 100, return_5m: 0.001, return_15m: 0.002, realized_vol: 0.2, minutes_from_open: 35 }
        },
        {
          observedAt: "2026-08-24T14:05:02.000Z",
          price: 101.1,
          features: { rvol: 1.5 }
        }
      ]
    }
  }, 3_000);
  assert.equal(assessed.overrides.high, 101.1, "bounded quote skew remains accepted for synchronized high/low");
  assert.equal(Object.hasOwn(assessed.overrides, "rvol"), false);
  assert.deepEqual(assessed.quality.missing_fields, ["rvol"]);
});

test("each forecast lead records proper losses but stages calibration until the session is eligible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-lead-"));
  const db = openDatabase(path.join(root, "lead.sqlite"));
  try {
    const calibrator = new SqliteLeadShadowCalibrator(db);
    const observer = createMinuteTrajectoryObserver({ leadCalibrator: calibrator });
    const forecast = {
      forecastId: "qqq-origin-1",
      source: "ocean_wave",
      symbol: "QQQ",
      entryPrice: 100,
      prediction: {
        features: {
          horizonPath: {
            1: { expected_return: 0.001, probability_up: 0.6 },
            2: { expected_return: 0.002, probability_up: 0.65 }
          }
        }
      }
    };
    const first = await observer.observe({
      forecast,
      point: { price: 100.2, observedAt: "2026-08-24T13:31:00.000Z" },
      elapsedMinutes: 1
    });
    const duplicate = await observer.observe({
      forecast,
      point: { price: 100.2, observedAt: "2026-08-24T13:31:00.000Z" },
      elapsedMinutes: 1
    });
    const secondLead = await observer.observe({
      forecast,
      point: { price: 100.3, observedAt: "2026-08-24T13:32:00.000Z" },
      elapsedMinutes: 2
    });
    assert.equal(first.calibration.applied, false);
    assert.equal(first.calibration.reason, "staged_in_event_log_until_session_eligibility_is_known");
    assert.equal(first.effectiveWeight, 1 / 30);
    assert.ok(Number.isFinite(first.brier) && Number.isFinite(first.logLoss) && Number.isFinite(first.huber));
    assert.equal(duplicate.calibration.reason, "staged_in_event_log_until_session_eligibility_is_known");
    assert.equal(secondLead.calibration.applied, false);
    const state = calibrator.load();
    assert.equal(state.deployment_status, "shadow_only");
    assert.deepEqual(state.buckets, {});
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lead calibration v2 rebuilds only closed sessions without invalidation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-lead-rebuild-"));
  const db = openDatabase(path.join(root, "lead.sqlite"));
  try {
    const trajectory = (date, symbol, suffix) => appendIntradayEvent(db, {
      eventKey: `${date}:${symbol}:${suffix}`,
      sessionDate: date,
      eventType: "trajectory_observed",
      symbol,
      source: "ocean_wave",
      eventAt: `${date}T14:00:00.000Z`,
      forecastId: `${date}:ocean_wave:0:30m:${symbol}`,
      maturesAt: `${date}T14:00:00.000Z`,
      payload: { result: { leadMinutes: 1, expectedReturn: 0.001, probabilityUp: 0.6, actualReturn: 0.002 } }
    });
    trajectory("2026-08-27", "QQQ", "valid");
    appendIntradayEvent(db, {
      eventKey: "2026-08-27:QQQ:invalid-feature-set",
      sessionDate: "2026-08-27",
      eventType: "trajectory_observed",
      symbol: "QQQ",
      source: "ocean_wave",
      eventAt: "2026-08-27T14:01:00.000Z",
      forecastId: "2026-08-27:ocean_wave:1:30m:QQQ",
      maturesAt: "2026-08-27T14:01:00.000Z",
      payload: {
        result: {
          leadMinutes: 1,
          expectedReturn: 0.001,
          probabilityUp: 0.6,
          actualReturn: 0.002,
          validForLearning: false,
          invalidForLearningReason: "missing_market_feature_rvol"
        }
      }
    });
    appendIntradayEvent(db, {
      eventKey: "2026-08-27:closed", sessionDate: "2026-08-27", eventType: "session_closed",
      source: "system", eventAt: "2026-08-27T20:00:00.000Z", payload: {}
    });
    trajectory("2026-08-26", "SPY", "invalid");
    appendIntradayEvent(db, {
      eventKey: "2026-08-26:closed", sessionDate: "2026-08-26", eventType: "session_closed",
      source: "system", eventAt: "2026-08-26T20:00:00.000Z", payload: {}
    });
    appendIntradayEvent(db, {
      eventKey: "2026-08-26:invalid", sessionDate: "2026-08-26", eventType: "training_day_invalidated",
      source: "system", eventAt: "2026-08-26T20:01:00.000Z", payload: {}
    });
    const calibrator = new SqliteLeadShadowCalibrator(db);
    const rebuilt = calibrator.rebuildEligibleHistory();
    const state = calibrator.load();
    assert.equal(rebuilt.rebuilt, true);
    assert.deepEqual(state.eligible_sessions, ["2026-08-27"]);
    assert.equal(state.source_event_count, 1);
    assert.equal(state.buckets["QQQ:1"].observations, 1);
    assert.equal(state.buckets["SPY:1"], undefined);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("actionability keeps numeric forecasts while rejecting microscopic, untradeable edges", () => {
  const weak = evaluateIntradayActionability({
    expectedReturn: 0.00001,
    probabilityUp: 0.503,
    returnVariance: 0.000001,
    entryPrice: 700,
    entryBid: 699.99,
    entryAsk: 700.01
  });
  assert.equal(weak.rawDirection, "up");
  assert.equal(weak.actionable, false);
  assert.equal(weak.actionableDirection, "flat");
  assert.match(weak.reason, /below_probability_edge/);
  const strong = evaluateIntradayActionability({
    expectedReturn: -0.001,
    probabilityUp: 0.45,
    returnVariance: 0.000004,
    entryPrice: 700,
    entryBid: 699.99,
    entryAsk: 700.01
  });
  assert.equal(strong.actionable, true);
  assert.equal(strong.actionableDirection, "down");
});

test("each symbol has a separate persistent worker, uses horizons 1..30, and calls native spectral features after warmup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-pool-"));
  try {
    const config = baseConfig(root);
    const workers = [];
    let tokenCalls = 0;
    const pool = createOceanWaveIntradayPool(config, {
      getAccessToken: async () => { tokenCalls += 1; return "access-token"; },
      workerFactory(options) {
        const worker = {
          options,
          requests: [],
          async start() { return { native_core: true }; },
          async request(request) {
            this.requests.push(request);
            if (request.command === "intraday_features") {
              return { schema_version: "intraday_price_features.v1", status: "ok", source: "ocean_wave_cpp", python_spectral_fallback: false };
            }
            if (request.command === "feedback") return { status: "updated", deployment_status: "shadow_only" };
            const expectations = Object.fromEntries(request.horizons.map((horizon) => [String(horizon), {
              expected_return: horizon / 100_000,
              probability_up: 0.51,
              expected_price: 700 + horizon / 100
            }]));
            return {
              schema_version: "ocean-wave-snapshot.v2",
              provider: "schwab",
              data_tier: "realtime",
              observed_at: request.signal_published_at,
              captured_at: request.signal_published_at,
              completed_at: request.signal_published_at,
              ocean_wave: { native_core: true, confidence: 0.7, trend_score: 0.1, expectations }
            };
          },
          status() { return { running: true }; },
          async close() {}
        };
        workers.push(worker);
        return worker;
      }
    });
    await pool.start();
    assert.equal(tokenCalls, 0, "worker startup must not depend on Schwab authorization");
    assert.equal(workers.length, 2);
    assert.notEqual(workers[0].options.args.at(3), workers[1].options.args.at(3));
    assert.equal(workers.every((worker) => worker.options.env.SCHWAB_ACCESS_TOKEN == null), true);
    const points = Array.from({ length: 40 }, (_, index) => ({
      observedAt: new Date(Date.parse(OPEN) + index * 60_000).toISOString(),
      price: 700 + index / 10,
      volume: 1_000 + index,
      features: { previous_close: 699, data_confidence: 1 }
    }));
    const output = await pool.forecast({
      symbol: "QQQ",
      issuedAt: points.at(-1).observedAt,
      entryPoint: points.at(-1),
      recentPoints: { QQQ: points, SPY: [] }
    });
    const qqqWorker = workers.find((worker) => worker.options.args.some((arg) => /qqq$/i.test(arg)));
    assert.deepEqual(qqqWorker.requests.map((request) => request.command), ["intraday_features", "predict"]);
    assert.deepEqual(qqqWorker.requests[1].horizons, Array.from({ length: 30 }, (_, index) => index + 1));
    assert.equal(output.features.spectralDiagnostics.source, "ocean_wave_cpp");
    assert.equal(output.features.horizonPath[30].expected_return, 0.0003);
    assert.equal(output.features.issuedAt, points.at(-1).observedAt);
    assert.equal(output.features.lagSeconds, 0);
    assert.equal(output.expectedReturn, 0.0003, "raw numeric forecast remains available for scoring");
    assert.equal(output.actionable, false);
    assert.equal(output.validForLearning, false);
    assert.ok(output.features.marketDataQuality.missing_fields.includes("rvol"));
    assert.match(output.abstainReason, /missing_market_feature_rvol/);
    assert.equal(tokenCalls, 1);

    const completePoints = points.map((point, index) => index !== points.length - 1 ? point : ({
      ...point,
      features: {
        ...point.features,
        vwap: 701,
        rvol: 1.2,
        return_5m: 0.001,
        return_15m: 0.002,
        realized_vol: 0.2,
        minutes_from_open: 39
      }
    }));
    const invalidDay = await pool.forecast({
      symbol: "QQQ",
      issuedAt: completePoints.at(-1).observedAt,
      entryPoint: completePoints.at(-1),
      recentPoints: { QQQ: completePoints, SPY: [] },
      trainingDayValid: false
    });
    assert.equal(invalidDay.expectedReturn, 0.0003);
    assert.equal(invalidDay.actionable, false);
    assert.equal(invalidDay.validForLearning, false);
    assert.equal(invalidDay.invalidForLearningReason, "invalid_training_day");
    assert.match(invalidDay.abstainReason, /invalid_training_day/);
    assert.equal(qqqWorker.requests.at(-1).training_day_valid, false);
    assert.equal(tokenCalls, 2);
    await pool.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog does not restart a known Schwab reauthorization failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-watchdog-auth-"));
  try {
    const config = baseConfig(root);
    fs.writeFileSync(path.join(root, "intraday-runtime.json"), JSON.stringify({
      schema_version: "intraday-runtime.v1",
      instance_id: "auth-failed",
      pid: 987654,
      status: "failed",
      session_date: "2026-08-24",
      invalid_training_day: true,
      error: { code: "SCHWAB_REAUTH_REQUIRED", message: "Refresh token is invalid, expired or revoked" },
      updated_at: "2026-08-24T13:35:00.000Z"
    }));
    const result = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:30:00.000Z"),
      isProcessAlive: () => false,
      claimRestart: true
    });
    assert.equal(result.status, "schwab_reauthorization_required");
    assert.equal(result.restart_recommended, false);
    assert.equal(fs.existsSync(path.join(root, "intraday-watchdog.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Ocean Wave option-chain snapshot must independently pass realtime issued-time alignment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-chain-gate-"));
  try {
    const config = baseConfig(root);
    const pool = createOceanWaveIntradayPool(config, {
      getAccessToken: async () => "token",
      workerFactory: () => ({
        async start() {},
        async request(request) {
          return {
            schema_version: "ocean-wave-snapshot.v2",
            provider: "schwab",
            data_tier: "realtime",
            observed_at: new Date(Date.parse(request.signal_published_at) - 16_000).toISOString(),
            ocean_wave: {
              native_core: true,
              expectations: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [String(index + 1), {
                expected_return: 0,
                probability_up: 0.5,
                expected_price: 700
              }]))
            }
          };
        },
        status() { return {}; },
        async close() {}
      })
    });
    const point = { observedAt: OPEN, price: 700, features: {} };
    await assert.rejects(pool.forecast({
      symbol: "QQQ",
      issuedAt: OPEN,
      entryPoint: point,
      recentPoints: { QQQ: [point] }
    }), /issued-time realtime gate/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Ocean Wave option-chain gate accepts provider clock lead within the configured skew", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-chain-clock-skew-"));
  try {
    const config = baseConfig(root);
    config.intradayResearch.maximumQuoteSkewMilliseconds = 3_000;
    const pool = createOceanWaveIntradayPool(config, {
      getAccessToken: async () => "token",
      workerFactory: () => ({
        async start() {},
        async request(request) {
          return {
            schema_version: "ocean-wave-snapshot.v2",
            provider: "schwab",
            data_tier: "realtime",
            observed_at: new Date(Date.parse(request.signal_published_at) + 2_500).toISOString(),
            ocean_wave: {
              native_core: true,
              expectations: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [String(index + 1), {
                expected_return: 0.0001,
                probability_up: 0.51,
                expected_price: 700
              }]))
            }
          };
        },
        status() { return {}; },
        async close() {}
      })
    });
    const point = { observedAt: new Date(Date.parse(OPEN) + 2_500).toISOString(), price: 700, features: {} };
    const output = await pool.forecast({
      symbol: "QQQ",
      issuedAt: OPEN,
      entryPoint: point,
      recentPoints: { QQQ: [point] }
    });
    assert.equal(output.features.lagSeconds, 2.5);
    assert.equal(output.features.quoteAgeSeconds, -2.5);
    assert.equal(output.features.lagSemantics, "observed_at_minus_issued_at");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cold-start spectral state abstains explicitly and never invokes a slow fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-cold-"));
  try {
    const config = baseConfig(root);
    const requests = [];
    const pool = createOceanWaveIntradayPool(config, {
      getAccessToken: async () => "token",
      workerFactory: () => ({
        async start() {},
        async request(request) {
          requests.push(request);
          return {
            schema_version: "ocean-wave-snapshot.v2",
            provider: "schwab",
            data_tier: "realtime",
            observed_at: OPEN,
            ocean_wave: {
              native_core: true,
              expectations: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [String(index + 1), {
                expected_return: 0,
                probability_up: 0.5,
                expected_price: 700
              }]))
            }
          };
        },
        status() { return {}; },
        async close() {}
      })
    });
    const point = { observedAt: OPEN, price: 700, features: {} };
    const output = await pool.forecast({ symbol: "QQQ", issuedAt: OPEN, entryPoint: point, recentPoints: { QQQ: [point] } });
    assert.deepEqual(requests.map((request) => request.command), ["predict"]);
    assert.equal(output.features.spectralDiagnostics.status, "abstain");
    assert.equal(output.features.spectralDiagnostics.reason, "cold_start_insufficient_causal_samples");
    assert.equal(output.features.spectralDiagnostics.python_spectral_fallback, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite intraday store commits append-only event and operational state in one transaction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-sqlite-"));
  const db = openDatabase(path.join(root, "research.sqlite"));
  try {
    const store = new SqliteIntradayStore(db);
    const event = {
      eventKey: "2026-08-24:test:1",
      sessionDate: "2026-08-24",
      eventType: "test_event",
      symbol: "QQQ",
      source: "test",
      eventAt: OPEN,
      forecastId: null,
      maturesAt: null,
      payload: { ok: true }
    };
    store.commit(event, { schemaVersion: "ocean-wave-intraday-research.v1", revision: 1 });
    assert.equal(listIntradayEvents(db, { sessionDate: "2026-08-24" }).length, 1);
    assert.equal(store.loadState().revision, 1);
    const circular = {};
    circular.self = circular;
    assert.throws(() => store.commit({ ...event, eventKey: "2026-08-24:test:2", payload: circular }, { revision: 2 }), /circular/i);
    assert.equal(store.loadState().revision, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dedicated channel forecast worker is a bounded independent Node process and releases cleanly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-channel-"));
  try {
    const runner = createDedicatedChannelProcessRunner(baseConfig(root));
    const started = await runner.start({
      payload: { symbol: "QQQ", direction: "up", horizon_minutes: 30, confidence: 0.8, evidence: "QQQ next 30m up" }
    });
    assert.equal(started.isolatedProcess, true);
    assert.match(started.processRef, /^pid:\d+$/);
    assert.equal(started.forecast.researchOnly, true);
    assert.equal(runner.status().active, 1);
    await runner.stop(started.handle);
    assert.equal(runner.status().active, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Sol EOD adapter accepts challenger proposals only and preserves native spectral history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-sol-"));
  const config = baseConfig(root);
  const db = openDatabase(config.data.database);
  try {
    const forecast = {
      forecastId: "forecast-1",
      symbol: "QQQ",
      issuedAt: OPEN,
      prediction: { features: { spectralDiagnostics: { status: "ok", source: "ocean_wave_cpp" } } }
    };
    appendIntradayEvent(db, {
      eventKey: "forecast-1:created",
      sessionDate: "2026-08-24",
      eventType: "forecast_created",
      symbol: "QQQ",
      source: "ocean_wave",
      eventAt: OPEN,
      forecastId: "forecast-1",
      maturesAt: "2026-08-24T14:00:00.000Z",
      payload: forecast
    });
    let prompt;
    const summarizer = createIntradaySolSummarizer(config, db, {
      spectralProvider: {
        async intradayFeatures(symbol, prices) {
          return { schema_version: "intraday_price_features.v1", status: "ok", source: "ocean_wave_cpp", symbol, price_sample_count: prices.length };
        }
      },
      runAgent: async (_config, stage, input, _sessionKey, options) => {
        assert.equal(stage, "sol");
        prompt = input;
        const output = validIntradaySolReview();
        assert.equal(options.validateOutput(output), true);
        return { attempts: 1, output };
      }
    });
    const result = await summarizer.run({ sessionDate: "2026-08-24", evidence: {} });
    assert.equal(result.deployment_status, "proposal_only");
    assert.equal(result.applied_to_production, false);
    assert.equal(result.review_status, "accepted");
    assert.match(prompt, /ocean_wave_cpp_only/);
    assert.equal(listIntradayEvents(db, { eventType: "full_session_native_spectral" }).length, 2);
    const spectral = summarizeNativeSpectralDiagnostics([forecast], "QQQ");
    assert.equal(spectral.status, "ok");
    assert.equal(spectral.pythonOrJavascriptFallback, false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Sol EOD adapter rejects a wrapped decision and archives a deterministic collect-more-data review", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-sol-degraded-"));
  const config = baseConfig(root);
  config.openclaw.transientAttempts = 2;
  const db = openDatabase(config.data.database);
  try {
    let prompt;
    const wrapped = validIntradaySolReview({
      decision: { value: "backtest_candidate", production_action: "none" }
    });
    assert.match(validateIntradaySolReview(wrapped, "2026-08-24"), /decision must be a JSON string/);
    const summarizer = createIntradaySolSummarizer(config, db, {
      runAgent: async (_config, _stage, input, _sessionKey, options) => {
        prompt = input;
        const validation = options.validateOutput(wrapped);
        assert.match(validation, /decision must be a JSON string/);
        const error = new Error(validation);
        error.code = "OPENCLAW_INVALID_SCHEMA";
        throw error;
      }
    });
    const result = await summarizer.run({
      sessionDate: "2026-08-24",
      trainingDayEligible: false,
      evidence: {}
    });
    assert.match(prompt, /decision must be a JSON string, never an object/);
    assert.equal(result.review_status, "degraded");
    assert.equal(result.decision, "collect_more_data");
    assert.equal(result.training_day_eligible, false);
    assert.equal(result.deployment_status, "proposal_only");
    assert.equal(result.applied_to_production, false);
    assert.equal(result.openclaw_attempts, 2);
    assert.equal(result.candidate_change, null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intraday control enforces one owner and completes a targeted safe-stop request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-control-"));
  try {
    const config = baseConfig(root);
    let control;
    control = createIntradayControl(config, () => control.close("stopped"), { pollMilliseconds: 20 });
    assert.throws(() => createIntradayControl(config, () => {}, { isProcessAlive: () => true }), /already running/);
    control.update("ready");
    const outcome = await requestIntradayShutdown(config, {
      timeoutMilliseconds: 2_000,
      pollMilliseconds: 20,
      isProcessAlive: () => true
    });
    assert.equal(outcome.status, "stopped");
    assert.equal(fs.existsSync(path.join(root, "intraday-owner.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intraday control buffers one-second heartbeats and checkpoints the latest state every ten seconds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-heartbeat-io-"));
  const base = Date.parse("2026-08-26T13:30:00.000Z");
  let now = base;
  try {
    const config = baseConfig(root);
    const control = createIntradayControl(config, () => {}, {
      nowMilliseconds: () => now,
      heartbeatWriteMilliseconds: 10_000
    });
    const statePath = path.join(root, "intraday-runtime.json");
    control.heartbeat({ phase: "open", last_minute_slot: 0 });
    let persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.phase, undefined, "a one-second loop must not replace the control file every tick");

    now += 9_999;
    control.heartbeat({ last_minute_slot: 1 });
    persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.last_minute_slot, undefined);

    now += 1;
    control.heartbeat({ last_minute_slot: 2 });
    persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.phase, "open", "the checkpoint must include details buffered by prior heartbeats");
    assert.equal(persisted.last_minute_slot, 2);
    assert.equal(persisted.updated_at, "2026-08-26T13:30:10.000Z");

    now += 1;
    control.update("draining", { stop_reason: "test" });
    persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.status, "draining", "explicit lifecycle updates must always persist immediately");
    control.close("stopped");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intraday control reports recovery of an active state whose process disappeared", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-control-recovery-"));
  try {
    const config = baseConfig(root);
    const prior = {
      schema_version: "intraday-runtime.v1",
      instance_id: "dead-instance",
      pid: 987654,
      status: "ready",
      phase: "open",
      session_date: "2026-08-24",
      updated_at: "2026-08-24T18:00:00.000Z"
    };
    fs.writeFileSync(path.join(root, "intraday-runtime.json"), JSON.stringify(prior));
    fs.writeFileSync(path.join(root, "intraday-owner.lock"), JSON.stringify({
      schema_version: "intraday-owner.v1", instance_id: prior.instance_id, pid: prior.pid
    }));
    const control = createIntradayControl(config, () => {}, { isProcessAlive: () => false });
    assert.equal(control.recoveredFailure.kind, "unexpected_process_exit");
    assert.equal(control.recoveredFailure.session_date, "2026-08-24");
    const current = JSON.parse(fs.readFileSync(path.join(root, "intraday-runtime.json"), "utf8"));
    assert.equal(current.status, "initializing");
    assert.equal(current.recovered_failure.prior_status, "ready");
    control.close("failed", { invalid_training_day: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog reconciles a dead ready process, invalidates the stored training day, and uses confirmable restart claims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-watchdog-"));
  const config = baseConfig(root);
  let db = openDatabase(config.data.database);
  try {
    setOperationalState(db, "intraday_research:orchestrator_state:v1", {
      schemaVersion: "ocean-wave-intraday-research.v1",
      revision: 3,
      phase: "open",
      session: { dateKey: "2026-08-24", openAt: OPEN, closeAt: CLOSE },
      invalidTrainingDay: false
    });
    db.close();
    db = null;
    const runtimeState = {
      schema_version: "intraday-runtime.v1",
      instance_id: "dead-instance",
      pid: 987654,
      status: "ready",
      phase: "open",
      session_date: "2026-08-24",
      updated_at: "2026-08-24T18:20:00.000Z"
    };
    fs.writeFileSync(path.join(root, "intraday-runtime.json"), JSON.stringify(runtimeState));
    fs.writeFileSync(path.join(root, "intraday-owner.lock"), JSON.stringify({
      schema_version: "intraday-owner.v1", instance_id: runtimeState.instance_id, pid: runtimeState.pid
    }));

    const staleHeartbeat = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:30:00.000Z"), isProcessAlive: () => true
    });
    assert.equal(staleHeartbeat.status, "heartbeat_stale");
    assert.equal(staleHeartbeat.restart_recommended, false);

    const result = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:30:00.000Z"),
      isProcessAlive: () => false,
      claimRestart: true
    });
    assert.equal(result.status, "failed_detected");
    assert.equal(result.restart_recommended, true);
    assert.ok(result.claim_id);
    assert.equal(fs.existsSync(path.join(root, "intraday-owner.lock")), false);
    const reconciled = JSON.parse(fs.readFileSync(path.join(root, "intraday-runtime.json"), "utf8"));
    assert.equal(reconciled.status, "failed");
    assert.equal(reconciled.invalid_training_day, true);
    assert.equal(reconciled.incomplete_session, true);

    db = openDatabase(config.data.database);
    const stored = getOperationalState(db, "intraday_research:orchestrator_state:v1");
    assert.equal(stored.invalidTrainingDay, true);
    assert.equal(listIntradayEvents(db, { eventType: "training_day_invalidated" }).length, 1);
    db.close();
    db = null;

    const confirmed = settleIntradayWatchdogClaim(config, result.claim_id, {
      confirmed: true,
      at: new Date("2026-08-24T18:30:01.000Z")
    });
    assert.equal(confirmed.restart_attempts, 1);
    const cooldown = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:32:00.000Z"), isProcessAlive: () => false, claimRestart: true
    });
    assert.equal(cooldown.status, "restart_cooldown");
    const next = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:36:00.000Z"), isProcessAlive: () => false, claimRestart: true
    });
    assert.ok(next.claim_id);
    const released = settleIntradayWatchdogClaim(config, next.claim_id, { confirmed: false });
    assert.equal(released.restart_attempts, 1, "a failed Start-ScheduledTask must not consume the restart budget");
    const retry = reconcileIntradayRuntimeState(config, {
      at: new Date("2026-08-24T18:36:01.000Z"), isProcessAlive: () => false
    });
    assert.equal(retry.restart_recommended, true);
  } finally {
    try { db?.close(); } catch { /* Best effort test cleanup. */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unbound cross-day startup failure is owned by the current exchange date without stopping the prior orchestrator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-startup-date-"));
  const config = baseConfig(root);
  const db = openDatabase(config.data.database);
  const priorState = {
    schemaVersion: "ocean-wave-intraday-research.v1",
    revision: 17,
    lastJournalSequence: 0,
    phase: "open",
    session: {
      dateKey: "2026-08-25",
      isTradingDay: true,
      timeZone: "America/New_York",
      openAt: "2026-08-25T13:30:00.000Z",
      closeAt: "2026-08-25T20:00:00.000Z",
      calendarSource: "test",
      startedAt: "2026-08-25T13:30:00.000Z"
    },
    lastMinuteSlot: 100,
    points: { QQQ: [], SPY: [] },
    forecasts: [],
    scores: [],
    missedMaturities: [],
    trajectoryObservations: [],
    channelMessages: [],
    channelProcesses: {},
    summary: null,
    invalidTrainingDay: false,
    warnings: []
  };
  setOperationalState(db, "intraday_research:orchestrator_state:v1", priorState);
  const controlUpdates = [];
  let controlClose = null;
  const authError = Object.assign(new Error("Schwab refresh token expired"), { code: "SCHWAB_REAUTH_REQUIRED" });
  try {
    const runtime = createIntradayRuntime(config, {
      db,
      closeDatabase() {},
      sessionResolver: { async resolve() { throw authError; } },
      sampler: { async sample() { throw new Error("sample must not run before session resolution"); }, async close() {} },
      oceanPool: {
        async start() {},
        async forecast() { throw new Error("forecast must not run before session resolution"); },
        status() { return {}; },
        async close() {}
      },
      channelRunner: { status() { return { active: 0 }; }, async close() {} },
      clock: { now: () => new Date("2026-08-26T13:35:00.000Z") },
      scheduler: { setInterval() { return 1; }, clearInterval() {} },
      controlFactory: () => ({
        instanceId: "current-startup-instance",
        recoveredFailure: null,
        update(status, details = {}) { controlUpdates.push({ status, details }); },
        heartbeat() {},
        close(status, details = {}) { controlClose = { status, details }; }
      }),
      startKeepAwake: () => () => {}
    });

    await assert.rejects(runtime.start(), (error) => error === authError);

    assert.deepEqual(
      getOperationalState(db, "intraday_research:orchestrator_state:v1"),
      priorState,
      "startup cleanup must not mutate the prior trading day's orchestrator state"
    );
    assert.equal(
      listIntradayEvents(db, { sessionDate: "2026-08-25" }).filter((row) => row.event_type === "orchestrator_stopped").length,
      0,
      "startup cleanup must not append a stop event to the prior trading day"
    );
    const todayEvents = listIntradayEvents(db, { sessionDate: "2026-08-26" });
    assert.equal(todayEvents.filter((row) => row.event_type === "startup_failure").length, 1);
    assert.equal(todayEvents.filter((row) => row.event_type === "training_day_invalidated").length, 1);
    const startupPayload = JSON.parse(todayEvents.find((row) => row.event_type === "startup_failure").payload_json);
    assert.equal(startupPayload.incomplete_session, true);
    assert.equal(startupPayload.invalid_training_day, true);
    assert.equal(startupPayload.orchestrator_session_bound, false);
    assert.equal(startupPayload.prior_orchestrator_session_date, "2026-08-25");
    assert.equal(startupPayload.error.code, "SCHWAB_REAUTH_REQUIRED");
    assert.deepEqual(getOperationalState(db, "intraday_research:session_health:v1:2026-08-26"), {
      schema_version: "intraday-session-health.v1",
      session_date: "2026-08-26",
      status: "invalid",
      incomplete_session: true,
      invalid_training_day: true,
      failure_kind: "startup_failure",
      failed_at: "2026-08-26T13:35:00.000Z",
      error: { name: "Error", message: "Schwab token=[redacted]", code: "SCHWAB_REAUTH_REQUIRED" }
    });
    assert.equal(controlUpdates.some((entry) => entry.status === "starting" && entry.details.session_date === "2026-08-26"), true);
    assert.equal(controlClose.status, "failed");
    assert.equal(controlClose.details.session_date, "2026-08-26");
    assert.equal(controlClose.details.phase, "startup_failed");
    assert.equal(controlClose.details.incomplete_session, true);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a periodic fatal tick closes the runtime as failed instead of leaving ready state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-runtime-fatal-"));
  const config = baseConfig(root);
  const db = openDatabase(config.data.database);
  let intervalCallback = null;
  let failTick = false;
  let invalidated = false;
  let phase = "open";
  const session = { dateKey: "2026-08-24", isTradingDay: true, openAt: OPEN, closeAt: CLOSE, calendarSource: "test" };
  const orchestrator = {
    async advance() { if (failTick) throw new Error("fatal tick"); },
    async invalidateTrainingDay() { invalidated = true; },
    async ingestChannelPrediction() {},
    async stop() { phase = "stopped"; },
    snapshot() {
      return {
        phase, session, lastMinuteSlot: 10, forecasts: [], invalidTrainingDay: invalidated
      };
    }
  };
  const noWorkers = { async start() {}, status() { return {}; }, async close() {} };
  try {
    const runtime = createIntradayRuntime(config, {
      db,
      orchestrator,
      sessionResolver: { resolve: async () => ({ ...session }) },
      sampler: { async close() {} },
      oceanPool: noWorkers,
      channelRunner: { status() { return { active: 0 }; }, async close() {} },
      scheduler: {
        setInterval(callback) { intervalCallback = callback; return 1; },
        clearInterval() { intervalCallback = null; }
      },
      startKeepAwake: () => () => {},
      logger: { error() {} }
    });
    await runtime.start();
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "intraday-runtime.json"), "utf8")).status, "ready");
    failTick = true;
    intervalCallback();
    const outcome = await runtime.waitUntilClosed();
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "tick_failed");
    assert.equal(invalidated, true);
    const finalState = JSON.parse(fs.readFileSync(path.join(root, "intraday-runtime.json"), "utf8"));
    assert.equal(finalState.status, "failed");
    assert.equal(finalState.invalid_training_day, true);
  } finally {
    try { db.close(); } catch { /* Runtime normally owns and closes this handle. */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime tick uses lightweight orchestrator status while public status retains a full snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-runtime-status-view-"));
  const config = baseConfig(root);
  const db = openDatabase(config.data.database);
  const session = {
    dateKey: "2026-08-24", isTradingDay: true, timeZone: "America/New_York",
    openAt: OPEN, closeAt: CLOSE, earlyClose: false, calendarSource: "test"
  };
  let phase = "idle";
  let revision = 0;
  let snapshotCalls = 0;
  let statusViewCalls = 0;
  const orchestrator = {
    statusView() {
      statusViewCalls += 1;
      return {
        revision,
        phase,
        session: { ...session, startedAt: OPEN },
        lastMinuteSlot: 1,
        invalidTrainingDay: false
      };
    },
    snapshot() {
      snapshotCalls += 1;
      return {
        ...this.statusView(),
        points: { QQQ: [], SPY: [] },
        forecasts: [],
        scores: []
      };
    },
    async advance() {
      phase = "open";
      revision += 1;
      return this.statusView();
    },
    async ingestChannelPrediction() {},
    async invalidateTrainingDay() {},
    async stop() { phase = "stopped"; }
  };
  const noWorkers = { async start() {}, status() { return {}; }, async close() {} };
  try {
    const runtime = createIntradayRuntime(config, {
      db,
      closeDatabase() {},
      orchestrator,
      sessionResolver: { resolve: async () => ({ ...session }) },
      sampler: { async close() {} },
      oceanPool: noWorkers,
      channelRunner: { status() { return { active: 0 }; }, async close() {} },
      clock: { now: () => new Date("2026-08-24T13:31:02.000Z") },
      scheduler: { setInterval() { return 1; }, clearInterval() {} },
      controlFactory: () => ({ update() {}, heartbeat() {}, close() {} }),
      startKeepAwake: () => () => {}
    });

    await runtime.start();
    const snapshotsAfterStart = snapshotCalls;
    assert.equal(snapshotsAfterStart, 1, "start returns one public full diagnostic snapshot");

    await runtime.tick();
    assert.equal(snapshotCalls, snapshotsAfterStart, "the high-frequency tick path must not deep-clone full state");
    assert.ok(statusViewCalls > 0);

    const diagnostics = runtime.status();
    assert.equal(snapshotCalls, snapshotsAfterStart + 1);
    assert.deepEqual(diagnostics.orchestrator.forecasts, []);
    await runtime.close("test");
  } finally {
    try { db.close(); } catch { /* Runtime may own this handle in other configurations. */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime polls channel_forecast events, starts keep-awake, and safely releases all adapters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intraday-runtime-"));
  const config = baseConfig(root);
  const db = openDatabase(config.data.database);
  const stopped = [];
  let keepAwakeStopped = false;
  let poolClosed = false;
  let channelRunnerClosed = false;
  let controlClose = null;
  try {
    appendIntradayEvent(db, {
      eventKey: "channel-1:open",
      sessionDate: "2026-08-24",
      eventType: "channel_forecast",
      symbol: "QQQ",
      source: "telegram:go_finance",
      eventAt: "2026-08-24T13:31:00.000Z",
      forecastId: "channel-1",
      maturesAt: "2026-08-24T14:01:00.000Z",
      payload: { symbol: "QQQ", direction: "up", horizon_minutes: 30, maturity_policy: "fixed_minutes" }
    });
    const session = {
      dateKey: "2026-08-24", isTradingDay: true, timeZone: "America/New_York",
      openAt: OPEN, closeAt: CLOSE, earlyClose: false, calendarSource: "test"
    };
    const pool = {
      async start() {},
      async forecast({ symbol }) { return { direction: "up", expectedReturn: 0.001, probabilityUp: 0.55, features: {} }; },
      async applyMatureFeedback() { return { status: "shadow" }; },
      status() { return { QQQ: { running: !poolClosed }, SPY: { running: !poolClosed } }; },
      async close() { poolClosed = true; stopped.push("pool"); }
    };
    const channelRunner = {
      async start(request) {
        return { isolatedProcess: true, processRef: "fake:1", handle: "fake:1", forecast: {
          ...request.payload, horizonMinutes: request.payload.horizonMinutes, researchOnly: true
        } };
      },
      async stop() { stopped.push("channel-worker"); },
      status() { return { active: channelRunnerClosed ? 0 : 1 }; },
      async close() { channelRunnerClosed = true; stopped.push("channel-runner"); }
    };
    const sampler = {
      async sample({ symbols, asOf }) {
        return { observedAt: asOf, provider: "schwab", sourceRole: "primary", dataTier: "realtime_underlying", quotes: Object.fromEntries(symbols.map((symbol) => [symbol, {
          price: symbol === "QQQ" ? 700 : 650,
          observedAt: asOf,
          provider: "schwab",
          sourceRole: "primary",
          dataTier: "realtime_underlying",
          features: {}
        }])) };
      },
      async close() { stopped.push("sampler"); }
    };
    const fakeControl = {
      update() {}, heartbeat() {}, close(status, details) { controlClose = { status, details }; stopped.push("control"); }
    };
    const runtime = createIntradayRuntime(config, {
      db,
      closeDatabase: () => stopped.push("db"),
      sessionResolver: { resolve: async () => ({ ...session }) },
      sampler,
      oceanPool: pool,
      channelRunner,
      closeSummarizer: { run: async () => ({ decision: "no_change" }) },
      clock: { now: () => new Date("2026-08-24T13:31:02.000Z") },
      scheduler: { setInterval: () => 7, clearInterval() {} },
      controlFactory: () => fakeControl,
      startKeepAwake: () => () => { keepAwakeStopped = true; }
    });
    await runtime.start();
    assert.equal(runtime.status().orchestrator.forecasts.some((forecast) => forecast.source === "telegram:go_finance"), true);
    await runtime.close("test");
    assert.equal(keepAwakeStopped, true);
    for (const resource of ["pool", "channel-worker", "channel-runner", "sampler", "db", "control"]) assert.ok(stopped.includes(resource));
    assert.deepEqual(controlClose.details.ocean_workers, pool.status());
    assert.deepEqual(controlClose.details.channel_workers, channelRunner.status());
  } finally {
    try { db.close(); } catch { /* Injected close adapter intentionally retained the test DB. */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
