const STATE_SCHEMA = "ocean-wave-intraday-research.v1";
const EVENT_SCHEMA = "ocean-wave-intraday-event.v1";
const DEFAULT_SYMBOLS = Object.freeze(["QQQ", "SPY"]);
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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

function deepClone(value) {
  return value == null ? value : structuredClone(value);
}

const SPECTRAL_SUMMARY_KEYS = Object.freeze([
  "schema_version", "feature_version", "status", "reason", "source",
  "native_required", "python_spectral_fallback", "causal_prefix",
  "lookahead_samples", "input_semantics", "input_transform", "period_unit",
  "sample_count", "harmonic_count", "sample_interval", "price_sample_count",
  "return_sample_count", "minimum_price_samples", "price_cutoff_index",
  "last_price", "mean", "input_variance", "variance",
  "linear_trend_slope_per_minute", "retained_energy",
  "explained_energy_fraction", "spectral_entropy", "dominant_harmonic",
  "dominant_period", "dominant_phase", "band_names",
  "band_period_lower_minutes", "band_period_upper_minutes",
  "band_upper_inclusive", "band_energy_fraction",
  "out_of_band_energy_fraction", "band_covered_energy_fraction"
]);

/**
 * The C++ FFT returns complete coefficient vectors. Keeping those vectors in
 * every half-hour forecast is both redundant (the full-session event retains
 * them) and statistically hazardous. Persist scalar diagnostics plus the five
 * strongest causal components, which is sufficient for walk-forward features
 * without turning every checkpoint into a high-dimensional spectral dump.
 */
export function compactSpectralDiagnostics(value, maximumComponents = 5) {
  if (!value || typeof value !== "object") return value ?? null;
  const output = Object.fromEntries(SPECTRAL_SUMMARY_KEYS
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, deepClone(value[key])]));
  const power = Array.isArray(value.power) ? value.power : [];
  const totalPower = power.reduce((sum, item) => sum + Math.max(0, finite(item, 0)), 0);
  output.top_components = power
    .map((item, index) => ({ index, power: Math.max(0, finite(item, 0)) }))
    .filter((item) => item.power > 0)
    .sort((left, right) => right.power - left.power)
    .slice(0, Math.max(0, Number(maximumComponents) || 0))
    .map(({ index, power: componentPower }) => ({
      harmonic: finite(value.harmonics?.[index], index + 1),
      frequency: finite(value.frequencies?.[index]),
      period: finite(value.periods?.[index]),
      amplitude: finite(value.amplitudes?.[index]),
      phase: finite(value.phases?.[index]),
      power: componentPower,
      power_fraction: totalPower > 0 ? componentPower / totalPower : null
    }));
  output.compaction_policy = "top_5_components_and_band_summaries.v1";
  return output;
}

export function compactHorizonPath(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([horizon, expectation]) => [horizon, {
    horizon_minutes: finite(expectation?.horizon_minutes, finite(horizon)),
    expected_return: finite(expectation?.expected_return ?? expectation?.expectedReturn),
    probability_up: finite(expectation?.probability_up ?? expectation?.probabilityUp),
    return_variance: finite(expectation?.return_variance ?? expectation?.returnVariance)
  }]));
}

function compactPredictionFeatures(value) {
  if (!value || typeof value !== "object") return value ?? null;
  return {
    ...value,
    spectralDiagnostics: compactSpectralDiagnostics(value.spectralDiagnostics),
    horizonPath: compactHorizonPath(value.horizonPath)
  };
}

function compactStoredForecast(forecast) {
  if (!forecast || typeof forecast !== "object") return forecast;
  return {
    ...forecast,
    prediction: forecast.prediction && typeof forecast.prediction === "object"
      ? {
        ...forecast.prediction,
        features: compactPredictionFeatures(forecast.prediction.features)
      }
      : forecast.prediction ?? null
  };
}

function compactTrajectoryReference(observation) {
  if (!observation || typeof observation !== "object") return observation;
  return {
    observationId: observation.observationId,
    forecastId: observation.forecastId,
    symbol: observation.symbol,
    observedAt: observation.observedAt
  };
}

function compactStoredSummary(summary) {
  if (!summary || typeof summary !== "object") return summary ?? null;
  if (summary.status !== "completed" && summary.status !== "completed_degraded") return summary;
  const { request: _archivedInEventJournal, ...operationalSummary } = summary;
  return operationalSummary;
}

function compactStatePoint(point) {
  if (!point || typeof point !== "object") return point;
  const features = point.features ?? {};
  const compactFeatures = Object.fromEntries([
    "open", "high", "low", "previous_close", "volume_semantics",
    "stock_dollar_volume", "data_confidence", "minutes_from_open",
    "minutes_to_close_total"
  ].filter((key) => Object.hasOwn(features, key)).map((key) => [key, features[key]]));
  return {
    symbol: point.symbol,
    anchorAt: point.anchorAt,
    observedAt: point.observedAt,
    price: point.price,
    bid: point.bid,
    ask: point.ask,
    volume: point.volume,
    provider: point.provider,
    sourceRole: point.sourceRole,
    dataTier: point.dataTier,
    features: compactFeatures
  };
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error).slice(0, 1_000)
  };
}

function normalizeSymbols(symbols) {
  const normalized = [...new Set((symbols ?? DEFAULT_SYMBOLS).map((symbol) => String(symbol).trim().toUpperCase()))];
  if (normalized.length === 0) throw new Error("At least one research symbol is required");
  return normalized;
}

function utcFromZonedParts(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - represented;
  }
  return new Date(guess);
}

function zonedParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [
    part.type,
    part.type === "weekday" ? part.value : Number(part.value)
  ]));
}

function dateKeyInZone(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new Error(`Invalid exchange date: ${dateKey}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseClock(clock, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(clock));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`Invalid ${label} clock: ${clock}`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Exchange-session hook. The default deliberately knows weekdays only. Supply
 * calendar(dateKey) from an exchange calendar for holidays and early closes.
 */
export function createUsEquitySessionResolver({
  timeZone = "America/New_York",
  calendar = async (dateKey) => {
    const { year, month, day } = parseDateKey(dateKey);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { isTradingDay: weekday !== 0 && weekday !== 6, open: "09:30", close: "16:00", earlyClose: false };
  }
} = {}) {
  return {
    timeZone,
    async resolve(value) {
      const at = value instanceof Date ? value : new Date(value);
      const dateKey = dateKeyInZone(at, timeZone);
      const schedule = await calendar(dateKey);
      if (!schedule?.isTradingDay) return { dateKey, isTradingDay: false, timeZone };
      const date = parseDateKey(dateKey);
      const openClock = parseClock(schedule.open ?? "09:30", "market-open");
      const closeClock = parseClock(schedule.close ?? "16:00", "market-close");
      const openAt = utcFromZonedParts(date.year, date.month, date.day, openClock.hour, openClock.minute, timeZone);
      const closeAt = utcFromZonedParts(date.year, date.month, date.day, closeClock.hour, closeClock.minute, timeZone);
      if (closeAt <= openAt) throw new Error(`Market close must follow open for ${dateKey}`);
      return {
        dateKey,
        isTradingDay: true,
        timeZone,
        openAt: openAt.toISOString(),
        closeAt: closeAt.toISOString(),
        earlyClose: Boolean(schedule.earlyClose) || (closeAt - openAt) < 6.5 * 60 * MINUTE_MS,
        calendarSource: schedule.source ?? "calendar_hook"
      };
    }
  };
}

export class BoundedTaskQueue {
  constructor({ concurrency = 1, maximumPending = 8 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Queue concurrency must be a positive integer");
    if (!Number.isInteger(maximumPending) || maximumPending < 1) throw new Error("Queue capacity must be a positive integer");
    this.concurrency = concurrency;
    this.maximumPending = maximumPending;
    this.pending = [];
    this.running = 0;
    this.keys = new Set();
    this.closed = false;
    this.drainWaiters = [];
  }

  add(key, task) {
    if (this.closed) return Promise.reject(new Error("Task queue is closed"));
    const normalizedKey = String(key);
    if (this.keys.has(normalizedKey)) return Promise.resolve({ deduplicated: true, key: normalizedKey });
    if (this.pending.length >= this.maximumPending) {
      const error = new Error(`Bounded task queue is full (${this.maximumPending})`);
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }
    this.keys.add(normalizedKey);
    return new Promise((resolve, reject) => {
      this.pending.push({ key: normalizedKey, task, resolve, reject });
      this.#pump();
    });
  }

  async drain() {
    if (this.pending.length === 0 && this.running === 0) return;
    await new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  async close({ cancelPending = false } = {}) {
    this.closed = true;
    if (cancelPending) {
      const error = new Error("Task cancelled during queue shutdown");
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        this.keys.delete(item.key);
        item.reject(error);
      }
    }
    await this.drain();
  }

  #pump() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.running += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        this.running -= 1;
        this.keys.delete(item.key);
        if (this.pending.length === 0 && this.running === 0) {
          for (const resolve of this.drainWaiters.splice(0)) resolve();
        }
        this.#pump();
      });
    }
  }
}

function emptyState(symbols) {
  return {
    schemaVersion: STATE_SCHEMA,
    revision: 0,
    lastJournalSequence: 0,
    phase: "idle",
    session: null,
    lastMinuteSlot: null,
    points: Object.fromEntries(symbols.map((symbol) => [symbol, []])),
    forecasts: [],
    scores: [],
    missedMaturities: [],
    trajectoryObservations: [],
    channelMessages: [],
    channelProcesses: {},
    summary: null,
    invalidTrainingDay: false,
    trainingDayInvalidatedAt: null,
    trainingDayInvalidReason: null,
    warnings: [],
    updatedAt: null
  };
}

function validateRecoveredState(value, symbols) {
  if (!value || value.schemaVersion !== STATE_SCHEMA) return emptyState(symbols);
  return {
    ...emptyState(symbols),
    ...value,
    points: Object.fromEntries(symbols.map((symbol) => [symbol,
      Array.isArray(value.points?.[symbol]) ? value.points[symbol].map(compactStatePoint) : []])),
    forecasts: Array.isArray(value.forecasts) ? value.forecasts.map(compactStoredForecast) : [],
    scores: Array.isArray(value.scores) ? value.scores : [],
    missedMaturities: Array.isArray(value.missedMaturities) ? value.missedMaturities : [],
    trajectoryObservations: Array.isArray(value.trajectoryObservations)
      ? value.trajectoryObservations.map(compactTrajectoryReference)
      : [],
    channelMessages: Array.isArray(value.channelMessages) ? value.channelMessages : [],
    channelProcesses: value.channelProcesses && typeof value.channelProcesses === "object" ? value.channelProcesses : {},
    summary: compactStoredSummary(value.summary),
    warnings: Array.isArray(value.warnings) ? value.warnings : []
  };
}

export class MemoryIntradayStore {
  constructor(initialState = null) {
    this.state = initialState == null ? null : deepClone(initialState);
    this.events = [];
  }

  loadState() {
    return deepClone(this.state);
  }

  commit(event, state) {
    this.state = deepClone(state);
    this.events.push(deepClone(event));
  }

  commitBatch(events, state) {
    this.state = deepClone(state);
    this.events.push(...events.map(deepClone));
  }
}

function normalizedPrediction(prediction) {
  const expectedReturn = finite(prediction?.expectedReturn ?? prediction?.expected_return);
  const probabilityUp = finite(prediction?.probabilityUp ?? prediction?.probability_up);
  const direction = String(prediction?.direction ?? (expectedReturn == null ? "unknown" : expectedReturn > 0 ? "up" : expectedReturn < 0 ? "down" : "flat")).toLowerCase();
  const rawDirection = String(prediction?.rawDirection ?? prediction?.raw_direction ?? direction).toLowerCase();
  const actionableDirection = String(prediction?.actionableDirection ?? prediction?.actionable_direction ?? direction).toLowerCase();
  const explicitlyActionable = typeof prediction?.actionable === "boolean" ? prediction.actionable : null;
  return {
    direction: ["up", "down", "flat"].includes(direction) ? direction : "unknown",
    rawDirection: ["up", "down", "flat"].includes(rawDirection) ? rawDirection : "unknown",
    actionableDirection: ["up", "down", "flat"].includes(actionableDirection) ? actionableDirection : "unknown",
    actionable: explicitlyActionable ?? ["up", "down"].includes(actionableDirection),
    actionability: prediction?.actionability ?? null,
    expectedReturn,
    probabilityUp: probabilityUp == null ? null : clamp(probabilityUp, 0, 1),
    expectedPrice: finite(prediction?.expectedPrice ?? prediction?.expected_price),
    confidence: finite(prediction?.confidence),
    evidenceQuality: finite(prediction?.evidenceQuality ?? prediction?.evidence_quality ?? prediction?.confidence),
    directionalEdge: finite(prediction?.directionalEdge ?? prediction?.directional_edge),
    confidenceSemantics: prediction?.confidenceSemantics ?? prediction?.confidence_semantics ?? null,
    modelVersion: prediction?.modelVersion ?? prediction?.model_version ?? null,
    features: compactPredictionFeatures(prediction?.features)
  };
}

export function scoreIntradayForecast(forecast, point, { neutralDeadband = 0.0003 } = {}) {
  const entryPrice = finite(forecast.entryPrice);
  const exitPrice = finite(point.price);
  if (!(entryPrice > 0) || !(exitPrice > 0)) throw new Error("Forecast score requires positive entry and exit prices");
  const prediction = normalizedPrediction(forecast.prediction);
  const actualReturn = exitPrice / entryPrice - 1;
  const entrySpreadCost = finite(forecast.entryAsk) != null && finite(forecast.entryBid) != null
    ? Math.max(0, forecast.entryAsk - forecast.entryBid) / (2 * entryPrice) : 0;
  const exitSpreadCost = finite(point.ask) != null && finite(point.bid) != null
    ? Math.max(0, point.ask - point.bid) / (2 * exitPrice) : 0;
  const estimatedRoundTripSpreadCost = entrySpreadCost + exitSpreadCost;
  const effectiveNeutralDeadband = Math.max(neutralDeadband, estimatedRoundTripSpreadCost);
  const actualDirection = Math.abs(actualReturn) <= effectiveNeutralDeadband ? "flat" : actualReturn > 0 ? "up" : "down";
  const directionCorrect = prediction.direction !== "unknown" && prediction.direction === actualDirection;
  const actionableDirectionCorrect = prediction.actionable === true
    ? prediction.actionableDirection === actualDirection : null;
  const absoluteReturnError = prediction.expectedReturn == null ? null : Math.abs(actualReturn - prediction.expectedReturn);
  const returnError = prediction.expectedReturn == null ? null : actualReturn - prediction.expectedReturn;
  const huberDelta = 0.0025;
  const huber = absoluteReturnError == null ? null
    : absoluteReturnError <= huberDelta
      ? 0.5 * absoluteReturnError ** 2
      : huberDelta * (absoluteReturnError - 0.5 * huberDelta);
  const outcomeUp = actualReturn > 0 ? 1 : 0;
  const brier = prediction.probabilityUp == null ? null : (prediction.probabilityUp - outcomeUp) ** 2;
  const boundedProbability = prediction.probabilityUp == null ? null : clamp(prediction.probabilityUp, 1e-6, 1 - 1e-6);
  const logLoss = boundedProbability == null ? null
    : -(outcomeUp * Math.log(boundedProbability) + (1 - outcomeUp) * Math.log(1 - boundedProbability));
  const path = prediction.features?.horizonPath ?? {};
  const horizonExpectation = path[String(forecast.horizonMinutes)] ?? path[forecast.horizonMinutes] ?? {};
  const returnVariance = finite(horizonExpectation.return_variance ?? horizonExpectation.returnVariance);
  const returnSigma = returnVariance != null && returnVariance >= 0 ? Math.sqrt(returnVariance) : null;
  const z10 = 1.281551565545;
  const logMean = prediction.expectedReturn != null && prediction.expectedReturn > -1 && returnVariance != null
    ? Math.log1p(prediction.expectedReturn) - 0.5 * returnVariance : null;
  const q10 = logMean != null && returnSigma != null ? Math.expm1(logMean - z10 * returnSigma) : null;
  const q50 = logMean != null ? Math.expm1(logMean) : prediction.expectedReturn;
  const q90 = logMean != null && returnSigma != null ? Math.expm1(logMean + z10 * returnSigma) : null;
  const pinball = (quantile, estimate) => estimate == null ? null
    : actualReturn >= estimate ? quantile * (actualReturn - estimate) : (1 - quantile) * (estimate - actualReturn);
  const pinballValues = [[0.1, q10], [0.5, q50], [0.9, q90]]
    .map(([quantile, estimate]) => pinball(quantile, estimate)).filter((value) => value != null);
  const meanPinball = pinballValues.length
    ? pinballValues.reduce((sum, value) => sum + value, 0) / pinballValues.length : null;
  const standardizedError = returnError != null && returnSigma > 0 ? returnError / returnSigma : null;
  const interval80Hit = q10 != null && q90 != null ? actualReturn >= q10 && actualReturn <= q90 : null;
  const directionalGrossReturn = prediction.actionableDirection === "up" ? actualReturn
    : prediction.actionableDirection === "down" ? -actualReturn : 0;
  const directionPoints = directionCorrect ? 40 : 0;
  const magnitudePoints = absoluteReturnError == null ? 0 : 35 * Math.exp(-absoluteReturnError / 0.0025);
  const probabilityPoints = brier == null ? 0 : 25 * clamp(1 - brier / 0.25, 0, 1);
  return {
    scoreId: `score:${forecast.forecastId}`,
    forecastId: forecast.forecastId,
    source: forecast.source,
    symbol: forecast.symbol,
    issuedAt: forecast.issuedAt,
    maturesAt: forecast.maturesAt,
    evaluatedAt: point.observedAt,
    featureCutoffAt: forecast.prediction?.features?.issuedAt ?? forecast.issuedAt,
    modelAvailableAt: forecast.prediction?.features?.generatedAt ?? forecast.issuedAt,
    originAt: forecast.issuedAt,
    targetAt: forecast.maturesAt,
    labelObservedAt: point.observedAt,
    labelOffsetSeconds: round((Date.parse(point.observedAt) - Date.parse(forecast.maturesAt)) / 1_000, 3),
    entryPrice: round(entryPrice, 6),
    exitPrice: round(exitPrice, 6),
    predictedDirection: prediction.direction,
    rawDirection: prediction.rawDirection,
    actionable: prediction.actionable,
    actionableDirection: prediction.actionableDirection,
    actionableDirectionCorrect,
    actionability: prediction.actionability,
    evidenceQuality: prediction.evidenceQuality,
    directionalEdge: prediction.directionalEdge,
    confidenceSemantics: prediction.confidenceSemantics,
    predictedProbabilityUp: prediction.probabilityUp,
    outcomeUp,
    actualDirection,
    actualReturn: round(actualReturn),
    returnError: returnError == null ? null : round(returnError),
    absoluteReturnError: absoluteReturnError == null ? null : round(absoluteReturnError),
    huber: huber == null ? null : round(huber),
    brier: brier == null ? null : round(brier),
    logLoss: logLoss == null ? null : round(logLoss),
    returnSigma: returnSigma == null ? null : round(returnSigma),
    standardizedError: standardizedError == null ? null : round(standardizedError),
    quantiles: { q10: q10 == null ? null : round(q10), q50: q50 == null ? null : round(q50), q90: q90 == null ? null : round(q90) },
    quantileDistribution: logMean == null ? "unavailable" : "lognormal_return.v1",
    meanPinball: meanPinball == null ? null : round(meanPinball),
    interval80Hit,
    estimatedRoundTripSpreadCost: round(estimatedRoundTripSpreadCost),
    costAdjustedDirectionalReturn: prediction.actionable
      ? round(directionalGrossReturn - estimatedRoundTripSpreadCost) : 0,
    total: round(clamp(directionPoints + magnitudePoints + probabilityPoints, 0, 100), 2),
    components: {
      direction: round(directionPoints, 2),
      magnitude: round(magnitudePoints, 2),
      probability: round(probabilityPoints, 2)
    },
    displayPolicy: "direction40_magnitude35_brier25.v1",
    trainingPolicy: "proper_losses_brier_logloss_huber_lognormal_pinball_cost.v2",
    presentationOnly: ["total", "components"]
  };
}

export function buildSolHighCloseRequest(state) {
  const scores = state.scores ?? [];
  const bySource = {};
  for (const score of scores) {
    const key = String(score.source ?? "unknown");
    const bucket = bySource[key] ??= {
      count: 0, totalScore: 0, directionCorrect: 0,
      actionableCount: 0, actionableDirectionCorrect: 0,
      brier: [], logLoss: [], huber: [], meanPinball: [], interval80Hit: [],
      costAdjustedDirectionalReturn: [], calibration: [], absoluteReturnError: []
    };
    bucket.count += 1;
    bucket.totalScore += finite(score.total, 0);
    bucket.directionCorrect += score.predictedDirection === score.actualDirection ? 1 : 0;
    if (score.actionable === true) {
      bucket.actionableCount += 1;
      bucket.actionableDirectionCorrect += score.actionableDirectionCorrect === true ? 1 : 0;
    }
    if (finite(score.brier) != null) bucket.brier.push(Number(score.brier));
    if (finite(score.logLoss) != null) bucket.logLoss.push(Number(score.logLoss));
    if (finite(score.huber) != null) bucket.huber.push(Number(score.huber));
    if (finite(score.meanPinball) != null) bucket.meanPinball.push(Number(score.meanPinball));
    if (typeof score.interval80Hit === "boolean") bucket.interval80Hit.push(score.interval80Hit ? 1 : 0);
    if (finite(score.costAdjustedDirectionalReturn) != null) bucket.costAdjustedDirectionalReturn.push(Number(score.costAdjustedDirectionalReturn));
    if (finite(score.predictedProbabilityUp) != null && [0, 1].includes(Number(score.outcomeUp))) {
      bucket.calibration.push({ probability: Number(score.predictedProbabilityUp), outcome: Number(score.outcomeUp) });
    }
    if (finite(score.absoluteReturnError) != null) bucket.absoluteReturnError.push(Number(score.absoluteReturnError));
  }
  const sourceMetrics = Object.fromEntries(Object.entries(bySource).map(([source, bucket]) => {
    const calibrationBins = Array.from({ length: 10 }, () => []);
    for (const item of bucket.calibration) calibrationBins[Math.min(9, Math.floor(item.probability * 10))].push(item);
    const expectedCalibrationError = bucket.calibration.length ? calibrationBins.reduce((sum, bin) => {
      if (!bin.length) return sum;
      const meanProbability = bin.reduce((total, item) => total + item.probability, 0) / bin.length;
      const meanOutcome = bin.reduce((total, item) => total + item.outcome, 0) / bin.length;
      return sum + bin.length / bucket.calibration.length * Math.abs(meanProbability - meanOutcome);
    }, 0) : null;
    return [source, {
    count: bucket.count,
    meanScore: round(bucket.totalScore / Math.max(1, bucket.count), 2),
    directionAccuracy: round(bucket.directionCorrect / Math.max(1, bucket.count), 6),
    actionableCoverage: round(bucket.actionableCount / Math.max(1, bucket.count), 6),
    actionableDirectionAccuracy: bucket.actionableCount > 0
      ? round(bucket.actionableDirectionCorrect / bucket.actionableCount, 6) : null,
    meanBrier: bucket.brier.length ? round(bucket.brier.reduce((sum, value) => sum + value, 0) / bucket.brier.length) : null,
    expectedCalibrationError: expectedCalibrationError == null ? null : round(expectedCalibrationError),
    meanLogLoss: bucket.logLoss.length ? round(bucket.logLoss.reduce((sum, value) => sum + value, 0) / bucket.logLoss.length) : null,
    meanHuber: bucket.huber.length ? round(bucket.huber.reduce((sum, value) => sum + value, 0) / bucket.huber.length) : null,
    meanPinball: bucket.meanPinball.length ? round(bucket.meanPinball.reduce((sum, value) => sum + value, 0) / bucket.meanPinball.length) : null,
    interval80Coverage: bucket.interval80Hit.length
      ? round(bucket.interval80Hit.reduce((sum, value) => sum + value, 0) / bucket.interval80Hit.length) : null,
    meanCostAdjustedDirectionalReturn: bucket.costAdjustedDirectionalReturn.length
      ? round(bucket.costAdjustedDirectionalReturn.reduce((sum, value) => sum + value, 0) / bucket.costAdjustedDirectionalReturn.length) : null,
    meanAbsoluteReturnError: bucket.absoluteReturnError.length
      ? round(bucket.absoluteReturnError.reduce((sum, value) => sum + value, 0) / bucket.absoluteReturnError.length)
      : null
    }];
  }));
  return {
    agent: "sol",
    reasoningEffort: "high",
    task: "intraday_research_close_review",
    sessionDate: state.session?.dateKey ?? null,
    researchOnly: true,
    trainingDayEligible: state.invalidTrainingDay !== true,
    prohibitedActions: ["place_order", "replace_order", "cancel_order", "modify_production_weights_without_validation"],
    evidence: {
      session: state.session,
      trainingDay: {
        eligible: state.invalidTrainingDay !== true,
        invalidatedAt: state.trainingDayInvalidatedAt ?? null,
        invalidReason: state.trainingDayInvalidReason ?? null
      },
      sourceMetrics,
      minutePointCounts: Object.fromEntries(Object.entries(state.points ?? {}).map(([symbol, points]) => [symbol, points.length])),
      forecastCount: (state.forecasts ?? []).length,
      scoreCount: scores.length,
      trajectoryObservationCount: (state.trajectoryObservations ?? []).length,
      channelMessageCount: (state.channelMessages ?? []).length,
      warningCount: (state.warnings ?? []).length
    },
    method: {
      objective: "Compare Ocean Wave and Telegram-channel forecasts separately, diagnose regime-dependent error, and propose bounded challenger changes.",
      requiredDiagnostics: [
        "direction accuracy, Brier score, calibration and return MAE by symbol/source/regime",
        "latency, quote synchronization, missing-minute and stale-data diagnostics",
        "trend/mean-reversion, realized volatility, gap, volume/VWAP, cross-asset relative-strength and event-risk attribution",
        "walk-forward validation with purge/embargo before any production promotion"
      ],
      fourierPolicy: "Detrend and window the one-minute series, use leakage-safe FFT/spectral power and phase as bounded features only, and validate out-of-sample. Never fit a sine curve to future targets or extrapolate an unstable dominant frequency by itself.",
      learningPolicy: "Only mature forecasts may update shadow calibration. Keep QQQ, SPY, and each channel source separately identifiable; promote only after adequate walk-forward samples and risk review."
    }
  };
}

function samplePoint(snapshot, symbol, anchorAt) {
  const quote = snapshot?.quotes?.[symbol];
  const price = finite(quote?.price ?? quote?.last ?? quote?.mark);
  const observedAt = quote?.observedAt ?? quote?.observed_at ?? snapshot?.observedAt ?? snapshot?.observed_at;
  if (!(price > 0) || !observedAt) throw new Error(`Synchronized sample is missing a valid ${symbol} quote`);
  return {
    symbol,
    anchorAt,
    observedAt: iso(observedAt),
    price: round(price, 6),
    bid: finite(quote?.bid),
    ask: finite(quote?.ask),
    volume: finite(quote?.volume),
    provider: quote?.provider ?? snapshot?.provider ?? null,
    sourceRole: quote?.sourceRole ?? quote?.source_role ?? snapshot?.sourceRole ?? snapshot?.source_role ?? null,
    dataTier: quote?.dataTier ?? quote?.data_tier ?? snapshot?.dataTier ?? snapshot?.data_tier ?? null,
    crossValidation: quote?.crossValidation ?? quote?.cross_validation ?? snapshot?.crossValidation ?? snapshot?.cross_validation ?? null,
    features: quote?.features ?? snapshot?.features?.[symbol] ?? null
  };
}

function eventEnvelope({ eventKey, sessionDate, eventType, eventAt, symbol = null, source = "ocean_wave", forecastId = null, maturesAt = null, payload = null }) {
  return {
    schemaVersion: EVENT_SCHEMA,
    eventKey: String(eventKey),
    sessionDate: sessionDate ?? null,
    eventType: String(eventType),
    symbol,
    source,
    eventAt: iso(eventAt),
    forecastId,
    maturesAt,
    payload
  };
}

function terminalSummaryStatus(status) {
  return status === "completed" || status === "completed_degraded";
}

export class IntradayResearchOrchestrator {
  constructor({
    symbols = DEFAULT_SYMBOLS,
    sessionResolver = createUsEquitySessionResolver(),
    sampler,
    predictor,
    trajectoryObserver = null,
    matureLearner = null,
    scorer = scoreIntradayForecast,
    channelProcessRunner = null,
    closeSummarizer = null,
    store = new MemoryIntradayStore(),
    clock = { now: () => new Date() },
    scheduler = { setInterval, clearInterval },
    sampleIntervalMs = MINUTE_MS,
    forecastIntervalMinutes = 30,
    horizonMinutes = 30,
    maximumQuoteSkewMs = 3_000,
    maximumScoreLagMs = 90_000,
    maximumScoreAlignmentMs = 5_000,
    maximumChannelEntryLagMs = 90_000,
    maximumPointsPerSymbol = 512,
    maximumForecasts = 128,
    maximumScores = 128,
    maximumTrajectoryObservations = 2_048,
    maximumCatchupSlotsPerAdvance = 30,
    logger = { info() {}, warn() {}, error() {} }
  } = {}) {
    if (!sampler?.sample) throw new Error("Intraday research requires sampler.sample");
    if (!predictor?.forecast) throw new Error("Intraday research requires predictor.forecast");
    this.symbols = normalizeSymbols(symbols);
    this.sessionResolver = sessionResolver;
    this.sampler = sampler;
    this.predictor = predictor;
    this.trajectoryObserver = trajectoryObserver;
    this.matureLearner = matureLearner;
    this.scorer = scorer;
    this.channelProcessRunner = channelProcessRunner;
    this.closeSummarizer = closeSummarizer;
    this.store = store;
    this.clock = clock;
    this.scheduler = scheduler;
    this.sampleIntervalMs = sampleIntervalMs;
    this.forecastIntervalMinutes = forecastIntervalMinutes;
    this.horizonMinutes = horizonMinutes;
    this.maximumQuoteSkewMs = maximumQuoteSkewMs;
    this.maximumScoreLagMs = maximumScoreLagMs;
    this.maximumScoreAlignmentMs = maximumScoreAlignmentMs;
    this.maximumChannelEntryLagMs = maximumChannelEntryLagMs;
    this.maximumPointsPerSymbol = maximumPointsPerSymbol;
    this.maximumForecasts = maximumForecasts;
    this.maximumScores = maximumScores;
    this.maximumTrajectoryObservations = maximumTrajectoryObservations;
    this.maximumCatchupSlotsPerAdvance = maximumCatchupSlotsPerAdvance;
    this.logger = logger;
    this.state = validateRecoveredState(store.loadState?.(), this.symbols);
    this.scoredForecastIds = new Set(this.state.scores.map((item) => item.forecastId));
    this.missedForecastIds = new Set(this.state.missedMaturities.map((item) => item.forecastId));
    this.trajectoryObservationIds = new Set(this.state.trajectoryObservations.map((item) => item.observationId));
    this.operationQueue = new BoundedTaskQueue({ concurrency: 1, maximumPending: 4 });
    this.channelQueue = new BoundedTaskQueue({ concurrency: 2, maximumPending: 16 });
    this.channelHandles = new Map();
    this.timer = null;
  }

  snapshot() {
    return deepClone(this.state);
  }

  statusView() {
    return {
      revision: Number(this.state.revision ?? 0),
      phase: this.state.phase,
      session: this.state.session == null ? null : { ...this.state.session },
      lastMinuteSlot: this.state.lastMinuteSlot,
      invalidTrainingDay: this.state.invalidTrainingDay === true,
      trainingDayInvalidatedAt: this.state.trainingDayInvalidatedAt ?? null,
      trainingDayInvalidReason: this.state.trainingDayInvalidReason ?? null,
      updatedAt: this.state.updatedAt ?? null
    };
  }

  start({ schedule = true } = {}) {
    if (this.timer != null || !schedule) return;
    this.timer = this.scheduler.setInterval(() => {
      const now = this.clock.now();
      this.advance(now).catch((error) => this.logger.error("intraday advance failed", safeError(error)));
    }, Math.min(this.sampleIntervalMs, 5_000));
  }

  advance(value = this.clock.now()) {
    const at = value instanceof Date ? value : new Date(value);
    const key = `advance:${Math.floor(at.getTime() / 1_000)}`;
    return this.operationQueue.add(key, () => this.#advance(at));
  }

  ingestChannelPrediction(message) {
    const channel = String(message?.channel ?? "unknown");
    const messageId = String(message?.messageId ?? message?.message_id ?? "");
    if (!messageId) return Promise.reject(new Error("Channel prediction requires messageId"));
    return this.channelQueue.add(`channel:${channel}:${messageId}`, async () => {
      if (!this.channelProcessRunner?.start) throw new Error("Channel predictions require an isolated channelProcessRunner.start adapter");
      const publishedAt = iso(message.publishedAt ?? message.published_at ?? this.clock.now());
      const dedupeKey = `${channel}:${messageId}`;
      if (this.state.channelMessages.some((item) => item.dedupeKey === dedupeKey)) return { duplicate: true };
      const result = await this.channelProcessRunner.start({
        channel,
        messageId,
        publishedAt,
        payload: message.payload ?? message.prediction ?? null,
        isolatedProcessRequired: true,
        researchOnly: true
      });
      if (result?.isolatedProcess !== true) throw new Error("Channel prediction adapter must confirm isolatedProcess=true");
      return this.operationQueue.add(`channel-state:${dedupeKey}`, () => this.#recordChannelResult(
        message,
        channel,
        messageId,
        publishedAt,
        result
      ));
    });
  }

  invalidateTrainingDay({ reason = "runtime_failure", error = null, at = this.clock.now(), sessionDate = this.state.session?.dateKey } = {}) {
    const normalizedReason = String(reason || "runtime_failure").slice(0, 128);
    return this.operationQueue.add(`training-day-invalid:${sessionDate ?? "unknown"}`, async () => {
      if (!sessionDate || this.state.session?.dateKey !== sessionDate) {
        return { invalidated: false, reason: "session_mismatch" };
      }
      if (this.state.invalidTrainingDay === true) {
        return { invalidated: false, reason: "already_invalid" };
      }
      const invalidatedAt = iso(at);
      this.state.invalidTrainingDay = true;
      this.state.trainingDayInvalidatedAt = invalidatedAt;
      this.state.trainingDayInvalidReason = normalizedReason;
      await this.#commit(eventEnvelope({
        eventKey: `${sessionDate}:training-day:invalid`,
        sessionDate,
        eventType: "training_day_invalidated",
        eventAt: invalidatedAt,
        source: "system",
        payload: { reason: normalizedReason, error: error == null ? null : safeError(error) }
      }));
      return { invalidated: true, reason: normalizedReason };
    });
  }

  async stop({ cancelPending = false } = {}) {
    if (this.timer != null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    await this.operationQueue.drain();
    await this.channelQueue.close({ cancelPending });
    for (const forecastId of [...this.channelHandles.keys()]) await this.#stopChannelProcess(forecastId, "orchestrator_stop");
    const priorPhase = this.state.phase;
    if (!["closed", "closing", "waiting_non_trading_day"].includes(priorPhase)) this.state.phase = "stopped";
    await this.#commit(eventEnvelope({
      eventKey: `${this.state.session?.dateKey ?? "none"}:orchestrator:stopped:${this.state.revision + 1}`,
      sessionDate: this.state.session?.dateKey,
      eventType: "orchestrator_stopped",
      eventAt: this.clock.now(),
      source: "system",
      payload: { clean: true, priorPhase, finalPhase: this.state.phase }
    }));
    await this.operationQueue.close();
  }

  async #advance(at) {
    const session = await this.sessionResolver.resolve(at);
    if (!session?.isTradingDay) {
      if (this.state.phase !== "waiting_non_trading_day") {
        this.state.phase = "waiting_non_trading_day";
        await this.#commit(eventEnvelope({
          eventKey: `${session?.dateKey ?? iso(at)}:non-trading`,
          sessionDate: session?.dateKey,
          eventType: "non_trading_day",
          eventAt: at,
          source: "system"
        }));
      }
      return this.statusView();
    }
    const openMs = Date.parse(session.openAt);
    const closeMs = Date.parse(session.closeAt);
    if (at.getTime() < openMs) {
      if (this.state.phase !== "preopen" || this.state.session?.dateKey !== session.dateKey) {
        this.state.phase = "preopen";
        this.state.session = { ...session, startedAt: null };
        await this.#commit(eventEnvelope({
          eventKey: `${session.dateKey}:preopen`,
          sessionDate: session.dateKey,
          eventType: "preopen_waiting",
          eventAt: at,
          source: "system",
          payload: session
        }));
      }
      return this.statusView();
    }
    if (at.getTime() >= closeMs) {
      if (this.state.session?.dateKey === session.dateKey && !["closed", "stopped"].includes(this.state.phase)) {
        await this.#closeSession(session, at);
      } else if (this.state.session?.dateKey !== session.dateKey) {
        this.state.phase = "closed";
        this.state.session = { ...session, startedAt: null };
      }
      return this.statusView();
    }
    if (this.state.session?.dateKey !== session.dateKey || !this.state.session?.startedAt || ["closed", "stopped", "idle"].includes(this.state.phase)) {
      if (this.state.session?.dateKey === session.dateKey && this.state.session?.startedAt && this.state.phase === "stopped") {
        this.state.phase = "open";
        await this.#commit(eventEnvelope({
          eventKey: `${session.dateKey}:orchestrator:resumed:${this.state.revision + 1}`,
          sessionDate: session.dateKey,
          eventType: "orchestrator_resumed",
          eventAt: at,
          source: "system",
          payload: { lastMinuteSlot: this.state.lastMinuteSlot }
        }));
      } else {
        await this.#openSession(session, at);
      }
    }
    const slot = Math.floor((at.getTime() - openMs) / MINUTE_MS);
    if (this.state.lastMinuteSlot == null || slot > this.state.lastMinuteSlot) {
      const firstMissing = this.state.lastMinuteSlot == null ? slot : this.state.lastMinuteSlot + 1;
      const lastThisAdvance = Math.min(slot, firstMissing + this.maximumCatchupSlotsPerAdvance - 1);
      for (let candidateSlot = firstMissing; candidateSlot <= lastThisAdvance; candidateSlot += 1) {
        const anchorAt = new Date(openMs + candidateSlot * MINUTE_MS).toISOString();
        const historical = candidateSlot < slot;
        const points = await this.#sampleBatch(session, anchorAt, candidateSlot, false, historical);
        if (!points) break;
        const liveObservationAt = historical
          ? anchorAt
          : new Date(Math.max(...Object.values(points).map((point) => Date.parse(point.observedAt)))).toISOString();
        await this.#observeTrajectories(points, liveObservationAt);
        await this.#scoreMatureForecasts(points, liveObservationAt);
        if (!historical) {
          const alreadyIssued = this.state.forecasts.some((forecast) => forecast.source === "ocean_wave" && forecast.sessionDate === session.dateKey && forecast.slot === candidateSlot);
          const needsOpeningCatchup = !this.state.forecasts.some((forecast) => forecast.source === "ocean_wave" && forecast.sessionDate === session.dateKey);
          const forecastMaturesBeforeClose = Date.parse(liveObservationAt) + this.horizonMinutes * MINUTE_MS <= closeMs;
          if (forecastMaturesBeforeClose && !alreadyIssued && (candidateSlot % this.forecastIntervalMinutes === 0 || needsOpeningCatchup)) {
            await this.#issueOceanWaveForecasts(points, liveObservationAt, candidateSlot, needsOpeningCatchup && candidateSlot !== 0 ? "opening_catchup" : "scheduled");
          }
        }
      }
    }
    return this.statusView();
  }

  async #openSession(session, at) {
    const previous = this.state.session;
    this.state = emptyState(this.symbols);
    this.scoredForecastIds.clear();
    this.missedForecastIds.clear();
    this.trajectoryObservationIds.clear();
    this.state.phase = "open";
    this.state.session = { ...session, startedAt: iso(at) };
    if (previous?.dateKey && previous.dateKey !== session.dateKey) {
      this.state.warnings.push({ type: "prior_session_replaced", priorSession: previous.dateKey, at: iso(at) });
    }
    await this.#commit(eventEnvelope({
      eventKey: `${session.dateKey}:session:open`,
      sessionDate: session.dateKey,
      eventType: "session_opened",
      eventAt: at,
      source: "system",
      payload: { ...session, researchOnly: true, tradingEnabled: false }
    }));
  }

  async #sampleBatch(session, anchorAt, slot, closing, historical = false) {
    let snapshot;
    try {
      snapshot = await this.sampler.sample({
        symbols: [...this.symbols],
        asOf: anchorAt,
        session,
        synchronous: true,
        historical,
        researchOnly: true
      });
      const points = Object.fromEntries(this.symbols.map((symbol) => [symbol, samplePoint(snapshot, symbol, anchorAt)]));
      const observedTimes = Object.values(points).map((point) => Date.parse(point.observedAt));
      const skewMs = Math.max(...observedTimes) - Math.min(...observedTimes);
      if (skewMs > this.maximumQuoteSkewMs) throw new Error(`QQQ/SPY quote skew ${skewMs}ms exceeds ${this.maximumQuoteSkewMs}ms`);
      for (const symbol of this.symbols) {
        this.state.points[symbol].push(compactStatePoint(points[symbol]));
        this.state.points[symbol] = this.state.points[symbol].slice(-this.maximumPointsPerSymbol);
      }
      if (!closing) this.state.lastMinuteSlot = slot;
      await this.#commit(eventEnvelope({
        eventKey: `${session.dateKey}:sample:${closing ? "close" : slot}`,
        sessionDate: session.dateKey,
        eventType: closing ? "close_sample_batch" : historical ? "historical_minute_sample_batch" : "minute_sample_batch",
        eventAt: anchorAt,
        source: "market_data",
        payload: { slot, closing, historical, skewMs, points }
      }));
      return points;
    } catch (error) {
      this.state.warnings.push({ type: "sample_rejected", at: anchorAt, error: safeError(error) });
      this.state.warnings = this.state.warnings.slice(-128);
      await this.#commit(eventEnvelope({
        eventKey: `${session.dateKey}:sample-rejected:${closing ? "close" : slot}:${this.state.revision + 1}`,
        sessionDate: session.dateKey,
        eventType: "sample_rejected",
        eventAt: anchorAt,
        source: "market_data",
        payload: safeError(error)
      }));
      return null;
    }
  }

  async #issueOceanWaveForecasts(points, issuedAt, slot, reason) {
    const groupId = `${this.state.session.dateKey}:ocean_wave:${slot}:30m`;
    // Requests are read-only. Clone the synchronized market view once and
    // share it across the two symbol workers instead of copying the full
    // session history separately for QQQ and SPY.
    const synchronizedPoints = deepClone(points);
    const recentPoints = Object.fromEntries(this.symbols.map((item) => [item, deepClone(this.state.points[item])]));
    const results = await Promise.allSettled(this.symbols.map((symbol) => this.predictor.forecast({
      symbol,
      horizonMinutes: this.horizonMinutes,
      issuedAt,
      entryPoint: synchronizedPoints[symbol],
      synchronizedPoints,
      recentPoints,
      source: "ocean_wave",
      researchOnly: true
    })));
    for (let index = 0; index < this.symbols.length; index += 1) {
      const symbol = this.symbols[index];
      const result = results[index];
      if (result.status === "rejected") {
        this.state.warnings.push({ type: "forecast_failed", symbol, at: issuedAt, error: safeError(result.reason) });
        await this.#commit(eventEnvelope({
          eventKey: `${groupId}:${symbol}:failed`,
          sessionDate: this.state.session.dateKey,
          eventType: "forecast_failed",
          eventAt: issuedAt,
          symbol,
          forecastId: `${groupId}:${symbol}`,
          maturesAt: new Date(Date.parse(issuedAt) + this.horizonMinutes * MINUTE_MS).toISOString(),
          payload: safeError(result.reason)
        }));
        continue;
      }
      const forecastId = `${groupId}:${symbol}`;
      if (this.state.forecasts.some((forecast) => forecast.forecastId === forecastId)) continue;
      const forecast = {
        forecastId,
        groupId,
        sessionDate: this.state.session.dateKey,
        source: "ocean_wave",
        symbol,
        slot,
        reason,
        issuedAt,
        entryObservedAt: points[symbol].observedAt,
        entryPrice: points[symbol].price,
        entryBid: points[symbol].bid,
        entryAsk: points[symbol].ask,
        horizonMinutes: this.horizonMinutes,
        maturesAt: new Date(Date.parse(issuedAt) + this.horizonMinutes * MINUTE_MS).toISOString(),
        prediction: normalizedPrediction(result.value),
        immutable: true,
        researchOnly: true
      };
      this.state.forecasts.push(forecast);
      this.state.forecasts = this.state.forecasts.slice(-this.maximumForecasts);
      await this.#commit(eventEnvelope({
        eventKey: `${forecastId}:created`,
        sessionDate: forecast.sessionDate,
        eventType: "forecast_created",
        eventAt: issuedAt,
        symbol,
        source: forecast.source,
        forecastId,
        maturesAt: forecast.maturesAt,
        payload: forecast
      }));
    }
  }

  async #observeTrajectories(points, observedAt) {
    if (!this.trajectoryObserver?.observe) return;
    const events = [];
    for (const forecast of this.state.forecasts) {
      if (this.scoredForecastIds.has(forecast.forecastId) || Date.parse(observedAt) <= Date.parse(forecast.issuedAt) || Date.parse(observedAt) > Date.parse(forecast.maturesAt)) continue;
      const observationId = `${forecast.forecastId}:${observedAt}`;
      if (this.trajectoryObservationIds.has(observationId) || !points[forecast.symbol]) continue;
      try {
        const result = await this.trajectoryObserver.observe({
          forecast: deepClone(forecast),
          point: deepClone(points[forecast.symbol]),
          elapsedMinutes: Math.max(0, (Date.parse(observedAt) - Date.parse(forecast.issuedAt)) / MINUTE_MS),
          mode: "shadow_trajectory_only",
          mutateForecast: false
        });
        this.state.trajectoryObservations.push({ observationId, forecastId: forecast.forecastId, symbol: forecast.symbol, observedAt });
        this.state.trajectoryObservations = this.state.trajectoryObservations.slice(-this.maximumTrajectoryObservations);
        this.trajectoryObservationIds.add(observationId);
        events.push(eventEnvelope({
          eventKey: observationId,
          sessionDate: forecast.sessionDate,
          eventType: "trajectory_observed",
          eventAt: observedAt,
          symbol: forecast.symbol,
          source: forecast.source,
          forecastId: forecast.forecastId,
          maturesAt: forecast.maturesAt,
          payload: { result: result ?? null, mutateForecast: false }
        }));
      } catch (error) {
        this.state.warnings.push({ type: "trajectory_observer_failed", forecastId: forecast.forecastId, error: safeError(error) });
      }
    }
    await this.#commitBatch(events);
  }

  async #scoreMatureForecasts(points, evaluatedAt) {
    for (const forecast of this.state.forecasts) {
      if (this.scoredForecastIds.has(forecast.forecastId) || this.missedForecastIds.has(forecast.forecastId) || !forecast.maturesAt) continue;
      const maturityMs = Date.parse(forecast.maturesAt);
      const evaluatedMs = Date.parse(evaluatedAt);
      const currentPoint = points[forecast.symbol];
      const availabilityMs = Math.max(evaluatedMs, Date.parse(currentPoint?.observedAt ?? ""));
      if (availabilityMs < maturityMs - this.maximumScoreAlignmentMs) continue;
      const candidates = [points[forecast.symbol], ...(this.state.points[forecast.symbol] ?? []).slice(-3)]
        .filter((point) => point && Number.isFinite(Date.parse(point.observedAt)))
        .map((point) => ({ point, offsetMs: Date.parse(point.observedAt) - maturityMs }))
        .filter((item) => Math.abs(item.offsetMs) <= this.maximumScoreAlignmentMs)
        .sort((left, right) => Math.abs(left.offsetMs) - Math.abs(right.offsetMs));
      const aligned = candidates[0] ?? null;
      if (!aligned && availabilityMs <= maturityMs + this.maximumScoreLagMs) continue;
      if (!aligned) {
        const point = points[forecast.symbol];
        if (!point) continue;
        const scoreLagMs = Date.parse(point.observedAt) - maturityMs;
        const record = { forecastId: forecast.forecastId, maturesAt: forecast.maturesAt, firstAvailableAt: point.observedAt, scoreLagMs };
        this.state.missedMaturities.push(record);
        this.state.missedMaturities = this.state.missedMaturities.slice(-this.maximumScores);
        this.missedForecastIds.add(forecast.forecastId);
        await this.#commit(eventEnvelope({
          eventKey: `${forecast.forecastId}:maturity-missed`,
          sessionDate: forecast.sessionDate,
          eventType: "forecast_maturity_missed",
          eventAt: point.observedAt,
          symbol: forecast.symbol,
          source: forecast.source,
          forecastId: forecast.forecastId,
          maturesAt: forecast.maturesAt,
          payload: record
        }));
        if (forecast.source !== "ocean_wave") await this.#stopChannelProcess(forecast.forecastId, "maturity_missed");
        continue;
      }
      try {
        const point = aligned.point;
        const score = await this.scorer(deepClone(forecast), deepClone(point));
        score.targetTimeOffsetMs = aligned.offsetMs;
        score.targetTimeAligned = true;
        score.targetTimeToleranceMs = this.maximumScoreAlignmentMs;
        if (this.state.scores.some((item) => item.scoreId === score.scoreId || item.forecastId === forecast.forecastId)) continue;
        this.state.scores.push(score);
        this.state.scores = this.state.scores.slice(-this.maximumScores);
        this.scoredForecastIds.add(forecast.forecastId);
        await this.#commit(eventEnvelope({
          eventKey: `${forecast.forecastId}:scored`,
          sessionDate: forecast.sessionDate,
          eventType: "forecast_scored",
          eventAt: score.evaluatedAt ?? evaluatedAt,
          symbol: forecast.symbol,
          source: forecast.source,
          forecastId: forecast.forecastId,
          maturesAt: forecast.maturesAt,
          payload: score
        }));
        if (this.state.invalidTrainingDay === true) {
          await this.#commit(eventEnvelope({
            eventKey: `${forecast.forecastId}:learning-skipped:invalid-day`,
            sessionDate: forecast.sessionDate,
            eventType: "mature_forecast_learning_skipped",
            eventAt: score.evaluatedAt ?? evaluatedAt,
            symbol: forecast.symbol,
            source: forecast.source,
            forecastId: forecast.forecastId,
            maturesAt: forecast.maturesAt,
            payload: {
              reason: "invalid_training_day",
              invalidatedAt: this.state.trainingDayInvalidatedAt,
              invalidReason: this.state.trainingDayInvalidReason
            }
          }));
        } else if (this.matureLearner?.learn) {
          const learned = await this.matureLearner.learn({ forecast: deepClone(forecast), score: deepClone(score), mode: "bounded_shadow", mature: true });
          await this.#commit(eventEnvelope({
            eventKey: `${forecast.forecastId}:learned`,
            sessionDate: forecast.sessionDate,
            eventType: "mature_forecast_learned",
            eventAt: score.evaluatedAt ?? evaluatedAt,
            symbol: forecast.symbol,
            source: forecast.source,
            forecastId: forecast.forecastId,
            maturesAt: forecast.maturesAt,
            payload: { mode: "bounded_shadow", result: learned ?? null }
          }));
        }
        if (forecast.source !== "ocean_wave") await this.#stopChannelProcess(forecast.forecastId, "forecast_scored");
      } catch (error) {
        this.state.warnings.push({ type: "forecast_score_failed", forecastId: forecast.forecastId, error: safeError(error) });
      }
    }
  }

  async #recordChannelResult(message, channel, messageId, publishedAt, result) {
    const dedupeKey = `${channel}:${messageId}`;
    if (this.state.channelMessages.some((item) => item.dedupeKey === dedupeKey)) {
      if (this.channelProcessRunner?.stop) await this.channelProcessRunner.stop(result.handle ?? result.processRef, { reason: "duplicate_message" });
      return { duplicate: true };
    }
    const symbol = String(result.forecast?.symbol ?? message.symbol ?? "").toUpperCase();
    const relevant = this.symbols.includes(symbol);
    const processRef = result.processRef == null ? null : String(result.processRef).slice(0, 256);
    const source = `telegram:${channel}`;
    const record = { dedupeKey, channel, messageId, publishedAt, relevant, symbol: symbol || null, source, processRef };
    this.state.channelMessages.push(record);
    this.state.channelMessages = this.state.channelMessages.slice(-256);
    if (!relevant) {
      if (this.channelProcessRunner.stop) await this.channelProcessRunner.stop(result.handle ?? processRef, { reason: "irrelevant_symbol" });
      await this.#commit(eventEnvelope({
        eventKey: `${dedupeKey}:ignored`,
        sessionDate: this.state.session?.dateKey,
        eventType: "channel_prediction_ignored",
        eventAt: publishedAt,
        symbol: symbol || null,
        source,
        payload: record
      }));
      return { relevant: false };
    }
    const horizonMinutes = finite(result.forecast?.horizonMinutes ?? result.forecast?.horizon_minutes);
    const forecastId = `channel:${channel}:${messageId}:${symbol}`;
    const publishedMs = Date.parse(publishedAt);
    const entryPoint = [...(this.state.points[symbol] ?? [])]
      .map((point) => ({ point, lag: Math.abs(Date.parse(point.observedAt) - publishedMs) }))
      .filter((item) => Number.isFinite(item.lag) && item.lag <= this.maximumChannelEntryLagMs)
      .sort((left, right) => left.lag - right.lag)[0]?.point;
    const scoreable = horizonMinutes > 0 && entryPoint?.price > 0;
    const forecast = {
      forecastId,
      sessionDate: this.state.session?.dateKey ?? dateKeyInZone(new Date(publishedAt), "America/New_York"),
      source,
      symbol,
      slot: null,
      reason: "channel_prediction",
      issuedAt: publishedAt,
      entryObservedAt: entryPoint?.observedAt ?? null,
      entryPrice: entryPoint?.price ?? null,
      entryBid: entryPoint?.bid ?? null,
      entryAsk: entryPoint?.ask ?? null,
      horizonMinutes: scoreable ? horizonMinutes : null,
      maturesAt: scoreable ? new Date(Date.parse(publishedAt) + horizonMinutes * MINUTE_MS).toISOString() : null,
      prediction: normalizedPrediction(result.forecast),
      immutable: true,
      isolatedProcess: true,
      contextOnly: !scoreable,
      researchOnly: true
    };
    this.state.forecasts.push(forecast);
    this.state.forecasts = this.state.forecasts.slice(-this.maximumForecasts);
    this.state.channelProcesses[forecastId] = { processRef, status: "running", startedAt: publishedAt };
    this.channelHandles.set(forecastId, result.handle ?? processRef);
    await this.#commit(eventEnvelope({
      eventKey: `${forecastId}:created`,
      sessionDate: forecast.sessionDate,
      eventType: "channel_forecast_created",
      eventAt: publishedAt,
      symbol,
      source,
      forecastId,
      maturesAt: forecast.maturesAt,
      payload: { forecast, processRef, isolatedProcess: true }
    }));
    return deepClone(forecast);
  }

  async #stopChannelProcess(forecastId, reason) {
    const process = this.state.channelProcesses[forecastId];
    if (!process || process.status === "stopped") return;
    const handle = this.channelHandles.get(forecastId) ?? process.processRef;
    try {
      if (this.channelProcessRunner?.stop && handle != null) await this.channelProcessRunner.stop(handle, { reason, forecastId });
      process.status = "stopped";
      process.stoppedAt = iso(this.clock.now());
      process.reason = reason;
      this.channelHandles.delete(forecastId);
      const forecast = this.state.forecasts.find((item) => item.forecastId === forecastId);
      await this.#commit(eventEnvelope({
        eventKey: `${forecastId}:process-stopped:${reason}`,
        sessionDate: forecast?.sessionDate ?? this.state.session?.dateKey,
        eventType: "channel_process_stopped",
        eventAt: process.stoppedAt,
        symbol: forecast?.symbol ?? null,
        source: forecast?.source ?? "telegram",
        forecastId,
        maturesAt: forecast?.maturesAt ?? null,
        payload: { reason, processRef: process.processRef }
      }));
    } catch (error) {
      process.status = "stop_failed";
      this.state.warnings.push({ type: "channel_process_stop_failed", forecastId, error: safeError(error) });
    }
  }

  async #closeSession(session, at) {
    const resumingSummary = this.state.phase === "closing" && this.state.summary?.request;
    this.state.phase = "closing";
    if (!resumingSummary) {
      await this.#commit(eventEnvelope({
        eventKey: `${session.dateKey}:session:closing`,
        sessionDate: session.dateKey,
        eventType: "session_closing",
        eventAt: at,
        source: "system",
        payload: { closeAt: session.closeAt, earlyClose: session.earlyClose }
      }));
      const durationSlots = Math.round((Date.parse(session.closeAt) - Date.parse(session.openAt)) / MINUTE_MS);
      const points = await this.#sampleBatch(session, session.closeAt, durationSlots, true);
      if (points) {
        await this.#observeTrajectories(points, session.closeAt);
        await this.#scoreMatureForecasts(points, session.closeAt);
      }
      for (const forecastId of Object.keys(this.state.channelProcesses)) await this.#stopChannelProcess(forecastId, "market_close");
      const request = buildSolHighCloseRequest(this.state);
      this.state.summary = { status: "requested", requestedAt: iso(at), attempts: 1, request };
      await this.#commit(eventEnvelope({
        eventKey: `${session.dateKey}:sol-high:requested`,
        sessionDate: session.dateKey,
        eventType: "sol_high_summary_requested",
        eventAt: at,
        source: "sol",
        payload: request
      }));
    } else if (!terminalSummaryStatus(this.state.summary.status)) {
      const attempts = Math.max(1, Number(this.state.summary.attempts) || 1) + 1;
      this.state.summary = {
        ...this.state.summary,
        status: "requested",
        requestedAt: iso(at),
        attempts,
        error: null
      };
      await this.#commit(eventEnvelope({
        eventKey: `${session.dateKey}:sol-high:retry:${attempts}`,
        sessionDate: session.dateKey,
        eventType: "sol_high_summary_retried",
        eventAt: at,
        source: "sol",
        payload: { attempts }
      }));
    }
    const request = this.state.summary?.request;
    if (!terminalSummaryStatus(this.state.summary?.status)) {
      let summaryError = null;
      try {
        if (!this.closeSummarizer?.run) throw new Error("Sol high close summarizer is unavailable");
        const result = await this.closeSummarizer.run(deepClone(request));
        const degraded = result?.review_status === "degraded";
        const summaryStatus = degraded ? "completed_degraded" : "completed";
        this.state.summary = { ...this.state.summary, status: summaryStatus, completedAt: iso(this.clock.now()), result: result ?? null };
        if (degraded) {
          await this.#commit(eventEnvelope({
            eventKey: `${session.dateKey}:sol-high:failed:${this.state.summary.attempts ?? 1}`,
            sessionDate: session.dateKey,
            eventType: "sol_high_summary_failed",
            eventAt: this.state.summary.completedAt,
            source: "sol",
            payload: result.degradation ?? { code: "degraded_review" }
          }));
        }
        await this.#commit(eventEnvelope({
          eventKey: `${session.dateKey}:sol-high:${degraded ? "degraded" : "completed"}`,
          sessionDate: session.dateKey,
          eventType: degraded ? "sol_high_summary_degraded" : "sol_high_summary_completed",
          eventAt: this.state.summary.completedAt,
          source: "sol",
          payload: result ?? null
        }));
      } catch (error) {
        summaryError = error;
        this.state.summary = { ...this.state.summary, status: "failed", error: safeError(error) };
        await this.#commit(eventEnvelope({
          eventKey: `${session.dateKey}:sol-high:failed:${this.state.summary.attempts ?? 1}`,
          sessionDate: session.dateKey,
          eventType: "sol_high_summary_failed",
          eventAt: this.clock.now(),
          source: "sol",
          payload: safeError(error)
        }));
      }
      if (summaryError) throw new Error(`Sol high close summary failed: ${safeError(summaryError).message}`, { cause: summaryError });
    }
    this.state.phase = "closed";
    await this.#commit(eventEnvelope({
      eventKey: `${session.dateKey}:session:closed`,
      sessionDate: session.dateKey,
      eventType: "session_closed",
      eventAt: at,
      source: "system",
      payload: { scores: this.state.scores.length, forecasts: this.state.forecasts.length, summaryStatus: this.state.summary.status }
    }));
  }

  async #commit(event) {
    this.state.revision += 1;
    this.state.updatedAt = event.eventAt;
    await this.store.commit(event, this.state);
  }

  async #commitBatch(events) {
    if (!events.length) return;
    if (typeof this.store.commitBatch !== "function") {
      for (const event of events) await this.#commit(event);
      return;
    }
    this.state.revision += events.length;
    this.state.updatedAt = events.at(-1).eventAt;
    await this.store.commitBatch(events, this.state);
  }
}
