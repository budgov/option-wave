import fs from "node:fs";
import path from "node:path";

export function loadConfig(configPath = process.env.OCEAN_WAVE_CONFIG ?? "config.json") {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing config: ${absolute}. Copy config.example.json to config.json first.`);
  }
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  validateConfig(config);
  config.__path = absolute;
  config.__root = path.dirname(absolute);
  config.data.database = path.resolve(config.__root, config.data.database);
  return config;
}

export function validateConfig(config) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${config.timezone}`);
  }
  if (!Array.isArray(config.channels) || config.channels.length !== 2) {
    throw new Error("Exactly two target channels are required.");
  }
  const keys = new Set();
  for (const channel of config.channels) {
    if (!channel.key || !channel.title) throw new Error("Each channel needs key and title.");
    if (keys.has(channel.key)) throw new Error(`Duplicate channel key: ${channel.key}`);
    keys.add(channel.key);
  }
  for (const key of keys) {
    const semantics = config.channelSemantics?.[key];
    if (!semantics || semantics.entryAction !== "buy_to_open" || semantics.exitAction !== "sell_to_close") {
      throw new Error(`Missing buy-to-open / sell-to-close semantics for channel: ${key}`);
    }
    if (semantics.entryAtPriceMeaning !== "source_reported_fill"
      || semantics.missingExpiryPolicy !== "nearest_listed_expiry"
      || semantics.profitControlPolicy !== "half_remaining_each_signal") {
      throw new Error(`Missing source fill / nearest expiry / profit-control semantics for channel: ${key}`);
    }
  }
  if (config.safety?.readOnly !== true) throw new Error("safety.readOnly must remain true.");
  if (config.safety?.allowOutboundTelegram !== false) {
    throw new Error("Outbound Telegram actions are forbidden in this pipeline.");
  }
  if (config.safety?.allowTrading !== false) throw new Error("Trading must remain disabled.");
  for (const stage of ["luna", "terra", "sol"]) {
    const agent = config.openclaw?.agents?.[stage];
    if (!agent?.model) throw new Error(`Missing OpenClaw model for ${stage}.`);
  }
  if (config.media?.enabled === true) {
    const maxBytes = Number(config.media?.maxBytes ?? 20 * 1024 * 1024);
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("media.maxBytes must be positive.");
  }
  const pollSeconds = Number(config.listener?.pollIntervalSeconds ?? 10);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw new Error("listener.pollIntervalSeconds must be at least 1.");
  const heartbeatSeconds = Number(config.listener?.heartbeatSeconds ?? 10);
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds < 2 || heartbeatSeconds > 300) {
    throw new Error("listener.heartbeatSeconds must be from 2 to 300.");
  }
  const maxQueuedMessages = Number(config.listener?.maxQueuedMessages ?? 250);
  if (!Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages < 10 || maxQueuedMessages > 10_000) {
    throw new Error("listener.maxQueuedMessages must be an integer from 10 to 10000.");
  }
  const retryBatchSize = Number(config.listener?.retryBatchSize ?? 2);
  if (!Number.isSafeInteger(retryBatchSize) || retryBatchSize < 1 || retryBatchSize > 100) {
    throw new Error("listener.retryBatchSize must be an integer from 1 to 100.");
  }
  const analysisAlertAfterAttempts = Number(config.listener?.analysisAlertAfterAttempts ?? 2);
  if (!Number.isSafeInteger(analysisAlertAfterAttempts) || analysisAlertAfterAttempts < 1 || analysisAlertAfterAttempts > 10) {
    throw new Error("listener.analysisAlertAfterAttempts must be an integer from 1 to 10.");
  }

  const providers = new Set(["none", "schwab", "fidelity_web"]);
  const primary = config.marketData?.primary ?? "none";
  if (!providers.has(primary)) throw new Error(`Unsupported marketData.primary: ${primary}`);
  for (const key of ["crossCheck", "fallback"]) {
    const values = config.marketData?.[key] ?? [];
    if (!Array.isArray(values)) throw new Error(`marketData.${key} must be an array.`);
    if (new Set(values).size !== values.length) throw new Error(`marketData.${key} contains duplicates.`);
    for (const provider of values) {
      if (!providers.has(provider) || provider === "none") throw new Error(`Unsupported marketData.${key} provider: ${provider}`);
      if (provider === primary) throw new Error(`marketData.${key} must not repeat the primary provider.`);
    }
  }
  for (const [name, value, minimum, maximum] of [
    ["marketData.maxLiveLagSeconds", config.marketData?.maxLiveLagSeconds ?? 300, 1, 3600],
    ["marketData.crossCheckWaitMilliseconds", config.marketData?.crossCheckWaitMilliseconds ?? 1000, 0, 10000],
    ["marketData.timeoutSeconds", config.marketData?.timeoutSeconds ?? 30, 1, 120],
    ["marketData.strikeCount", config.marketData?.strikeCount ?? 40, 1, 500],
    ["marketData.workerMaxSymbols", config.marketData?.workerMaxSymbols ?? 32, 1, 128],
    ["marketData.workerMaxRequests", config.marketData?.workerMaxRequests ?? 100, 1, 10000],
    ["marketData.workerStartupTimeoutSeconds", config.marketData?.workerStartupTimeoutSeconds ?? 15, 1, 120],
    ["marketData.workerShutdownTimeoutSeconds", config.marketData?.workerShutdownTimeoutSeconds ?? 15, 1, 120],
    ["marketData.maxProcessOutputBytes", config.marketData?.maxProcessOutputBytes ?? 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024],
    ["marketData.validation.maxUnderlyingDifferenceBps", config.marketData?.validation?.maxUnderlyingDifferenceBps ?? 25, 0, 1000],
    ["marketData.validation.maxCrossCheckTimeSkewSeconds", config.marketData?.validation?.maxCrossCheckTimeSkewSeconds ?? 90, 1, 3600],
    ["openclaw.maxOutputBytes", config.openclaw?.maxOutputBytes ?? 8 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024],
    ["openclaw.transientAttempts", config.openclaw?.transientAttempts ?? 2, 1, 4],
    ["openclaw.transientRetryDelayMs", config.openclaw?.transientRetryDelayMs ?? 2000, 0, 30000],
    ["notifications.telegram.timeoutMs", config.notifications?.telegram?.timeoutMs ?? 20000, 1000, 60000]
  ]) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
    }
  }
  const transientAttempts = Number(config.openclaw?.transientAttempts ?? 2);
  if (!Number.isSafeInteger(transientAttempts)) throw new Error("openclaw.transientAttempts must be an integer.");
  if (config.marketData?.requireNativeCore != null && typeof config.marketData.requireNativeCore !== "boolean") {
    throw new Error("marketData.requireNativeCore must be boolean.");
  }
  if (config.positionWorkflow?.enabled != null && typeof config.positionWorkflow.enabled !== "boolean") {
    throw new Error("positionWorkflow.enabled must be boolean.");
  }
  for (const [name, value, minimum, maximum] of [
    ["positionWorkflow.maxActive", config.positionWorkflow?.maxActive ?? 16, 1, 64],
    ["positionWorkflow.workerStartupTimeoutSeconds", config.positionWorkflow?.workerStartupTimeoutSeconds ?? 5, 1, 60],
    ["positionWorkflow.workerRequestTimeoutSeconds", config.positionWorkflow?.workerRequestTimeoutSeconds ?? 15, 1, 120],
    ["positionWorkflow.workerShutdownTimeoutSeconds", config.positionWorkflow?.workerShutdownTimeoutSeconds ?? 5, 1, 60],
    ["positionWorkflow.completionRetrySeconds", config.positionWorkflow?.completionRetrySeconds ?? 60, 5, 3600],
    ["positionWorkflow.orphanMaxHoldHours", config.positionWorkflow?.orphanMaxHoldHours ?? 720, 24, 8760],
    ["positionWorkflow.feedbackLearningRate", config.positionWorkflow?.feedbackLearningRate ?? 0.025, 0.001, 0.1],
    ["positionWorkflow.feedbackMinimumSamples", config.positionWorkflow?.feedbackMinimumSamples ?? 30, 10, 10000]
  ]) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
    }
  }
  const marketCloseLocalTime = String(config.positionWorkflow?.marketCloseLocalTime ?? "13:00");
  if (!/^\d{2}:\d{2}$/.test(marketCloseLocalTime)
    || Number(marketCloseLocalTime.slice(0, 2)) > 23
    || Number(marketCloseLocalTime.slice(3, 5)) > 59) {
    throw new Error("positionWorkflow.marketCloseLocalTime must be HH:MM.");
  }

  const intraday = config.intradayResearch ?? {};
  if (intraday.enabled != null && typeof intraday.enabled !== "boolean") {
    throw new Error("intradayResearch.enabled must be boolean.");
  }
  if (intraday.enabled === true) {
    const symbols = intraday.symbols;
    if (!Array.isArray(symbols) || new Set(symbols.map((value) => String(value).toUpperCase())).size !== symbols.length) {
      throw new Error("intradayResearch.symbols must be a duplicate-free array.");
    }
    const normalizedSymbols = new Set(symbols.map((value) => String(value).toUpperCase()));
    if (normalizedSymbols.size !== 2 || !normalizedSymbols.has("QQQ") || !normalizedSymbols.has("SPY")) {
      throw new Error("intradayResearch.symbols must contain exactly QQQ and SPY.");
    }
    const contextSymbols = intraday.contextSymbols;
    if (!Array.isArray(contextSymbols) || contextSymbols.length > 8
        || contextSymbols.some((value) => !/^[A-Z][A-Z0-9.]{0,7}$/.test(String(value)))
        || new Set(contextSymbols).size !== contextSymbols.length
        || contextSymbols.some((value) => normalizedSymbols.has(value))) {
      throw new Error("intradayResearch.contextSymbols must be a duplicate-free list of at most 8 additional symbols.");
    }
    if (Number(intraday.sampleIntervalSeconds) !== 60) {
      throw new Error("intradayResearch.sampleIntervalSeconds must be 60.");
    }
    if (Number(intraday.forecastIntervalMinutes) !== 30 || Number(intraday.forecastHorizonMinutes) !== 30) {
      throw new Error("intradayResearch forecast interval and horizon must both be 30 minutes.");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: intraday.marketTimeZone }).format();
    } catch {
      throw new Error(`Invalid intradayResearch.marketTimeZone: ${intraday.marketTimeZone}`);
    }
    for (const key of ["fallbackOpenLocalTime", "fallbackCloseLocalTime"]) {
      if (!/^\d{2}:\d{2}$/.test(String(intraday[key] ?? ""))) {
        throw new Error(`intradayResearch.${key} must be HH:MM.`);
      }
    }
    for (const [name, value, minimum, maximum] of [
      ["intradayResearch.maximumQuoteAgeSeconds", intraday.maximumQuoteAgeSeconds, 1, 60],
      ["intradayResearch.maximumQuoteSkewMilliseconds", intraday.maximumQuoteSkewMilliseconds, 100, 10_000],
      ["intradayResearch.maximumCatchupSlotsPerAdvance", intraday.maximumCatchupSlotsPerAdvance, 1, 30],
      ["intradayResearch.maximumActiveChannelWorkers", intraday.maximumActiveChannelWorkers, 1, 16],
      ["intradayResearch.fourierWindowMinutes", intraday.fourierWindowMinutes, 32, 390],
      ["intradayResearch.minimumFourierSamples", intraday.minimumFourierSamples, 16, 390],
      ["intradayResearch.minimumPromotionTradingDays", intraday.minimumPromotionTradingDays, 20, 2520],
      ["intradayResearch.minimumPromotionForecasts", intraday.minimumPromotionForecasts, 100, 100_000]
    ]) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
      }
    }
    const stateDir = String(intraday.stateDir ?? "");
    if (!stateDir || path.isAbsolute(stateDir) || stateDir.split(/[\\/]+/).includes("..")) {
      throw new Error("intradayResearch.stateDir must be a relative path inside the project.");
    }
    if (config.openclaw?.agents?.sol?.thinking !== "high") {
      throw new Error("The intraday daily review requires Sol thinking high.");
    }
  }
}

export function ensurePrivateDirectories(config) {
  fs.mkdirSync(path.dirname(config.data.database), { recursive: true });
  fs.mkdirSync(path.join(config.__root, ".secrets"), { recursive: true });
  if (config.media?.enabled === true) fs.mkdirSync(path.join(config.__root, "data", "media"), { recursive: true });
}
