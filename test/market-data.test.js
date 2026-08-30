import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMarketSnapshot,
  createMarketDataRuntime,
  isAlignedSnapshot,
  isScorableOptionSnapshot,
  parseFidelityQuoteTime,
  snapshotLagSeconds
} from "../src/market-data.js";

const config = {
  __root: process.cwd(),
  marketData: {
    primary: "schwab",
    crossCheck: ["fidelity_web"],
    fallback: ["fidelity_web"],
    maxLiveLagSeconds: 300,
    validation: { maxUnderlyingDifferenceBps: 25, maxCrossCheckTimeSkewSeconds: 90 }
  }
};

function providerSnapshot(provider, price, publishedAt, observedAt = publishedAt) {
  return {
    schema_version: "ocean-wave-snapshot.v2",
    provider,
    data_tier: provider === "schwab" ? "realtime" : "realtime_underlying",
    signal_published_at: publishedAt,
    observed_at: observedAt,
    as_of: observedAt,
    captured_at: observedAt,
    execution_eligible: false,
    market_state: provider === "schwab" ? { spot: price } : { underlying_price: price },
    target_contract: provider === "schwab" ? { matched: { quote_timestamp: observedAt } } : null
  };
}

test("historical messages never receive current quotes", async () => {
  let calls = 0;
  const snapshot = await captureMarketSnapshot(
    config,
    { contract: { symbol: "AAPL" } },
    "2020-01-02T15:30:00.000Z",
    { providers: { schwab: async () => { calls += 1; }, fidelity_web: async () => { calls += 1; } } }
  );
  assert.equal(snapshot.data_tier, "text_only");
  assert.match(snapshot.missing_reason, /Historical point-in-time/);
  assert.equal(snapshot.execution_eligible, false);
  assert.equal(calls, 0);
});

test("unconfigured primary provider degrades safely", async () => {
  const snapshot = await captureMarketSnapshot(
    { ...config, marketData: { primary: "none" } },
    { contract: { symbol: "AAPL" } },
    new Date().toISOString()
  );
  assert.equal(snapshot.provider, "none");
  assert.equal(snapshot.data_tier, "text_only");
});

test("Fidelity quote time is converted from Eastern time with DST", () => {
  assert.equal(parseFidelityQuoteTime("12:55:00PM ET 08/18/2026"), "2026-08-18T16:55:00.000Z");
  assert.equal(parseFidelityQuoteTime("09:30:00AM ET 01/15/2026"), "2026-01-15T14:30:00.000Z");
});

test("Fidelity web captures a timestamped underlying quote only", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => `
      <span class="main-number">$339.55</span>
      <span class="change">0.25&nbsp;(0.07%)</span>
      <div class="time-stamp">AS OF 12&#58;55&#58;00PM ET 08&#47;18&#47;2026<sup>&#134;</sup></div>
      <p class="bav-header">Bid</p><p class="bav-value">339.47 X 80</p>
      <p class="bav-header ">Ask</p><p class="bav-value">339.53 X 80</p>
      <p class="bav-header ">Vol</p><p class="bav-value">16,947,407</p>
      <a>Log in</a></span> to find and filter single- and multi-leg options
    `
  });
  try {
    const snapshot = await captureMarketSnapshot(
      { ...config, marketData: { primary: "fidelity_web", maxLiveLagSeconds: 300 } },
      { contract: { symbol: "TSLA", strike: 350, option_type: "call" } },
      new Date().toISOString()
    );
    assert.equal(snapshot.provider, "fidelity_web");
    assert.equal(snapshot.data_tier, "realtime_underlying");
    assert.equal(snapshot.market_state.underlying_price, 339.55);
    assert.equal(snapshot.market_state.bid, 339.47);
    assert.equal(snapshot.market_state.ask, 339.53);
    assert.equal(snapshot.observed_at, "2026-08-18T16:55:00.000Z");
    assert.equal(snapshot.target_contract, null);
    assert.equal(snapshot.execution_eligible, false);
    assert.equal(snapshot.fidelity.login_required_for_options_chain, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Schwab primary and Fidelity cross-check start concurrently", async () => {
  const publishedAt = new Date().toISOString();
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => { started.push("schwab"); await gate; return providerSnapshot("schwab", 767.40, publishedAt); },
      fidelity_web: async () => { started.push("fidelity_web"); await gate; return providerSnapshot("fidelity_web", 767.42, publishedAt); }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["fidelity_web", "schwab"]);
  release();
  const snapshot = await pending;
  assert.equal(snapshot.provider, "schwab");
  assert.equal(snapshot.source_role, "primary");
  assert.equal(snapshot.cross_validation.status, "pass");
  assert.ok(snapshot.cross_validation.checks[0].difference_bps < 1);
});

test("a time-skewed Fidelity quote cannot pass cross-validation", async () => {
  const publishedAt = new Date().toISOString();
  const fidelityObservedAt = new Date(Date.parse(publishedAt) - 120_000).toISOString();
  const snapshot = await captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => providerSnapshot("schwab", 767.40, publishedAt),
      fidelity_web: async () => providerSnapshot("fidelity_web", 767.40, publishedAt, fidelityObservedAt)
    }
  });
  assert.equal(snapshot.provider, "schwab");
  assert.equal(snapshot.cross_validation.status, "stale");
  assert.equal(snapshot.cross_validation.checks[0].status, "stale");
  assert.equal(snapshot.cross_validation.checks[0].time_skew_seconds, 120);
  assert.equal(snapshot.cross_validation.checks[0].max_time_skew_seconds, 90);
  assert.equal("difference_bps" in snapshot.cross_validation.checks[0], false);
});

test("Fidelity becomes a non-executable fallback when Schwab fails", async () => {
  const publishedAt = new Date().toISOString();
  const snapshot = await captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => { throw new Error("temporary Schwab outage"); },
      fidelity_web: async () => providerSnapshot("fidelity_web", 767.42, publishedAt)
    }
  });
  assert.equal(snapshot.provider, "fidelity_web");
  assert.equal(snapshot.source_role, "fallback");
  assert.equal(snapshot.primary_provider, "schwab");
  assert.equal(snapshot.data_tier, "realtime_underlying");
  assert.equal(snapshot.execution_eligible, false);
  assert.equal(snapshot.failover.option_contract_validation_available, false);
  assert.match(snapshot.failover.reason, /temporary Schwab outage/);
});

test("a Fidelity fallback outside the signal-time window is rejected", async () => {
  const publishedAt = new Date().toISOString();
  const fidelityObservedAt = new Date(Date.parse(publishedAt) - 301_000).toISOString();
  const snapshot = await captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => { throw new Error("temporary Schwab outage"); },
      fidelity_web: async () => providerSnapshot("fidelity_web", 767.42, publishedAt, fidelityObservedAt)
    }
  });
  assert.equal(snapshot.data_tier, "text_only");
  assert.equal(snapshot.source_role, "unavailable");
  const fidelityAttempt = snapshot.provider_attempts.find((item) => item.provider === "fidelity_web");
  assert.equal(fidelityAttempt.status, "stale");
  assert.equal(fidelityAttempt.lag_seconds, 301);
  assert.match(snapshot.missing_reason, /Fidelity|fidelity_web/i);
});

test("Schwab remains primary when Fidelity validation is unavailable", async () => {
  const publishedAt = new Date().toISOString();
  const snapshot = await captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => providerSnapshot("schwab", 767.40, publishedAt),
      fidelity_web: async () => { throw new Error("Fidelity unavailable"); }
    }
  });
  assert.equal(snapshot.provider, "schwab");
  assert.equal(snapshot.cross_validation.status, "unavailable");
  assert.equal(snapshot.cross_validation.checks[0].provider, "fidelity_web");
});

test("a slow Fidelity cross-check cannot hold a successful Schwab quote past the bounded grace period", async () => {
  const publishedAt = new Date().toISOString();
  let aborted = false;
  const startedAt = performance.now();
  const snapshot = await captureMarketSnapshot({
    ...config,
    marketData: { ...config.marketData, crossCheckWaitMilliseconds: 15 }
  }, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => providerSnapshot("schwab", 767.40, publishedAt),
      fidelity_web: async (_config, _luna, _symbol, _publishedAt, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          reject(context.signal.reason);
        }, { once: true });
      })
    }
  });
  const elapsed = performance.now() - startedAt;
  assert.equal(snapshot.provider, "schwab");
  assert.equal(snapshot.cross_validation.status, "unavailable");
  assert.match(snapshot.cross_validation.checks[0].reason, /did not finish/);
  assert.equal(snapshot.provider_attempts.find((item) => item.provider === "fidelity_web").status, "timeout");
  assert.equal(aborted, true);
  assert.ok(elapsed < 250, `bounded cross-check took ${elapsed}ms`);
});

test("the production Fidelity HTTP adapter receives grace-period cancellation", async () => {
  const publishedAt = new Date().toISOString();
  let fetchAborted = false;
  const snapshot = await captureMarketSnapshot({
    ...config,
    marketData: { ...config.marketData, crossCheckWaitMilliseconds: 5 }
  }, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => providerSnapshot("schwab", 767.40, publishedAt)
    },
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        fetchAborted = true;
        reject(signal.reason);
      }, { once: true });
    })
  });
  assert.equal(snapshot.provider, "schwab");
  assert.equal(fetchAborted, true);
  assert.equal(snapshot.provider_attempts.find((item) => item.provider === "fidelity_web").status, "timeout");
});

test("a late Fidelity rejection after the grace period remains handled", async () => {
  const publishedAt = new Date().toISOString();
  let rejectFidelity;
  const fidelity = new Promise((_resolve, reject) => { rejectFidelity = reject; });
  const snapshot = await captureMarketSnapshot({
    ...config,
    marketData: { ...config.marketData, crossCheckWaitMilliseconds: 5 }
  }, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => providerSnapshot("schwab", 767.40, publishedAt),
      fidelity_web: async () => fidelity
    }
  });
  assert.equal(snapshot.provider, "schwab");
  rejectFidelity(new Error("late Fidelity failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshot.cross_validation.status, "unavailable");
});

test("a failed Schwab primary fully awaits Fidelity fallback beyond the cross-check grace", async () => {
  const publishedAt = new Date().toISOString();
  const startedAt = performance.now();
  let fallbackSignal;
  const snapshot = await captureMarketSnapshot({
    ...config,
    marketData: { ...config.marketData, crossCheckWaitMilliseconds: 5 }
  }, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => { throw new Error("Schwab unavailable"); },
      fidelity_web: async (_config, _luna, _symbol, _publishedAt, context) => {
        fallbackSignal = context.signal;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return providerSnapshot("fidelity_web", 767.42, publishedAt);
      }
    }
  });
  const elapsed = performance.now() - startedAt;
  assert.equal(snapshot.provider, "fidelity_web");
  assert.equal(snapshot.source_role, "fallback");
  assert.equal(fallbackSignal.aborted, false);
  assert.ok(elapsed >= 20, `fallback returned before its provider settled (${elapsed}ms)`);
});

test("both providers failing produces a text-only snapshot", async () => {
  const publishedAt = new Date().toISOString();
  const snapshot = await captureMarketSnapshot(config, { contract: { symbol: "SPY" } }, publishedAt, {
    providers: {
      schwab: async () => { throw new Error("Schwab unavailable"); },
      fidelity_web: async () => { throw new Error("Fidelity unavailable"); }
    }
  });
  assert.equal(snapshot.data_tier, "text_only");
  assert.equal(snapshot.provider_attempts.length, 2);
});

test("alignment uses the source quote timestamp, never a copied signal time", () => {
  const publishedAt = "2026-08-18T16:44:13.000Z";
  const snapshot = {
    as_of: publishedAt,
    captured_at: "2026-08-18T16:44:20.000Z",
    target_contract: { matched: { quote_timestamp: "2026-08-18T16:44:43.000Z" } }
  };
  assert.equal(snapshotLagSeconds(snapshot, publishedAt), 30);
  assert.equal(isAlignedSnapshot(snapshot, publishedAt, 300), true);
  assert.equal(isAlignedSnapshot({ captured_at: "2026-08-18T17:25:28.000Z", as_of: publishedAt }, publishedAt, 300), false);
});

test("only an exact, aligned Schwab option contract can be scored", () => {
  const publishedAt = "2026-08-18T16:44:13.000Z";
  const snapshot = {
    data_tier: "realtime",
    captured_at: "2026-08-18T16:44:14.000Z",
    target_contract: {
      matched: { quote_timestamp: "2026-08-18T16:44:13.500Z", bid: 1.1, ask: 1.2 },
      exact_expiry_match: true,
      exact_strike_match: true,
      exact_option_type_match: true
    },
    contract_assessment: { decision: "support" }
  };
  assert.equal(isScorableOptionSnapshot(snapshot, publishedAt), true);
  assert.equal(isScorableOptionSnapshot({ ...snapshot, data_tier: "realtime_underlying" }, publishedAt), false);
  assert.equal(isScorableOptionSnapshot({ ...snapshot, target_contract: { ...snapshot.target_contract, exact_strike_match: false } }, publishedAt), false);
  assert.equal(isScorableOptionSnapshot({ ...snapshot, contract_assessment: { decision: "abstain" } }, publishedAt), false);
});

test("single-shot context capture invokes the quote-only adapter", async () => {
  const publishedAt = new Date().toISOString();
  let invocation;
  const runtimeConfig = {
    ...config,
    marketData: {
      ...config.marketData,
      crossCheck: [],
      fallback: [],
      python: process.execPath,
      script: "package.json"
    }
  };
  const snapshot = await captureMarketSnapshot(runtimeConfig, {
    contract: { symbol: "SPY" },
    human_interpretation_context_only: true
  }, publishedAt, {
    getSchwabAccessToken: async () => "environment-only-token",
    execFile: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: JSON.stringify(providerSnapshot("schwab", 700, publishedAt)) };
    }
  });
  assert.equal(snapshot.provider, "schwab");
  assert.ok(invocation.args.includes("--quote-only"));
  assert.equal(invocation.args.includes("--horizons"), false);
  assert.equal(invocation.args.includes("--strike-count"), false);
  assert.equal(invocation.args.includes(invocation.options.env.SCHWAB_ACCESS_TOKEN), false);
});

test("market runtime prewarms one worker and passes tokens over its input pipe", async () => {
  const calls = [];
  let tokenCalls = 0;
  const publishedAt = new Date().toISOString();
  const worker = {
    start: async () => { calls.push("start"); return { native_core: true }; },
    request: async (request) => {
      calls.push({ request });
      if (request.command === "feedback") return { status: "updated", deployment_status: "shadow_only" };
      if (request.command === "intraday_features") return { status: "ok", source: "ocean_wave_cpp" };
      return providerSnapshot("schwab", 700, request.signal_published_at);
    },
    close: async () => { calls.push("close"); }
  };
  const runtimeConfig = {
    ...config,
    marketData: {
      ...config.marketData,
      crossCheck: [],
      fallback: [],
      python: process.execPath,
      workerScript: "package.json"
    }
  };
  const runtime = createMarketDataRuntime(runtimeConfig, {
    worker,
    getSchwabAccessToken: async () => { tokenCalls += 1; return "pipe-only-token"; },
    intradayFeatureCapture: async () => ({
      features: { minutes_from_open: 30, minutes_to_close_total: 360 },
      provenance: { schema_version: "causal-intraday-features.v1", market_phase: "regular" }
    })
  });
  await runtime.start();
  assert.equal(tokenCalls, 0, "worker startup must not depend on Schwab authorization");
  const snapshot = await runtime.capture(runtimeConfig, { contract: { symbol: "SPY" } }, publishedAt);
  const contextSnapshot = await runtime.capture(runtimeConfig, {
    contract: { symbol: "SPY" },
    human_interpretation_context_only: true
  }, publishedAt);
  const feedback = await runtime.applyFeedback({ event_id: "position-1" });
  const features = await runtime.intradayFeatures([700, 701, 702], { maxHarmonics: 8 });
  await runtime.close();
  assert.equal(snapshot.provider, "schwab");
  assert.equal(contextSnapshot.provider, "schwab");
  assert.equal(calls[0], "start");
  assert.equal(calls[1].request.command, "quote");
  assert.equal(calls[1].request.access_token, "pipe-only-token");
  assert.equal(calls[2].request.command, "predict");
  assert.equal(calls[2].request.market_state_overrides.minutes_from_open, 30);
  assert.equal(calls[3].request.command, "quote");
  assert.equal(calls[3].request.access_token, "pipe-only-token");
  assert.equal("horizons" in calls[3].request, false);
  assert.equal("strike_count" in calls[3].request, false);
  assert.equal("expiry" in calls[3].request, false);
  assert.equal("strike" in calls[3].request, false);
  assert.equal("option_type" in calls[3].request, false);
  assert.equal(calls[4].request.command, "feedback");
  assert.equal(feedback.deployment_status, "shadow_only");
  assert.equal(calls[5].request.command, "intraday_features");
  assert.deepEqual(calls[5].request.prices, [700, 701, 702]);
  assert.equal(calls[5].request.max_harmonics, 8);
  assert.equal(features.source, "ocean_wave_cpp");
  assert.equal(tokenCalls, 2, "each live capture obtains credentials lazily through the cached provider");
  assert.equal(calls.at(-1), "close");
});

test("market runtime starts when Schwab authorization needs renewal", async () => {
  let starts = 0;
  const runtime = createMarketDataRuntime({
    ...config,
    marketData: {
      ...config.marketData,
      python: process.execPath,
      workerScript: "package.json"
    }
  }, {
    worker: {
      async start() { starts += 1; return { native_core: true }; },
      async request() { throw new Error("not used"); },
      async close() {},
      status() { return { running: true }; }
    },
    getSchwabAccessToken: async () => {
      const error = new Error("Refresh token is invalid, expired or revoked");
      error.code = "SCHWAB_REAUTH_REQUIRED";
      throw error;
    }
  });
  await runtime.start();
  assert.equal(starts, 1);
  await assert.rejects(runtime.checkPrimary(), { code: "SCHWAB_REAUTH_REQUIRED" });
  await runtime.close();
});

test("preliminary Schwab quote is published while causal history is still pending", async () => {
  const publishedAt = new Date().toISOString();
  let releaseHistory;
  let predictionStarted = false;
  const history = new Promise((resolve) => { releaseHistory = resolve; });
  const preliminary = [];
  const worker = {
    start: async () => ({ native_core: true }),
    request: async (request) => {
      if (request.command === "quote") return providerSnapshot("schwab", 353.77, publishedAt);
      predictionStarted = true;
      return {
        ...providerSnapshot("schwab", 353.77, publishedAt),
        market_state: { spot: 353.77 },
        ocean_wave: { native_core: true, expectations: { "5.0": { horizon_minutes: 5, probability_up: 0.51 } } }
      };
    },
    close: async () => {},
    status: () => ({ running: true, pid: 1 })
  };
  const runtimeConfig = {
    ...config,
    marketData: {
      ...config.marketData,
      crossCheck: [],
      fallback: [],
      python: process.execPath,
      workerScript: "package.json",
      causalIntradayFeatures: { timeoutMilliseconds: 5_000 }
    }
  };
  const runtime = createMarketDataRuntime(runtimeConfig, {
    worker,
    getSchwabAccessToken: async () => "pipe-only-token",
    intradayFeatureCapture: async () => history
  });
  await runtime.start();
  const pending = runtime.capture(runtimeConfig, {
    contract: { symbol: "TSLA", expiry: "2026-08-26", strike: 357.5, option_type: "call" }
  }, publishedAt, {
    onPreliminarySnapshot(snapshot) { preliminary.push(snapshot); }
  });
  for (let attempt = 0; attempt < 10 && preliminary.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(preliminary.length, 1);
  assert.equal(preliminary[0].capture_stage, "preliminary_quote");
  assert.equal(predictionStarted, false);
  releaseHistory({
    features: { minutes_from_open: 244.9, return_5m: 0.002 },
    provenance: { schema_version: "causal-intraday-features.v1", market_phase: "regular" }
  });
  const result = await pending;
  assert.equal(predictionStarted, true);
  assert.equal(result.capture_stage, "prediction_final");
  assert.equal(result.market_state.minutes_from_open, 244.9);
  await runtime.close();
});

test("causal-history timeout degrades safely after publishing the preliminary quote", async () => {
  const publishedAt = new Date().toISOString();
  const commands = [];
  const preliminary = [];
  const worker = {
    start: async () => ({ native_core: true }),
    request: async (request) => {
      commands.push(request.command);
      return {
        ...providerSnapshot("schwab", 180, publishedAt),
        market_state: { spot: 180 },
        ocean_wave: { native_core: true, expectations: { "5.0": { horizon_minutes: 5, probability_up: 0.5 } } }
      };
    },
    close: async () => {},
    status: () => ({ running: true, pid: 1 })
  };
  const runtimeConfig = {
    ...config,
    marketData: {
      ...config.marketData,
      crossCheck: [],
      fallback: [],
      python: process.execPath,
      workerScript: "package.json",
      causalIntradayFeatures: { timeoutMilliseconds: 100 }
    }
  };
  const runtime = createMarketDataRuntime(runtimeConfig, {
    worker,
    getSchwabAccessToken: async () => "pipe-only-token",
    intradayFeatureCapture: async (_root, _symbol, _at, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  await runtime.start();
  const result = await runtime.capture(runtimeConfig, {
    contract: { symbol: "COIN", expiry: "2026-08-28", strike: 175, option_type: "put" }
  }, publishedAt, {
    onPreliminarySnapshot(snapshot) { preliminary.push(snapshot); }
  });
  assert.equal(preliminary.length, 1);
  assert.deepEqual(commands, ["quote", "predict"]);
  assert.equal(result.capture_stage, "prediction_final");
  assert.equal(result.provenance.causal_intraday_features.status, "unavailable");
  assert.match(result.provenance.causal_intraday_features.error, /timed out/i);
  await runtime.close();
});
