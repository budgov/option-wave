import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSchwabAccessToken } from "./schwab-oauth.js";
import { deriveCausalIntradayFeatures, fetchSchwabIntradayFeatures } from "./schwab-history.js";
import { JsonLineWorker } from "./json-line-worker.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_PROVIDERS = new Set(["schwab", "fidelity_web"]);

function normalizedProvider(value) {
  return String(value ?? "none");
}

function uniqueProviders(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizedProvider))];
}

function degraded(provider, signalPublishedAt, reason, attempts = []) {
  const capturedAt = new Date().toISOString();
  return {
    schema_version: "market-snapshot.v2",
    provider,
    source_role: "unavailable",
    data_tier: "text_only",
    signal_published_at: signalPublishedAt,
    observed_at: null,
    as_of: capturedAt,
    captured_at: capturedAt,
    execution_eligible: false,
    missing_reason: reason,
    provider_attempts: attempts,
    cross_validation: null,
    greeks: null,
    iv: null,
    term_structure: null,
    events: null
  };
}

function safeError(error) {
  return String(error?.stderr || error?.message || error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Basic\s+\S+/gi, "Basic [redacted]")
    .replace(/SCHWAB_ACCESS_TOKEN\s*=\s*\S+/gi, "SCHWAB_ACCESS_TOKEN=[redacted]")
    .replace(/access_token["'=:\s]+[^\s"&]+/gi, "access_token=[redacted]")
    .replace(/refresh_token["'=:\s]+[^\s"&]+/gi, "refresh_token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

export function snapshotObservedAt(snapshot) {
  const contractQuoteTimestamp = snapshot?.target_contract?.matched?.quote_timestamp;
  if (contractQuoteTimestamp != null) return contractQuoteTimestamp;
  if (snapshot != null && Object.hasOwn(snapshot, "observed_at")) return snapshot.observed_at;
  return snapshot?.quote_observed_at ?? null;
}

export function snapshotLagSeconds(snapshot, publishedAt) {
  const published = Date.parse(publishedAt);
  const observed = Date.parse(snapshotObservedAt(snapshot) ?? "");
  if (!Number.isFinite(published) || !Number.isFinite(observed)) return null;
  return Math.abs(observed - published) / 1000;
}

export function snapshotSourceOffsetSeconds(snapshot, publishedAt) {
  const published = Date.parse(publishedAt);
  const observed = Date.parse(snapshotObservedAt(snapshot) ?? "");
  if (!Number.isFinite(published) || !Number.isFinite(observed)) return null;
  return (observed - published) / 1000;
}

export function isAlignedSnapshot(snapshot, publishedAt, maxLagSeconds = 300) {
  const lag = snapshotLagSeconds(snapshot, publishedAt);
  return lag != null && lag <= maxLagSeconds;
}

export function isScorableOptionSnapshot(snapshot, publishedAt, maxLagSeconds = 300) {
  return isExactAlignedOptionSnapshot(snapshot, publishedAt, maxLagSeconds)
    && snapshot?.contract_assessment?.decision !== "abstain";
}

export function isExactAlignedOptionSnapshot(snapshot, publishedAt, maxLagSeconds = 300) {
  const target = snapshot?.target_contract;
  return snapshot?.data_tier === "realtime"
    && isAlignedSnapshot(snapshot, publishedAt, maxLagSeconds)
    && target?.matched != null
    && target.exact_expiry_match === true
    && target.exact_strike_match === true
    && target.exact_option_type_match === true;
}

function withTimeAlignment(snapshot, signalPublishedAt, maxLagSeconds) {
  const lagSeconds = snapshotLagSeconds(snapshot, signalPublishedAt);
  const sourceOffsetSeconds = snapshotSourceOffsetSeconds(snapshot, signalPublishedAt);
  return {
    ...snapshot,
    time_alignment: {
      signal_published_at: signalPublishedAt,
      quote_observed_at: snapshotObservedAt(snapshot),
      lag_seconds: lagSeconds,
      source_offset_seconds: sourceOffsetSeconds,
      absolute_alignment_seconds: lagSeconds,
      offset_semantics: "observed_at_minus_signal_published_at",
      max_lag_seconds: maxLagSeconds,
      aligned: lagSeconds != null && lagSeconds <= maxLagSeconds
    }
  };
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#58;/g, ":")
    .replace(/&#47;/g, "/")
    .replace(/&#134;/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberFromText(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function fieldAfterHeader(html, header) {
  const pattern = new RegExp(`<p[^>]*class=["'][^"']*bav-header[^"']*["'][^>]*>\\s*${header}\\s*</p>\\s*<p[^>]*class=["'][^"']*bav-value[^"']*["'][^>]*>([\\s\\S]*?)</p>`, "i");
  return decodeHtml(html.match(pattern)?.[1] ?? "");
}

function parseFidelityAsOf(html) {
  const raw = decodeHtml(html.match(/<div[^>]*class=["']time-stamp["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const match = raw.match(/AS OF\s+(.+)/i);
  return { raw, display: match?.[1]?.trim() ?? null };
}

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function zonedLocalToIso(parts, timeZone) {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = wanted;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += wanted - represented;
  }
  return new Date(guess).toISOString();
}

export function parseFidelityQuoteTime(value) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*ET\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[4].toUpperCase() === "PM") hour += 12;
  try {
    return zonedLocalToIso({
      year: Number(match[7]), month: Number(match[5]), day: Number(match[6]),
      hour, minute: Number(match[2]), second: Number(match[3] ?? 0)
    }, "America/New_York");
  } catch {
    return null;
  }
}

function parseFidelityUnderlying(html, symbol, url) {
  const price = numberFromText(decodeHtml(html.match(/<span[^>]*class=["']main-number["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ""));
  const changeText = decodeHtml(html.match(/<span[^>]*class=["']change["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
  const asOf = parseFidelityAsOf(html);
  const bidText = fieldAfterHeader(html, "Bid");
  const askText = fieldAfterHeader(html, "Ask");
  const volumeText = fieldAfterHeader(html, "Vol");
  const iv30Text = decodeHtml(html.match(/<span[^>]*class=["']iv-header["'][^>]*>IV30<\/span>[\s\S]*?<[^>]*class=["'][^"']*iv-value[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] ?? "");
  return {
    symbol,
    price,
    bid: numberFromText(bidText),
    ask: numberFromText(askText),
    volume: numberFromText(volumeText),
    iv30: numberFromText(iv30Text),
    change_text: changeText || null,
    quote_time_text: asOf.display,
    quote_observed_at: parseFidelityQuoteTime(asOf.display),
    raw_quote_time_text: asOf.raw,
    source_url: url
  };
}

async function captureFidelitySnapshot(config, symbol, signalPublishedAt, dependencies = {}) {
  const market = config.marketData ?? {};
  const urlTemplate = market.fidelity?.urlTemplate
    ?? "https://researchtools.fidelity.com/ftgw/mloptions/goto/optionChain?symbol={symbol}";
  const url = urlTemplate.replace("{symbol}", encodeURIComponent(symbol));
  const controller = new AbortController();
  const externalSignal = dependencies.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeoutSeconds = Number(market.fidelity?.timeoutSeconds ?? market.timeoutSeconds ?? 15);
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "Ocean-Wave read-only market verification" }
    });
    const html = await response.text();
    const capturedAt = new Date().toISOString();
    if (!response.ok) throw new Error(`Fidelity HTTP ${response.status}`);
    const underlying = parseFidelityUnderlying(html, symbol, url);
    if (underlying.price == null) throw new Error("Fidelity quote page did not expose a parseable underlying price");
    const observedAt = underlying.quote_observed_at;
    const loginRequired = /Log in<\/a><\/span>\s*to find and filter/i.test(html);
    return {
      schema_version: "ocean-wave-snapshot.v2",
      provider: "fidelity_web",
      source_role: "cross_check",
      data_tier: "realtime_underlying",
      symbol,
      signal_published_at: signalPublishedAt,
      observed_at: observedAt,
      as_of: observedAt ?? capturedAt,
      captured_at: capturedAt,
      execution_eligible: false,
      market_state: {
        symbol,
        underlying_price: underlying.price,
        bid: underlying.bid,
        ask: underlying.ask,
        volume: underlying.volume,
        iv30: underlying.iv30,
        quote_time_text: underlying.quote_time_text,
        change_text: underlying.change_text
      },
      target_contract: null,
      contract_assessment: null,
      greeks: null,
      iv: underlying.iv30 == null ? null : { iv30: underlying.iv30, source: "Fidelity quote page" },
      term_structure: null,
      events: null,
      fidelity: {
        login_required_for_options_chain: loginRequired,
        raw_quote_time_text: underlying.raw_quote_time_text,
        source_url: underlying.source_url
      },
      provenance: {
        source: "Fidelity option-chain quote header",
        quote_fields: "underlying quote only; background service does not share browser cookies",
        orders_enabled: false
      }
    };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function captureSchwabSnapshot(config, luna, symbol, signalPublishedAt, dependencies = {}) {
  const market = config.marketData ?? {};
  const schwabAccessToken = process.env.SCHWAB_ACCESS_TOKEN
    || await (dependencies.getSchwabAccessToken ?? getSchwabAccessToken)(config.__root);
  const stateDir = path.resolve(config.__root, market.stateDir ?? "data/ocean-wave-state");
  const contract = luna.contract ?? {};
  const contextOnly = luna?.human_interpretation_context_only === true;
  let causalFeatures = null;
  let snapshot;
  if (dependencies.schwabWorker) {
    let causalFeaturePromise = null;
    if (!contextOnly && market.causalIntradayFeatures?.enabled !== false) {
      const controller = new AbortController();
      const externalSignal = dependencies.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) abortFromExternal();
      else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      const timeoutMs = Math.max(100, Number(market.causalIntradayFeatures?.timeoutMilliseconds ?? 750));
      const timer = setTimeout(() => controller.abort(new Error("Causal intraday feature request timed out")), timeoutMs);
      causalFeaturePromise = (async () => {
        try {
          const captureFeatures = dependencies.intradayFeatureCapture ?? fetchSchwabIntradayFeatures;
          return await captureFeatures(config.__root, symbol, signalPublishedAt, {
            accessToken: schwabAccessToken,
            fetch: dependencies.fetch,
            signal: controller.signal,
            historyDays: Number(market.causalIntradayFeatures?.historyDays ?? 14),
            minimumRvolSessions: Number(market.causalIntradayFeatures?.minimumRvolSessions ?? 3),
            maximumRvolSessions: Number(market.causalIntradayFeatures?.maximumRvolSessions ?? 10),
            realizedVolWindowMinutes: Number(market.causalIntradayFeatures?.realizedVolWindowMinutes ?? 30),
            minimumRealizedVolReturns: Number(market.causalIntradayFeatures?.minimumRealizedVolReturns ?? 5)
          });
        } catch (error) {
          const clockOnly = deriveCausalIntradayFeatures([], signalPublishedAt);
          return {
            ...clockOnly,
            provenance: {
              ...clockOnly.provenance,
              status: "unavailable",
              error: safeError(error)
            }
          };
        } finally {
          clearTimeout(timer);
          externalSignal?.removeEventListener("abort", abortFromExternal);
        }
      })();
    }

    if (!contextOnly) {
      // Capture and publish the first point-in-time underlying quote while the
      // independent price-history request is still running. The prediction
      // waits for at most the bounded feature window, but quote durability does
      // not wait for Luna, Terra, or the historical endpoint.
      try {
        const preliminary = await dependencies.schwabWorker.request({
          command: "quote",
          symbol,
          signal_published_at: signalPublishedAt,
          access_token: schwabAccessToken
        }, { timeoutMs: Number(market.timeoutSeconds ?? 30) * 1000 });
        if (["ocean-wave-snapshot.v1", "ocean-wave-snapshot.v2"].includes(preliminary?.schema_version)) {
          const normalized = withTimeAlignment({
            ...preliminary,
            schema_version: "ocean-wave-snapshot.v2",
            source_role: "primary",
            signal_published_at: preliminary.signal_published_at ?? signalPublishedAt,
            capture_stage: "preliminary_quote"
          }, signalPublishedAt, Number(market.maxLiveLagSeconds ?? 300));
          await Promise.resolve(dependencies.onPreliminarySnapshot?.(normalized)).catch(() => {});
        }
      } catch {
        // The full prediction below performs its own fresh quote and remains
        // authoritative. A preliminary quote failure must not drop the signal.
      }
      causalFeatures = causalFeaturePromise ? await causalFeaturePromise : null;
    }
    const marketStateOverrides = contextOnly ? null : {
      ...(luna?.market_state_features ?? {}),
      ...(causalFeatures?.features ?? {})
    };
    const request = contextOnly
      ? {
          command: "quote",
          symbol,
          signal_published_at: signalPublishedAt,
          access_token: schwabAccessToken
        }
      : {
          command: "predict",
          symbol,
          signal_published_at: signalPublishedAt,
          access_token: schwabAccessToken,
          horizons: String(market.horizonsMinutes ?? "5,15,30,60"),
          strike_count: Number(market.strikeCount ?? 40),
          expiry: contract.expiry ?? null,
          strike: contract.strike ?? null,
          option_type: ["call", "put"].includes(contract.option_type) ? contract.option_type : null,
          market_state_overrides: Object.keys(marketStateOverrides).length ? marketStateOverrides : null
        };
    snapshot = await dependencies.schwabWorker.request(
      request,
      { timeoutMs: Number(market.timeoutSeconds ?? 30) * 1000 }
    );
  } else {
    const python = path.resolve(config.__root, market.python ?? ".venv/Scripts/python.exe");
    const script = path.resolve(config.__root, market.script ?? "scripts/schwab_predict.py");
    if (!fs.existsSync(python) || !fs.existsSync(script)) {
      throw new Error("Ocean Wave runtime or Schwab adapter script is missing");
    }
    const args = [script, "--symbol", symbol, "--signal-published-at", signalPublishedAt, "--state-dir", stateDir];
    if (contextOnly) {
      args.push("--quote-only");
    } else {
      args.push(
        "--horizons", String(market.horizonsMinutes ?? "5,15,30,60"),
        "--strike-count", String(market.strikeCount ?? 40)
      );
      if (contract.expiry) args.push("--expiry", String(contract.expiry));
      if (contract.strike != null) args.push("--strike", String(contract.strike));
      if (["call", "put"].includes(contract.option_type)) args.push("--option-type", contract.option_type);
    }
    const execute = dependencies.execFile ?? execFileAsync;
    const { stdout } = await execute(python, args, {
      cwd: path.resolve(config.__root, "ocean-wave"),
      env: {
        ...process.env,
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        SCHWAB_ACCESS_TOKEN: schwabAccessToken
      },
      encoding: "utf8",
      timeout: Number(market.timeoutSeconds ?? 30) * 1000,
      maxBuffer: Number(market.maxProcessOutputBytes ?? 4 * 1024 * 1024),
      windowsHide: true
    });
    snapshot = JSON.parse(stdout.trim());
  }
  if (!["ocean-wave-snapshot.v1", "ocean-wave-snapshot.v2"].includes(snapshot?.schema_version)) {
    throw new Error("Ocean Wave returned an unexpected snapshot schema");
  }
  return {
    ...snapshot,
    schema_version: "ocean-wave-snapshot.v2",
    source_role: "primary",
    signal_published_at: snapshot.signal_published_at ?? signalPublishedAt,
    capture_stage: contextOnly ? "preliminary_quote" : "prediction_final",
    ...(causalFeatures ? {
      market_state: {
        ...(snapshot.market_state ?? {}),
        ...causalFeatures.features,
        market_phase: causalFeatures.provenance?.market_phase ?? null
      },
      provenance: {
        ...(snapshot.provenance ?? {}),
        causal_intraday_features: {
          ...causalFeatures.provenance,
          status: causalFeatures.provenance?.status ?? "ok",
          applied_to_prediction: true
        }
      }
    } : {})
  };
}

export function createMarketDataRuntime(config, dependencies = {}) {
  const market = config.marketData ?? {};
  const providers = uniqueProviders([market.primary, ...(market.crossCheck ?? []), ...(market.fallback ?? [])]);
  if (!providers.includes("schwab")) {
    return {
      start: async () => ({ status: "not_required" }),
      checkPrimary: async () => ({ status: "not_required" }),
      capture: (runtimeConfig, luna, publishedAt, requestContext = {}) => captureMarketSnapshot(
        runtimeConfig, luna, publishedAt, { ...dependencies, ...requestContext }
      ),
      applyFeedback: async () => ({ status: "unavailable", reason: "Schwab Ocean Wave worker is not configured" }),
      intradayFeatures: async () => ({ status: "abstain", reason: "Schwab Ocean Wave worker is not configured" }),
      close: async () => {},
      status: () => ({ running: false, provider: "not_required" })
    };
  }

  const python = path.resolve(config.__root, market.python ?? ".venv/Scripts/python.exe");
  const script = path.resolve(config.__root, market.workerScript ?? "scripts/realtime_worker.py");
  const stateDir = path.resolve(config.__root, market.stateDir ?? "data/ocean-wave-state");
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    throw new Error("Ocean Wave realtime worker runtime is missing");
  }
  const workerEnv = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1"
  };
  delete workerEnv.SCHWAB_ACCESS_TOKEN;
  const worker = dependencies.worker ?? new JsonLineWorker({
    file: python,
    args: [
      "-u", script,
      "--state-dir", stateDir,
      "--horizons", String(market.horizonsMinutes ?? "5,15,30,60"),
      "--strike-count", String(market.strikeCount ?? 40),
      "--max-symbols", String(market.workerMaxSymbols ?? 32),
      "--max-requests", String(market.workerMaxRequests ?? 100),
      "--feedback-learning-rate", String(config.positionWorkflow?.feedbackLearningRate ?? 0.025),
      "--feedback-minimum-samples", String(config.positionWorkflow?.feedbackMinimumSamples ?? 30),
      "--feedback-minimum-promotion-samples", String(config.intradayResearch?.minimumPromotionForecasts ?? 500),
      "--feedback-minimum-valid-days", String(config.intradayResearch?.minimumPromotionTradingDays ?? 40)
    ],
    cwd: config.__root,
    env: workerEnv,
    startupTimeoutMs: Number(market.workerStartupTimeoutSeconds ?? 15) * 1000,
    requestTimeoutMs: Number(market.timeoutSeconds ?? 30) * 1000,
    shutdownTimeoutMs: Number(market.workerShutdownTimeoutSeconds ?? 15) * 1000,
    maxLineBytes: Number(market.maxProcessOutputBytes ?? 4 * 1024 * 1024),
    validateReady: (message) => message.schema_version === "ocean-wave-worker.v1"
      && (market.requireNativeCore === false || message.native_core === true)
  });
  const tokenProvider = dependencies.getSchwabAccessToken ?? getSchwabAccessToken;
  return {
    // Worker readiness is independent from Schwab authorization. Defer token
    // acquisition until a quote request so Telegram can remain live and the
    // configured Fidelity fallback can take over during reauthorization.
    start: () => worker.start(),
    checkPrimary: async () => {
      await tokenProvider(config.__root);
      return { status: "ready", provider: "schwab" };
    },
    capture: (runtimeConfig, luna, publishedAt, requestContext = {}) => captureMarketSnapshot(runtimeConfig, luna, publishedAt, {
      ...dependencies,
      ...requestContext,
      schwabWorker: worker
    }),
    applyFeedback: (feedback) => worker.request({ command: "feedback", feedback }),
    intradayFeatures: (prices, options = {}) => worker.request({
      command: "intraday_features",
      prices,
      valid_length: options.validLength ?? prices?.length,
      max_harmonics: options.maxHarmonics ?? 64,
      sample_interval_minutes: options.sampleIntervalMinutes ?? 1
    }),
    close: () => worker.close(),
    status: () => ({ ...worker.status(), provider: "schwab", native_core_required: market.requireNativeCore !== false })
  };
}

function snapshotSpot(snapshot) {
  const value = Number(snapshot?.market_state?.underlying_price ?? snapshot?.market_state?.spot);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function snapshotTimeSkewSeconds(left, right) {
  const leftObserved = Date.parse(snapshotObservedAt(left) ?? "");
  const rightObserved = Date.parse(snapshotObservedAt(right) ?? "");
  if (!Number.isFinite(leftObserved) || !Number.isFinite(rightObserved)) return null;
  return Math.abs(rightObserved - leftObserved) / 1000;
}

function buildCrossValidation(primarySnapshot, crossChecks, maxDifferenceBps, maxTimeSkewSeconds) {
  if (!crossChecks.length) return null;
  const primaryPrice = snapshotSpot(primarySnapshot);
  const primaryObservedAt = snapshotObservedAt(primarySnapshot);
  const checks = crossChecks.map(({ provider, snapshot, error }) => {
    if (error) return { provider, status: "unavailable", reason: safeError(error) };
    const secondaryObservedAt = snapshotObservedAt(snapshot);
    const timeSkewSeconds = snapshotTimeSkewSeconds(primarySnapshot, snapshot);
    if (timeSkewSeconds == null) {
      return {
        provider,
        status: "unavailable",
        reason: "Comparable provider quote timestamps were not available",
        primary_observed_at: primaryObservedAt,
        secondary_observed_at: secondaryObservedAt
      };
    }
    if (timeSkewSeconds > maxTimeSkewSeconds) {
      return {
        provider,
        status: "stale",
        reason: `Cross-check quote time differs from the primary by ${timeSkewSeconds.toFixed(3)}s (maximum ${maxTimeSkewSeconds}s)`,
        primary_observed_at: primaryObservedAt,
        secondary_observed_at: secondaryObservedAt,
        time_skew_seconds: timeSkewSeconds,
        max_time_skew_seconds: maxTimeSkewSeconds
      };
    }
    const secondaryPrice = snapshotSpot(snapshot);
    if (primaryPrice == null || secondaryPrice == null) {
      return {
        provider,
        status: "unavailable",
        reason: "Comparable underlying prices were not available",
        primary_observed_at: primaryObservedAt,
        secondary_observed_at: secondaryObservedAt,
        time_skew_seconds: timeSkewSeconds,
        max_time_skew_seconds: maxTimeSkewSeconds
      };
    }
    const differenceBps = Math.abs(secondaryPrice - primaryPrice) / primaryPrice * 10_000;
    return {
      provider,
      status: differenceBps <= maxDifferenceBps ? "pass" : "warning",
      primary_price: primaryPrice,
      secondary_price: secondaryPrice,
      difference_bps: differenceBps,
      max_difference_bps: maxDifferenceBps,
      primary_observed_at: primaryObservedAt,
      secondary_observed_at: secondaryObservedAt,
      time_skew_seconds: timeSkewSeconds,
      max_time_skew_seconds: maxTimeSkewSeconds
    };
  });
  return {
    status: checks.some((item) => item.status === "stale") ? "stale"
      : checks.some((item) => item.status === "warning") ? "warning"
      : checks.some((item) => item.status === "pass") ? "pass" : "unavailable",
    checks
  };
}

function settledProviderTask(task) {
  return Promise.resolve().then(task).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason })
  );
}

async function waitForCrossCheck(task, milliseconds) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const reason = new Error(`Cross-check did not finish within ${milliseconds}ms after the primary quote`);
      reason.code = "CROSS_CHECK_TIMEOUT";
      resolve({ status: "rejected", reason, timed_out: true });
    }, Math.max(0, milliseconds));
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function captureMarketSnapshot(config, luna, signalPublishedAt, dependencies = {}) {
  const market = config.marketData ?? {};
  const primary = normalizedProvider(market.primary ?? "none");
  const crossCheckProviders = uniqueProviders(market.crossCheck).filter((provider) => provider !== primary);
  const fallbackProviders = uniqueProviders(market.fallback).filter((provider) => provider !== primary);
  const attemptedProviders = uniqueProviders([primary, ...crossCheckProviders, ...fallbackProviders])
    .filter((provider) => SUPPORTED_PROVIDERS.has(provider));
  const symbol = luna?.contract?.symbol?.trim()?.toUpperCase();
  const maxLiveLagSeconds = Number(market.maxLiveLagSeconds ?? 300);
  const finalize = (snapshot) => withTimeAlignment(snapshot, signalPublishedAt, maxLiveLagSeconds);
  if (!SUPPORTED_PROVIDERS.has(primary)) {
    return finalize(degraded(primary, signalPublishedAt, "No point-in-time market-data provider configured"));
  }
  if (!symbol) return finalize(degraded(primary, signalPublishedAt, "Luna did not identify an underlying symbol"));

  const ageSeconds = Math.abs(Date.now() - Date.parse(signalPublishedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > maxLiveLagSeconds) {
    return finalize(degraded(primary, signalPublishedAt, "Historical point-in-time option snapshot is unavailable; current quotes were not substituted"));
  }

  const adapters = {
    schwab: dependencies.providers?.schwab
      ?? ((providerConfig, providerLuna, providerSymbol, publishedAt, requestContext = {}) => captureSchwabSnapshot(
        providerConfig,
        providerLuna,
        providerSymbol,
        publishedAt,
        { ...dependencies, signal: requestContext.signal }
      )),
    fidelity_web: dependencies.providers?.fidelity_web
      ?? ((providerConfig, _providerLuna, providerSymbol, publishedAt, requestContext = {}) => captureFidelitySnapshot(
        providerConfig,
        providerSymbol,
        publishedAt,
        { ...dependencies, signal: requestContext.signal }
      ))
  };
  // Start all configured sources together. A healthy Schwab primary only waits
  // a small bounded grace period for Fidelity; a failed primary still awaits
  // the fallback fully, so speed does not weaken failover reliability.
  const tasks = new Map(attemptedProviders.map((provider) => {
    const controller = new AbortController();
    return [provider, {
      controller,
      promise: settledProviderTask(() => adapters[provider](
        config,
        luna,
        symbol,
        signalPublishedAt,
        { signal: controller.signal }
      ))
    }];
  }));
  const results = new Map();
  const primaryResult = await tasks.get(primary).promise;
  results.set(primary, primaryResult);
  if (typeof dependencies.onPrimaryStatus === "function") {
    const update = primaryResult.status === "fulfilled"
      ? { status: "ready", provider: primary, symbol, observed_at: snapshotObservedAt(primaryResult.value) }
      : { status: "unavailable", provider: primary, symbol, error: primaryResult.reason };
    void Promise.resolve(dependencies.onPrimaryStatus(update)).catch(() => {});
  }
  if (primaryResult.status === "fulfilled") {
    const crossCheckWaitMs = Number(market.crossCheckWaitMilliseconds ?? 1000);
    await Promise.all(crossCheckProviders.map(async (provider) => {
      const task = tasks.get(provider);
      const result = await waitForCrossCheck(task.promise, crossCheckWaitMs);
      results.set(provider, result);
      if (result.timed_out) task.controller.abort(new Error("Cross-check grace period elapsed"));
    }));
    for (const provider of fallbackProviders) {
      if (!crossCheckProviders.includes(provider)) tasks.get(provider)?.controller.abort(new Error("Fallback not needed"));
    }
  } else {
    await Promise.all(fallbackProviders.map(async (provider) => {
      results.set(provider, await tasks.get(provider).promise);
    }));
    for (const provider of crossCheckProviders) {
      if (!fallbackProviders.includes(provider)) tasks.get(provider)?.controller.abort(new Error("Cross-check not needed"));
    }
  }
  const attempts = attemptedProviders.map((provider) => {
    const result = results.get(provider);
    if (!result) return { provider, status: "not_needed", reason: "Primary provider succeeded" };
    if (result?.status !== "fulfilled") {
      return {
        provider,
        status: result.timed_out ? "timeout" : "error",
        reason: safeError(result?.reason)
      };
    }
    const observedAt = snapshotObservedAt(result.value);
    const lagSeconds = snapshotLagSeconds(result.value, signalPublishedAt);
    const aligned = lagSeconds != null && lagSeconds <= maxLiveLagSeconds;
    return {
      provider,
      status: aligned ? "ok" : "stale",
      ...(aligned ? {} : {
        reason: lagSeconds == null
          ? "Provider quote timestamp is unavailable"
          : `Provider quote differs from the signal time by ${lagSeconds.toFixed(3)}s (maximum ${maxLiveLagSeconds}s)`
      }),
      observed_at: observedAt,
      lag_seconds: lagSeconds,
      max_lag_seconds: maxLiveLagSeconds,
      captured_at: result.value.captured_at
    };
  });

  if (primaryResult?.status === "fulfilled") {
    const crossChecks = crossCheckProviders.map((provider) => {
      const result = results.get(provider);
      return result?.status === "fulfilled"
        ? { provider, snapshot: result.value }
        : { provider, error: result?.reason ?? new Error("provider was not attempted") };
    });
    return finalize({
      ...primaryResult.value,
      source_role: "primary",
      provider_attempts: attempts,
      cross_validation: buildCrossValidation(
        primaryResult.value,
        crossChecks,
        Number(market.validation?.maxUnderlyingDifferenceBps ?? 25),
        Number(market.validation?.maxCrossCheckTimeSkewSeconds ?? 90)
      )
    });
  }

  for (const provider of fallbackProviders) {
    const fallbackResult = results.get(provider);
    if (fallbackResult?.status !== "fulfilled") continue;
    if (!isAlignedSnapshot(fallbackResult.value, signalPublishedAt, maxLiveLagSeconds)) continue;
    return finalize({
      ...fallbackResult.value,
      source_role: "fallback",
      primary_provider: primary,
      failover: {
        reason: safeError(primaryResult?.reason ?? new Error("primary provider unavailable")),
        option_contract_validation_available: fallbackResult.value.target_contract != null
      },
      provider_attempts: attempts,
      cross_validation: null
    });
  }

  return finalize(degraded(
    primary,
    signalPublishedAt,
    `${primary} and configured fallbacks failed: ${attempts.filter((item) => item.status !== "ok").map((item) => `${item.provider}: ${item.reason}`).join("; ")}`,
    attempts
  ));
}
