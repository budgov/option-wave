import readline from "node:readline";

const MAX_REQUEST_BYTES = 256 * 1024;
const entries = new Map();

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function expectations(snapshot) {
  return Object.values(snapshot?.ocean_wave?.expectations ?? {})
    .map((item) => ({
      horizon_minutes: finite(item?.horizon_minutes),
      probability_up: finite(item?.probability_up),
      expected_return: finite(item?.expected_return)
    }))
    .filter((item) => item.horizon_minutes != null && item.probability_up != null)
    .sort((left, right) => left.horizon_minutes - right.horizon_minutes);
}

function verifiedSnapshot(snapshot) {
  const target = snapshot?.target_contract;
  const ask = finite(target?.matched?.ask);
  return snapshot?.provider === "schwab"
    && snapshot?.data_tier === "realtime"
    && snapshot?.time_alignment?.aligned === true
    && target?.matched != null
    && target.exact_expiry_match === true
    && target.exact_strike_match === true
    && target.exact_option_type_match === true
    && snapshot?.ocean_wave?.native_core === true
    && ask != null && ask > 0;
}

function closestExpectation(items, holdMinutes) {
  if (!items.length) return null;
  return items.reduce((best, item) => (
    Math.abs(item.horizon_minutes - holdMinutes) < Math.abs(best.horizon_minutes - holdMinutes) ? item : best
  ));
}

function openPosition(request) {
  const workflowId = String(request.workflow_id);
  const existing = entries.get(workflowId);
  if (existing) return existing;
  const snapshot = request?.entry?.market_snapshot;
  if (!verifiedSnapshot(snapshot)) throw new Error("entry quote or native Ocean Wave prediction is not verified");
  const contract = request.entry.contract ?? snapshot.target_contract.requested;
  const prediction = {
    schema_version: "position-prediction.v1",
    workflow_id: workflowId,
    recorded_at: new Date().toISOString(),
    engine: "ocean-wave-native-core",
    provider: snapshot.provider,
    quote_observed_at: snapshot.target_contract.matched.quote_timestamp ?? snapshot.observed_at,
    contract,
    entry_ask: finite(snapshot.target_contract.matched.ask),
    entry_bid: finite(snapshot.target_contract.matched.bid),
    trend_score: finite(snapshot.ocean_wave.trend_score),
    direction: snapshot.ocean_wave.direction ?? null,
    confidence: finite(snapshot.ocean_wave.confidence),
    contract_decision: snapshot.contract_assessment?.decision ?? "abstain",
    contract_reasons: snapshot.contract_assessment?.reasons ?? [],
    expectations: expectations(snapshot)
  };
  if (!prediction.expectations.length) throw new Error("Ocean Wave did not return probability expectations");
  entries.set(workflowId, prediction);
  return prediction;
}

function enrichPosition(request) {
  const workflowId = String(request.workflow_id);
  if (!entries.has(workflowId)) throw new Error("workflow is not open");
  return {
    schema_version: "position-prediction.v1",
    workflow_id: workflowId,
    status: "prediction_context_retained"
  };
}

function finalizePosition(request) {
  const workflowId = String(request.workflow_id);
  const entry = entries.get(workflowId);
  if (!entry) throw new Error("workflow is not open");
  const review = request.lifecycle_review;
  const grossReturn = finite(review?.execution_check?.gross_executable_return);
  const holdMinutes = finite(review?.exit?.hold_minutes);
  const selected = closestExpectation(entry.expectations, holdMinutes ?? 0);
  const optionType = String(entry.contract?.option_type ?? "").toLowerCase();
  const rawProbability = selected?.probability_up;
  const profitProbability = rawProbability == null ? null
    : optionType === "put" ? 1 - rawProbability
      : optionType === "call" ? rawProbability : null;
  const observedProfitable = grossReturn == null ? null : grossReturn > 0;
  const probability = profitProbability == null ? null : Math.min(1 - 1e-6, Math.max(1e-6, profitProbability));
  const outcome = observedProfitable == null ? null : Number(observedProfitable);
  const verified = review?.status === "scored" && entry.contract_decision !== "abstain"
    && probability != null && outcome != null;
  const result = {
    schema_version: "prediction-validation.v1",
    workflow_id: entry.workflow_id,
    status: verified ? "verified" : "abstained",
    validated_at: new Date().toISOString(),
    hold_minutes: holdMinutes,
    selected_horizon_minutes: selected?.horizon_minutes ?? null,
    option_type: optionType || null,
    predicted_profit_probability: probability,
    entry_contract_decision: entry.contract_decision,
    observed_profitable: observedProfitable,
    gross_executable_return: grossReturn,
    brier_score: verified ? (probability - outcome) ** 2 : null,
    log_loss: verified ? -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability)) : null,
    correct_at_half_threshold: verified ? (probability >= 0.5) === observedProfitable : null
  };
  entries.delete(workflowId);
  return result;
}

function cancelPosition(request) {
  const workflowId = String(request.workflow_id);
  const removed = entries.delete(workflowId);
  return {
    schema_version: "position-prediction.v1",
    workflow_id: workflowId,
    status: removed ? "cancelled" : "not_open"
  };
}

function execute(request) {
  switch (request.command) {
    case "open": return openPosition(request);
    case "enrich": return enrichPosition(request);
    case "finalize":
    case "exit": return finalizePosition(request);
    case "cancel": return cancelPosition(request);
    case "shutdown":
      entries.clear();
      return { status: "stopping" };
    default: throw new Error("unsupported command");
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let id = null;
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) throw new Error("request exceeds size limit");
    const request = JSON.parse(line);
    id = request.id ?? null;
    emit({ id, ok: true, result: execute(request) });
    if (request.command === "shutdown") input.close();
  } catch (error) {
    emit({ id, ok: false, error: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 400) });
  }
});
input.on("close", () => { entries.clear(); });
emit({
  schema_version: "position-prediction-worker.v1",
  event: "ready",
  protocol_versions: ["v1", "v2"],
  multi_workflow: true
});
