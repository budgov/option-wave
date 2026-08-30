import readline from "node:readline";

const MAX_REQUEST_BYTES = 256 * 1024;
const states = new Map();

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactFactors(snapshot) {
  return (snapshot?.ocean_wave?.factor_table ?? []).slice(0, 32).map((row) => ({
    factor: String(row.factor ?? "unknown").slice(0, 80),
    signal: finite(row.signal),
    confidence: finite(row.confidence),
    dynamic_weight: finite(row.dynamic_weight),
    contribution: finite(row.contribution)
  }));
}

function openPosition(request) {
  const workflowId = String(request.workflow_id);
  const existing = states.get(workflowId);
  if (existing) return learningRecord(existing);
  const source = request.entry ?? {};
  const state = {
    workflow_id: workflowId,
    symbol: source.contract?.symbol ?? null,
    contract: source.contract ?? null,
    factors: compactFactors(source.market_snapshot),
    trend_score: finite(source.market_snapshot?.ocean_wave?.trend_score),
    contract_assessment: source.market_snapshot?.contract_assessment ?? null,
    entry_terra: null,
    exit_terra: null,
    started_at: new Date().toISOString()
  };
  states.set(workflowId, state);
  return learningRecord(state);
}

function learningRecord(state) {
  return {
    schema_version: "position-learning.v1",
    workflow_id: state.workflow_id,
    status: "learning",
    started_at: state.started_at,
    factor_count: state.factors.length,
    initial_hypothesis: {
      trend_score: state.trend_score,
      contract_decision: state.contract_assessment?.decision ?? null,
      strongest_factors: [...state.factors]
        .sort((left, right) => Math.abs(right.contribution ?? 0) - Math.abs(left.contribution ?? 0))
        .slice(0, 3)
    }
  };
}

function enrich(request) {
  const workflowId = String(request.workflow_id);
  const state = states.get(workflowId);
  if (!state) throw new Error("workflow is not open");
  const phase = request.phase === "exit" ? "exit" : "entry";
  const terra = request.terra ?? null;
  state[phase === "entry" ? "entry_terra" : "exit_terra"] = terra == null
    ? null
    : JSON.parse(JSON.stringify(terra));
  return {
    schema_version: "position-learning.v1",
    workflow_id: state.workflow_id,
    status: "reasoning_updated",
    phase,
    entry_terra_present: state.entry_terra != null,
    exit_terra_present: state.exit_terra != null
  };
}

function finalizePosition(request) {
  const workflowId = String(request.workflow_id);
  const state = states.get(workflowId);
  if (!state) throw new Error("workflow is not open");
  const validation = request.validation ?? {};
  const eligible = validation.status === "verified"
    && typeof validation.observed_profitable === "boolean"
    && finite(validation.predicted_profit_probability) != null;
  const observedSign = validation.observed_profitable === true ? 1 : -1;
  const factorCredit = state.factors.map((factor) => ({
    factor: factor.factor,
    entry_signal: factor.signal,
    entry_weight: factor.dynamic_weight,
    outcome_aligned: eligible && factor.signal != null ? Math.sign(factor.signal) === observedSign : null,
    bounded_credit: eligible && factor.signal != null && factor.confidence != null
      ? Math.max(-0.01, Math.min(0.01, observedSign * factor.signal * factor.confidence * 0.01))
      : 0
  }));
  const result = {
    schema_version: "ocean-wave-feedback.v1",
    workflow_id: state.workflow_id,
    status: eligible ? "challenger_update_eligible" : "insufficient_verified_data",
    deployment_status: "shadow_only",
    completed_at: new Date().toISOString(),
    symbol: state.symbol,
    contract: state.contract,
    validation,
    calibration_event: eligible ? {
      event_id: state.workflow_id,
      symbol: state.symbol,
      option_type: validation.option_type,
      predicted_profit_probability: validation.predicted_profit_probability,
      observed_profitable: validation.observed_profitable,
      gross_executable_return: validation.gross_executable_return,
      selected_horizon_minutes: validation.selected_horizon_minutes
    } : null,
    reasoning: {
      entry_contract_assessment: state.contract_assessment,
      entry_terra: state.entry_terra,
      exit_terra: state.exit_terra,
      factor_credit: factorCredit,
      rule: "bounded online calibration only; production weights require out-of-sample promotion"
    }
  };
  states.delete(workflowId);
  return result;
}

function cancelPosition(request) {
  const workflowId = String(request.workflow_id);
  const removed = states.delete(workflowId);
  return {
    schema_version: "position-learning.v1",
    workflow_id: workflowId,
    status: removed ? "cancelled" : "not_open"
  };
}

function execute(request) {
  switch (request.command) {
    case "open": return openPosition(request);
    case "enrich": return enrich(request);
    case "finalize":
    case "exit": return finalizePosition(request);
    case "cancel": return cancelPosition(request);
    case "shutdown":
      states.clear();
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
input.on("close", () => { states.clear(); });
emit({
  schema_version: "position-learning-worker.v1",
  event: "ready",
  protocol_versions: ["v1", "v2"],
  multi_workflow: true
});
