import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedTaskQueue,
  IntradayResearchOrchestrator,
  MemoryIntradayStore,
  buildSolHighCloseRequest,
  compactHorizonPath,
  compactSpectralDiagnostics,
  createUsEquitySessionResolver
} from "../src/intraday-research.js";

test("forecast persistence retains compact causal spectral and horizon features", () => {
  const spectral = compactSpectralDiagnostics({
    schema_version: "intraday_price_features.v1",
    status: "ok",
    power: [1, 5, 2],
    harmonics: [1, 2, 3],
    frequencies: [0.1, 0.2, 0.3],
    periods: [10, 5, 3.333],
    amplitudes: [0.01, 0.02, 0.03],
    phases: [0.1, 0.2, 0.3],
    spectral_entropy: 0.9,
    band_energy_fraction: [0.2, 0.8]
  }, 2);
  assert.equal(spectral.top_components.length, 2);
  assert.equal(spectral.top_components[0].harmonic, 2);
  assert.equal(Object.hasOwn(spectral, "power"), false);
  const path = compactHorizonPath({
    1: { horizon_minutes: 1, integrated_signal: 9, expected_return: 0.001, probability_up: 0.55, return_variance: 0.0001, expected_price: 100 }
  });
  assert.deepEqual(Object.keys(path[1]), ["horizon_minutes", "expected_return", "probability_up", "return_variance"]);
});

const SESSION = Object.freeze({
  dateKey: "2026-08-24",
  isTradingDay: true,
  timeZone: "America/New_York",
  openAt: "2026-08-24T13:30:00.000Z",
  closeAt: "2026-08-24T20:00:00.000Z",
  earlyClose: false,
  calendarSource: "test"
});

function fakeSessionResolver(session = SESSION) {
  return { resolve: async () => ({ ...session }) };
}

function priceAt(symbol, value) {
  const minute = (Date.parse(value) - Date.parse(SESSION.openAt)) / 60_000;
  return (symbol === "QQQ" ? 700 : 650) + minute / 100;
}

function fakeSampler(calls) {
  return {
    async sample({ symbols, asOf, historical = false }) {
      calls.push({ symbols: [...symbols], asOf, historical });
      return {
        observedAt: asOf,
        provider: "schwab",
        dataTier: "realtime",
        quotes: Object.fromEntries(symbols.map((symbol) => [symbol, {
          price: priceAt(symbol, asOf),
          observedAt: asOf,
          provider: "schwab",
          dataTier: "realtime"
        }]))
      };
    }
  };
}

function fakePredictor(calls) {
  return {
    async forecast(request) {
      calls.push(request);
      await Promise.resolve();
      return {
        direction: "up",
        expectedReturn: 0.0004,
        probabilityUp: 0.55,
        modelVersion: "test-v1"
      };
    }
  };
}

function makeOrchestrator({
  store = new MemoryIntradayStore(),
  session = SESSION,
  sampleCalls = [],
  predictionCalls = [],
  ...overrides
} = {}) {
  return {
    store,
    sampleCalls,
    predictionCalls,
    orchestrator: new IntradayResearchOrchestrator({
      sessionResolver: fakeSessionResolver(session),
      sampler: fakeSampler(sampleCalls),
      predictor: fakePredictor(predictionCalls),
      store,
      clock: { now: () => new Date("2026-08-24T20:00:00.000Z") },
      ...overrides
    })
  };
}

test("recovery compacts legacy forecast spectra and trajectory payloads out of operational state", () => {
  const store = new MemoryIntradayStore({
    schemaVersion: "ocean-wave-intraday-research.v1",
    phase: "closed",
    forecasts: [{
      forecastId: "legacy-forecast",
      prediction: {
        features: {
          spectralDiagnostics: {
            status: "ok",
            power: [1, 9],
            harmonics: [1, 2],
            frequencies: [0.1, 0.2],
            periods: [10, 5],
            amplitudes: [0.01, 0.02],
            phases: [0, 1]
          },
          horizonPath: { 30: { horizon_minutes: 30, expected_return: 0.001, integrated_signal: 99 } }
        }
      }
    }],
    trajectoryObservations: [{
      observationId: "legacy-observation",
      forecastId: "legacy-forecast",
      symbol: "QQQ",
      observedAt: SESSION.closeAt,
      result: { large_repeated_payload: "discard-after-journal-append" }
    }],
    summary: {
      status: "completed",
      request: { repeated_full_session_evidence: [1, 2, 3] },
      result: { decision: "collect_more_data" }
    }
  });
  const state = makeOrchestrator({ store }).orchestrator.snapshot();

  assert.equal(Object.hasOwn(state.forecasts[0].prediction.features.spectralDiagnostics, "power"), false);
  assert.equal(state.forecasts[0].prediction.features.spectralDiagnostics.top_components[0].harmonic, 2);
  assert.equal(Object.hasOwn(state.forecasts[0].prediction.features.horizonPath[30], "integrated_signal"), false);
  assert.equal(Object.hasOwn(state.trajectoryObservations[0], "result"), false);
  assert.equal(Object.hasOwn(state.summary, "request"), false);
  assert.equal(state.summary.result.decision, "collect_more_data");
});

test("opens once, samples QQQ/SPY in one synchronized call, and issues an immutable forecast pair", async () => {
  const fixture = makeOrchestrator();
  await fixture.orchestrator.advance(SESSION.openAt);
  await fixture.orchestrator.advance(SESSION.openAt);
  const state = fixture.orchestrator.snapshot();

  assert.equal(state.phase, "open");
  assert.equal(fixture.sampleCalls.length, 1);
  assert.deepEqual(fixture.sampleCalls[0].symbols, ["QQQ", "SPY"]);
  assert.equal(state.points.QQQ.length, 1);
  assert.equal(state.points.SPY.length, 1);
  assert.equal(fixture.predictionCalls.length, 2);
  assert.equal(state.forecasts.length, 2);
  assert.deepEqual(new Set(state.forecasts.map((item) => item.symbol)), new Set(["QQQ", "SPY"]));
  assert.ok(state.forecasts.every((item) => item.horizonMinutes === 30 && item.immutable && item.researchOnly));
  assert.equal(fixture.store.events.filter((event) => event.eventType === "forecast_created").length, 2);
  for (const event of fixture.store.events) {
    assert.ok(event.eventKey);
    assert.ok("sessionDate" in event);
    assert.ok("eventType" in event);
    assert.ok("symbol" in event);
    assert.ok("source" in event);
    assert.ok("eventAt" in event);
    assert.ok("forecastId" in event);
    assert.ok("maturesAt" in event);
    assert.ok("payload" in event);
  }
});

test("advance returns an isolated lightweight status view while snapshot retains full diagnostics", async () => {
  const fixture = makeOrchestrator();
  const status = await fixture.orchestrator.advance(SESSION.openAt);

  assert.equal(status.phase, "open");
  assert.equal(status.session.dateKey, SESSION.dateKey);
  assert.equal(Object.hasOwn(status, "points"), false);
  assert.equal(Object.hasOwn(status, "forecasts"), false);
  assert.equal(Object.hasOwn(status, "scores"), false);

  const snapshot = fixture.orchestrator.snapshot();
  assert.equal(snapshot.points.QQQ.length, 1);
  assert.equal(snapshot.forecasts.length, 2);

  status.session.dateKey = "tampered";
  assert.equal(fixture.orchestrator.statusView().session.dateKey, SESSION.dateKey);
  assert.equal(fixture.orchestrator.snapshot().session.dateKey, SESSION.dateKey);
});

test("a live catch-up forecast is issued at the latest synchronized quote time, not the minute anchor", async () => {
  const predictionCalls = [];
  const fixture = makeOrchestrator({
    predictionCalls,
    sampler: {
      async sample({ symbols, asOf }) {
        return {
          observedAt: new Date(Date.parse(asOf) + 2_200).toISOString(),
          provider: "schwab",
          dataTier: "realtime",
          quotes: Object.fromEntries(symbols.map((symbol, index) => [symbol, {
            price: symbol === "QQQ" ? 700 : 650,
            observedAt: new Date(Date.parse(asOf) + 2_100 + index * 100).toISOString(),
            provider: "schwab",
            dataTier: "realtime"
          }]))
        };
      }
    }
  });
  await fixture.orchestrator.advance("2026-08-24T13:37:30.000Z");
  const state = fixture.orchestrator.snapshot();
  assert.equal(predictionCalls.length, 2);
  assert.ok(predictionCalls.every((request) => request.issuedAt === "2026-08-24T13:37:02.200Z"));
  assert.ok(state.forecasts.every((forecast) => forecast.issuedAt === "2026-08-24T13:37:02.200Z"));
  assert.ok(state.forecasts.every((forecast) => forecast.reason === "opening_catchup"));
});

test("records one-minute trajectory points, scores each maturity once, then starts the next 30-minute batch", async () => {
  const trajectory = [];
  const learned = [];
  const fixture = makeOrchestrator({
    trajectoryObserver: { observe: async (item) => { trajectory.push(item); return { residual: 0.01 }; } },
    matureLearner: { learn: async (item) => { learned.push(item); return { applied: true }; } }
  });

  await fixture.orchestrator.advance("2026-08-24T13:30:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T13:31:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T14:00:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T14:00:00.000Z");
  const state = fixture.orchestrator.snapshot();

  assert.equal(state.points.QQQ.length, 31);
  assert.equal(state.points.SPY.length, 31);
  assert.equal(state.scores.length, 2);
  assert.equal(new Set(state.scores.map((item) => item.forecastId)).size, 2);
  assert.ok(state.scores.every((item) => Number.isFinite(item.brier)
    && Number.isFinite(item.logLoss) && Number.isFinite(item.huber)));
  assert.ok(state.scores.every((item) => item.trainingPolicy === "proper_losses_brier_logloss_huber_lognormal_pinball_cost.v2"
    && item.presentationOnly.includes("total")));
  assert.equal(learned.length, 2);
  assert.ok(learned.every((item) => item.mature === true && item.mode === "bounded_shadow"));
  assert.equal(state.forecasts.length, 4);
  assert.equal(fixture.predictionCalls.length, 4);
  assert.ok(trajectory.length >= 4);
  assert.ok(trajectory.every((item) => item.mutateForecast === false && item.mode === "shadow_trajectory_only"));
});

test("a stale reconstructed maturity point is marked missed and never learned", async () => {
  const learned = [];
  const fixture = makeOrchestrator({
    matureLearner: { learn: async (item) => learned.push(item) },
    sampler: {
      async sample({ symbols, asOf }) {
        const observedAt = asOf === "2026-08-24T13:30:00.000Z" ? asOf : "2026-08-24T14:05:00.000Z";
        return {
          observedAt,
          quotes: Object.fromEntries(symbols.map((symbol) => [symbol, {
            price: symbol === "QQQ" ? 700 : 650,
            observedAt,
            provider: "schwab",
            dataTier: "historical_1m"
          }]))
        };
      }
    }
  });
  await fixture.orchestrator.advance("2026-08-24T13:30:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T14:05:00.000Z");
  const state = fixture.orchestrator.snapshot();
  assert.equal(state.scores.length, 0);
  assert.equal(state.missedMaturities.length, 2);
  assert.equal(learned.length, 0);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "forecast_maturity_missed").length, 2);
});

test("fills a short two-minute disconnect in slot order and never creates a retrospective forecast", async () => {
  const fixture = makeOrchestrator();
  await fixture.orchestrator.advance("2026-08-24T13:30:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T13:33:00.000Z");
  const state = fixture.orchestrator.snapshot();
  assert.deepEqual(fixture.sampleCalls.map((call) => call.asOf), [
    "2026-08-24T13:30:00.000Z",
    "2026-08-24T13:31:00.000Z",
    "2026-08-24T13:32:00.000Z",
    "2026-08-24T13:33:00.000Z"
  ]);
  assert.deepEqual(fixture.sampleCalls.map((call) => call.historical), [false, true, true, false]);
  assert.equal(state.points.QQQ.length, 4);
  assert.equal(state.lastMinuteSlot, 3);
  assert.equal(state.forecasts.length, 2);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "historical_minute_sample_batch").length, 2);
});

test("does not issue an opening catch-up forecast that would mature after the official close", async () => {
  const fixture = makeOrchestrator();
  await fixture.orchestrator.advance("2026-08-24T19:31:00.000Z");
  const state = fixture.orchestrator.snapshot();
  assert.equal(state.points.QQQ.length, 1);
  assert.equal(state.points.SPY.length, 1);
  assert.equal(state.forecasts.length, 0);
  assert.equal(fixture.predictionCalls.length, 0);
});

test("recovers state and will not duplicate an already sampled minute or scored forecast", async () => {
  const store = new MemoryIntradayStore();
  const first = makeOrchestrator({ store });
  await first.orchestrator.advance("2026-08-24T13:30:00.000Z");
  await first.orchestrator.advance("2026-08-24T14:00:00.000Z");
  const originalEventCount = store.events.length;
  const second = makeOrchestrator({ store });
  await second.orchestrator.advance("2026-08-24T14:00:00.000Z");
  const state = second.orchestrator.snapshot();
  assert.equal(state.scores.length, 2);
  assert.equal(state.forecasts.length, 4);
  assert.equal(store.events.length, originalEventCount);
});

test("requires a separate channel process, scores a relevant channel forecast, and releases it", async () => {
  const started = [];
  const stopped = [];
  const runner = {
    async start(request) {
      started.push(request);
      return {
        isolatedProcess: true,
        processRef: "worker-42",
        handle: { id: 42 },
        forecast: { symbol: "QQQ", horizonMinutes: 29, direction: "up", expectedReturn: 0.001, probabilityUp: 0.6 }
      };
    },
    async stop(handle, details) { stopped.push({ handle, details }); }
  };
  const fixture = makeOrchestrator({ channelProcessRunner: runner });
  await fixture.orchestrator.advance("2026-08-24T13:30:00.000Z");
  const forecast = await fixture.orchestrator.ingestChannelPrediction({
    channel: "Go Finance",
    messageId: "2059",
    publishedAt: "2026-08-24T13:31:00.000Z",
    payload: { textHash: "abc" }
  });
  await fixture.orchestrator.advance("2026-08-24T14:00:00.000Z");
  const state = fixture.orchestrator.snapshot();

  assert.equal(started.length, 1);
  assert.equal(started[0].isolatedProcessRequired, true);
  assert.equal(forecast.source, "telegram:Go Finance");
  assert.equal(state.scores.filter((score) => score.source === "telegram:Go Finance").length, 1);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].details.reason, "forecast_scored");
  assert.equal(state.channelProcesses[forecast.forecastId].status, "stopped");
});

test("early close hook triggers a Sol-high, research-only summary with leakage-safe Fourier guidance", async () => {
  const earlySession = { ...SESSION, closeAt: "2026-08-24T17:00:00.000Z", earlyClose: true };
  const requests = [];
  const fixture = makeOrchestrator({
    session: earlySession,
    closeSummarizer: { run: async (request) => { requests.push(request); return { conclusion: "keep_shadow" }; } }
  });
  await fixture.orchestrator.advance("2026-08-24T13:30:00.000Z");
  await fixture.orchestrator.advance("2026-08-24T17:00:00.000Z");
  const state = fixture.orchestrator.snapshot();

  assert.equal(state.phase, "closed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, "sol");
  assert.equal(requests[0].reasoningEffort, "high");
  assert.equal(requests[0].researchOnly, true);
  assert.match(requests[0].method.fourierPolicy, /Detrend.*window.*leakage-safe FFT/i);
  assert.ok(requests[0].prohibitedActions.includes("place_order"));
  assert.equal(state.summary.status, "completed");
  assert.equal(fixture.predictionCalls.length, 2, "the after-close advance must not issue catch-up forecasts");
  assert.equal(fixture.store.events.filter((event) => event.eventType === "close_sample_batch").length, 1);
  await fixture.orchestrator.stop();
  assert.equal(fixture.orchestrator.snapshot().phase, "closed", "resource shutdown must preserve a completed close");
});

test("a failed Sol close is fatal, auditable, and retryable without another close sample or forecast", async () => {
  let attempts = 0;
  const fixture = makeOrchestrator({
    closeSummarizer: {
      async run() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary Sol failure");
        return { conclusion: "keep_shadow" };
      }
    }
  });
  await fixture.orchestrator.advance(SESSION.openAt);
  await assert.rejects(fixture.orchestrator.advance(SESSION.closeAt), /Sol high close summary failed/);
  let state = fixture.orchestrator.snapshot();
  assert.equal(state.phase, "closing");
  assert.equal(state.summary.status, "failed");
  assert.equal(fixture.store.events.filter((event) => event.eventType === "sol_high_summary_failed").length, 1);

  await fixture.orchestrator.advance("2026-08-24T20:01:00.000Z");
  state = fixture.orchestrator.snapshot();
  assert.equal(state.phase, "closed");
  assert.equal(state.summary.status, "completed");
  assert.equal(state.summary.attempts, 2);
  assert.equal(fixture.sampleCalls.filter((call) => call.asOf === SESSION.closeAt).length, 1);
  assert.equal(fixture.predictionCalls.length, 2, "close retry must never backfill a prediction");
});

test("an exhausted invalid Sol review is archived and the after-close session exits normally", async () => {
  const fixture = makeOrchestrator({
    closeSummarizer: {
      async run(request) {
        return {
          schema_version: "intraday-sol.v1",
          report_date: request.sessionDate,
          review_status: "degraded",
          decision: "collect_more_data",
          candidate_change: null,
          degradation: { code: "invalid_schema", reason: "decision must be a JSON string" },
          deployment_status: "proposal_only",
          applied_to_production: false
        };
      }
    }
  });
  await fixture.orchestrator.advance(SESSION.openAt);
  await fixture.orchestrator.advance(SESSION.closeAt);
  const state = fixture.orchestrator.snapshot();
  assert.equal(state.phase, "closed");
  assert.equal(state.summary.status, "completed_degraded");
  assert.equal(state.summary.result.decision, "collect_more_data");
  assert.equal(state.summary.result.applied_to_production, false);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "sol_high_summary_failed").length, 1);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "sol_high_summary_degraded").length, 1);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "session_closed").length, 1);
  assert.equal(fixture.sampleCalls.filter((call) => call.asOf === SESSION.closeAt).length, 1);
  assert.equal(fixture.predictionCalls.length, 2, "degraded close must never backfill a prediction");
});

test("training-day invalidation is durable and included in the Sol eligibility evidence", async () => {
  const fixture = makeOrchestrator();
  await fixture.orchestrator.advance(SESSION.openAt);
  const result = await fixture.orchestrator.invalidateTrainingDay({ reason: "unexpected_process_exit" });
  const state = fixture.orchestrator.snapshot();
  const request = buildSolHighCloseRequest(state);
  assert.equal(result.invalidated, true);
  assert.equal(state.invalidTrainingDay, true);
  assert.equal(request.trainingDayEligible, false);
  assert.equal(request.evidence.trainingDay.invalidReason, "unexpected_process_exit");
  assert.equal(fixture.store.events.filter((event) => event.eventType === "training_day_invalidated").length, 1);
});

test("an invalid training day still scores forecasts but never applies mature feedback", async () => {
  const learned = [];
  const fixture = makeOrchestrator({
    matureLearner: { learn: async (item) => { learned.push(item); return { applied: true }; } }
  });
  await fixture.orchestrator.advance(SESSION.openAt);
  await fixture.orchestrator.invalidateTrainingDay({ reason: "missing_opening_data" });
  await fixture.orchestrator.advance("2026-08-24T14:00:00.000Z");
  const state = fixture.orchestrator.snapshot();
  assert.equal(state.scores.length, 2);
  assert.equal(learned.length, 0);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "mature_forecast_learned").length, 0);
  assert.equal(fixture.store.events.filter((event) => event.eventType === "mature_forecast_learning_skipped").length, 2);
});

test("Sol request keeps Ocean Wave and channel metrics separate", () => {
  const request = buildSolHighCloseRequest({
    session: { dateKey: "2026-08-24" },
    points: { QQQ: [], SPY: [] },
    forecasts: [],
    trajectoryObservations: [],
    channelMessages: [],
    scores: [
      { source: "ocean_wave", total: 80, predictedDirection: "up", actualDirection: "up", brier: 0.1, absoluteReturnError: 0.001 },
      { source: "telegram:Go Finance", total: 20, predictedDirection: "down", actualDirection: "up", brier: 0.5, absoluteReturnError: 0.004 }
    ]
  });
  assert.equal(request.evidence.sourceMetrics.ocean_wave.meanScore, 80);
  assert.equal(request.evidence.sourceMetrics["telegram:Go Finance"].meanScore, 20);
  assert.equal(request.evidence.sourceMetrics.ocean_wave.directionAccuracy, 1);
  assert.equal(request.evidence.sourceMetrics["telegram:Go Finance"].directionAccuracy, 0);
});

test("bounded queue deduplicates keys and rejects overflow without growing indefinitely", async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const queue = new BoundedTaskQueue({ concurrency: 1, maximumPending: 1 });
  const first = queue.add("first", async () => blocker);
  const duplicate = await queue.add("first", async () => "never");
  const second = queue.add("second", async () => "second");
  await assert.rejects(queue.add("third", async () => "third"), { code: "QUEUE_FULL" });
  assert.equal(duplicate.deduplicated, true);
  release("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await queue.close();
});

test("session resolver honors an injected early-close calendar in exchange timezone", async () => {
  const resolver = createUsEquitySessionResolver({
    calendar: async () => ({ isTradingDay: true, open: "09:30", close: "13:00", earlyClose: true, source: "exchange-test" })
  });
  const session = await resolver.resolve("2026-11-27T15:00:00.000Z");
  assert.equal(session.dateKey, "2026-11-27");
  assert.equal(session.openAt, "2026-11-27T14:30:00.000Z");
  assert.equal(session.closeAt, "2026-11-27T18:00:00.000Z");
  assert.equal(session.earlyClose, true);
  assert.equal(session.calendarSource, "exchange-test");
});
