import path from "node:path";
import {
  appendLifecycleReview,
  appendModelFeedback,
  appendPositionWorkflowEvent,
  getLatestStageOutput,
  listPositionWorkflowEvents,
  listResumablePositionWorkflows
} from "./db.js";
import { JsonLineWorker } from "./json-line-worker.js";
import { isExactAlignedOptionSnapshot } from "./market-data.js";
import { regularMarketCloseForDate } from "./time.js";

const TERMINAL_EVENTS = new Set(["completed", "expired", "cancelled", "superseded", "awaiting_human_choice"]);

function safeError(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 500);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function compactSnapshot(snapshot) {
  return clone({
    schema_version: snapshot?.schema_version,
    provider: snapshot?.provider,
    source_role: snapshot?.source_role,
    data_tier: snapshot?.data_tier,
    signal_published_at: snapshot?.signal_published_at,
    observed_at: snapshot?.observed_at,
    captured_at: snapshot?.captured_at,
    time_alignment: snapshot?.time_alignment,
    cross_validation: snapshot?.cross_validation,
    market_state: snapshot?.market_state,
    target_contract: snapshot?.target_contract,
    contract_assessment: snapshot?.contract_assessment,
    ocean_wave: snapshot?.ocean_wave,
    runtime: snapshot?.runtime,
    provenance: snapshot?.provenance
  });
}

function compactTerra(terra) {
  if (!terra) return null;
  return clone({
    schema_version: terra.schema_version,
    signal_id: terra.signal_id,
    as_of: terra.as_of,
    status: terra.status,
    contract_analysis: terra.contract_analysis,
    volatility: terra.volatility,
    market_context: terra.market_context,
    events: terra.events,
    inference: terra.inference,
    risk: terra.risk,
    confidence: terra.confidence,
    provenance: terra.provenance
  });
}

function lunaFromSignalHint(row, hint) {
  const hinted = clone(hint?.contract ?? {});
  const entryValue = finite(hinted.entry_price);
  hinted.entry_price = entryValue == null ? null : {
    value: entryValue,
    kind: hinted.price_kind ?? "source_reported_fill",
    raw: hinted.entry_price_raw ?? `@${entryValue}`
  };
  hinted.side = "buy";
  hinted.open_action = "buy_to_open";
  return {
    schema_version: "luna.fast-hint.v1",
    classification: "options_signal",
    signal_id: `raw-${Number(row.id)}:deterministic-hint`,
    evidence: { raw_text: String(row.raw_text ?? ""), spans: [] },
    contract: hinted,
    lifecycle_action: "buy_to_open",
    lifecycle: { kind: "entry", execution_state: hinted.entry_execution_state ?? null },
    deterministic_hint: {
      schema_version: hint?.schema_version ?? null,
      explicit: hint?.explicit === true
    }
  };
}

function workflowIdFor(signalRawMessageId) {
  return `position-raw-${Number(signalRawMessageId)}`;
}

export function createPositionWorkflowManager(config, db, dependencies = {}) {
  const settings = config.positionWorkflow ?? {};
  const enabled = settings.enabled !== false;
  const logger = dependencies.logger ?? console;
  const marketDataRuntime = dependencies.marketDataRuntime;
  const active = new Map();
  const opening = new Map();
  const maxActive = Number(settings.maxActive ?? 16);
  const startupTimeoutMs = Number(settings.workerStartupTimeoutSeconds ?? 5) * 1000;
  const requestTimeoutMs = Number(settings.workerRequestTimeoutSeconds ?? 15) * 1000;
  const shutdownTimeoutMs = Number(settings.workerShutdownTimeoutSeconds ?? 5) * 1000;
  // A known contract expiry is the authoritative lifecycle boundary.  The
  // orphan timeout is only a leak guard for malformed legacy entries whose
  // expiry could not be resolved from the option chain.
  const orphanMaxHoldMs = Number(settings.orphanMaxHoldHours ?? 720) * 60 * 60 * 1000;
  const completionRetryMs = Number(settings.completionRetrySeconds ?? 60) * 1000;
  const marketCloseLocalTime = String(settings.marketCloseLocalTime ?? "13:00");
  const scheduleTimer = dependencies.setTimeout ?? setTimeout;
  const cancelTimer = dependencies.clearTimeout ?? clearTimeout;
  let stopping = false;
  let reasoningSequence = 0;

  function makeWorker(role) {
    const filename = role === "prediction"
      ? "scripts/position-prediction-worker.js"
      : "scripts/position-learning-worker.js";
    const schema = role === "prediction"
      ? "position-prediction-worker.v1"
      : "position-learning-worker.v1";
    return new JsonLineWorker({
      file: process.execPath,
      args: [path.resolve(config.__root, filename)],
      cwd: config.__root,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      startupTimeoutMs,
      requestTimeoutMs,
      shutdownTimeoutMs,
      maxLineBytes: 4 * 1024 * 1024,
      validateReady: (message) => message.schema_version === schema
        && message.multi_workflow === true
        && Array.isArray(message.protocol_versions)
        && message.protocol_versions.includes("v2")
    });
  }

  // Exactly one long-lived process is shared by every prediction workflow and
  // exactly one by every learning workflow.  The child processes isolate the
  // two roles, while their internal workflow_id maps avoid two Node runtimes
  // per open position.
  const sharedRoles = enabled ? {
    prediction: { worker: makeWorker("prediction"), pid: null, queue: Promise.resolve() },
    learning: { worker: makeWorker("learning"), pid: null, queue: Promise.resolve() }
  } : null;

  function queueRole(role, operation) {
    const state = sharedRoles?.[role];
    if (!state) return Promise.reject(new Error(`Shared ${role} worker is disabled`));
    const task = state.queue.then(() => operation(state));
    state.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function replayWorkflowToRole(state, role, workflow) {
    await state.worker.request({
      command: "open",
      workflow_id: workflow.workflowId,
      entry: workflow.entry
    });
    if (role !== "learning") return;
    if (workflow.entryTerra) {
      await state.worker.request({
        command: "enrich",
        workflow_id: workflow.workflowId,
        phase: "entry",
        terra: workflow.entryTerra
      });
    }
    if (workflow.exitTerra) {
      await state.worker.request({
        command: "enrich",
        workflow_id: workflow.workflowId,
        phase: "exit",
        terra: workflow.exitTerra
      });
    }
  }

  function childProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForStaleChildExit(state) {
    const original = state.worker.status();
    if (!original.running || childProcessAlive(original.pid)) return;
    const deadline = Date.now() + Math.min(1_000, startupTimeoutMs);
    while (Date.now() < deadline) {
      const current = state.worker.status();
      if (!current.running || current.pid !== original.pid || childProcessAlive(current.pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function synchronizeRole(state, role) {
    // A child can be gone a few event-loop turns before JsonLineWorker sees
    // its exit event.  Waiting here avoids writing to the stale stdin (EPIPE)
    // and lets start() create the replacement cleanly.
    await waitForStaleChildExit(state);
    await state.worker.start();
    const pid = state.worker.status().pid;
    if (pid == null) throw new Error(`Shared ${role} worker did not expose a pid`);
    if (state.pid === pid) return;
    for (const workflow of active.values()) {
      await replayWorkflowToRole(state, role, workflow);
    }
    state.pid = pid;
  }

  function roleRequest(role, payload) {
    return queueRole(role, async (state) => {
      let firstError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await synchronizeRole(state, role);
          return await state.worker.request(payload);
        } catch (error) {
          firstError ??= error;
          if (attempt > 0) throw firstError;
          const workflow = active.get(String(payload.workflow_id ?? ""));
          if (error?.workerKind === "response" && workflow && payload.command !== "open") {
            await replayWorkflowToRole(state, role, workflow);
          } else {
            // Give the child exit event a turn to clear JsonLineWorker state,
            // then start a replacement and replay every active workflow.
            state.pid = null;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      }
      throw firstError;
    });
  }

  async function releaseWorkflowState(workflow) {
    await Promise.allSettled([
      roleRequest("prediction", { command: "cancel", workflow_id: workflow.workflowId }),
      roleRequest("learning", { command: "cancel", workflow_id: workflow.workflowId })
    ]);
  }

  async function shutdownSharedWorkers() {
    if (!sharedRoles) return;
    await Promise.all(Object.entries(sharedRoles).map(([role, state]) => queueRole(role, async () => {
      try {
        if (state.worker.status().running) {
          await state.worker.request({ command: "shutdown" }, { timeoutMs: shutdownTimeoutMs });
        }
      } catch { /* EOF or process-exit fallback below. */ }
      await state.worker.close();
      state.pid = null;
    })));
  }

  async function spawnWorkflow(workflowId, entry, eventType) {
    try {
      const [predictionRecord, learningRecord] = await Promise.all([
        roleRequest("prediction", { command: "open", workflow_id: workflowId, entry }),
        roleRequest("learning", { command: "open", workflow_id: workflowId, entry })
      ]);
      const workflow = {
        workflowId,
        entry,
        predictionRecord,
        learningRecord,
        entryTerra: null,
        exitTerra: null,
        openedAt: entry.signal.published_at,
        partialExits: [],
        remainingFraction: 1,
        finalizing: false,
        completionRetryTimer: null,
        completionPromise: null
      };
      active.set(workflowId, workflow);
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:${eventType}:${Date.now()}`,
        workflowId,
        signalRawMessageId: entry.signal.raw_message_id,
        eventType,
        payload: {
          worker_scope: "shared_role_processes",
          prediction_pid: sharedRoles.prediction.worker.status().pid,
          learning_pid: sharedRoles.learning.worker.status().pid,
          engine_pid: marketDataRuntime?.status?.().pid ?? null,
          prediction_record: predictionRecord,
          learning_record: learningRecord
        }
      });
      return workflow;
    } catch (error) {
      await Promise.allSettled([
        roleRequest("prediction", { command: "cancel", workflow_id: workflowId }),
        roleRequest("learning", { command: "cancel", workflow_id: workflowId })
      ]);
      throw error;
    }
  }

  function positionEntry(row, luna, marketSnapshot, raw, intakeBasis) {
    const resolvedExpiry = marketSnapshot?.target_contract?.resolved?.expiry
      ?? marketSnapshot?.target_contract?.matched?.expiry
      ?? null;
    const contract = clone(luna.contract ?? {});
    if (!contract.expiry && resolvedExpiry) {
      contract.expiry = resolvedExpiry;
      contract.expiry_resolution = {
        policy: marketSnapshot?.target_contract?.resolved?.expiry_policy ?? "nearest_listed_expiry",
        resolved_expiry: resolvedExpiry,
        inferred: marketSnapshot?.target_contract?.resolved?.expiry_inferred === true
      };
    }
    return {
      schema_version: "position-entry.v1",
      signal: {
        raw_message_id: Number(row.id),
        channel_key: row.channel_key,
        message_id: String(row.telegram_message_id),
        published_at: row.edited_at ?? row.published_at,
        raw_text: String(raw?.raw_text ?? row.raw_text ?? "").slice(0, 4000),
        intake_basis: intakeBasis
      },
      contract,
      luna: clone(luna),
      market_snapshot: compactSnapshot(marketSnapshot)
    };
  }

  async function openNow({ row, luna, marketSnapshot, raw, intakeBasis = "luna_confirmed" }) {
    if (!enabled || stopping) return { status: enabled ? "stopping" : "disabled" };
    const workflowId = workflowIdFor(row.id);
    const existingWorkflow = active.get(workflowId);
    if (existingWorkflow) {
      if (intakeBasis === "luna_confirmed"
          && existingWorkflow.entry?.signal?.intake_basis === "deterministic_signal_hint") {
        existingWorkflow.entry = positionEntry(row, luna, marketSnapshot, raw, "luna_confirmed");
        appendPositionWorkflowEvent(db, {
          eventKey: `${workflowId}:opened:luna_confirmed:v${Number(row.version ?? 1)}`,
          workflowId,
          signalRawMessageId: row.id,
          eventType: "opened",
          payload: { entry: existingWorkflow.entry, confirmation_of: "deterministic_signal_hint" }
        });
        return { status: "confirmed", workflow_id: workflowId };
      }
      return { status: "already_open", workflow_id: workflowId };
    }
    const priorEvents = listPositionWorkflowEvents(db, workflowId);
    const latestOpenedId = Math.max(0, ...priorEvents
      .filter((event) => event.event_type === "opened")
      .map((event) => Number(event.id) || 0));
    if (priorEvents.some((event) => TERMINAL_EVENTS.has(event.event_type)
        && (Number(event.id) || 0) > latestOpenedId)) {
      return { status: "already_terminal", workflow_id: workflowId };
    }
    if (!isExactAlignedOptionSnapshot(
      marketSnapshot,
      row.edited_at ?? row.published_at,
      Number(config.marketData?.maxLiveLagSeconds ?? 300)
    )) {
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:validation_rejected`,
        workflowId,
        signalRawMessageId: row.id,
        eventType: "validation_rejected",
        payload: { reason: "entry quote is not exact, realtime and time-aligned" }
      });
      return { status: "validation_rejected", workflow_id: workflowId };
    }
    if (active.size >= maxActive) {
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:capacity_deferred`,
        workflowId,
        signalRawMessageId: row.id,
        eventType: "capacity_deferred",
        payload: { max_active: maxActive }
      });
      return { status: "capacity_deferred", workflow_id: workflowId };
    }

    const entry = positionEntry(row, luna, marketSnapshot, raw, intakeBasis);
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowId}:opened`,
      workflowId,
      signalRawMessageId: row.id,
      eventType: "opened",
      payload: { entry }
    });
    try {
      const workflow = await spawnWorkflow(workflowId, entry, "processes_started");
      logger.log(`${workflowId}: assigned to shared prediction and learning processes (${sharedRoles.prediction.worker.status().pid}, ${sharedRoles.learning.worker.status().pid})`);
      return { status: "opened", workflow_id: workflowId };
    } catch (error) {
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:start_failed:${Date.now()}`,
        workflowId,
        signalRawMessageId: row.id,
        eventType: "start_failed",
        payload: { error: safeError(error) }
      });
      throw error;
    }
  }

  async function open(request) {
    const workflowId = workflowIdFor(request.row.id);
    const pending = opening.get(workflowId);
    if (pending) {
      try { await pending; } catch { /* The current request gets one clean retry below. */ }
      return openNow(request);
    }
    const operation = openNow(request);
    opening.set(workflowId, operation);
    try {
      return await operation;
    } finally {
      if (opening.get(workflowId) === operation) opening.delete(workflowId);
    }
  }

  async function prime({ row, hint, marketSnapshot }) {
    if (hint?.explicit !== true || hint?.classification !== "options_signal"
        || hint?.action !== "buy_to_open" || !hint?.contract?.symbol
        || hint?.contract?.strike == null || !["call", "put"].includes(hint?.contract?.option_type)) {
      return { status: "not_eligible", workflow_id: workflowIdFor(row.id) };
    }
    const result = await open({
      row,
      luna: lunaFromSignalHint(row, hint),
      marketSnapshot,
      raw: { raw_text: row.raw_text },
      intakeBasis: "deterministic_signal_hint"
    });
    if (result.status === "opened") {
      logger.log(`${result.workflow_id}: numeric prediction recorded from deterministic hint before Luna`);
      return { ...result, status: "primed" };
    }
    return result;
  }

  async function enrich(signalRawMessageId, terra, phase = "entry") {
    const workflowId = workflowIdFor(signalRawMessageId);
    const workflow = active.get(workflowId);
    if (!workflow || !terra) return { status: "not_active", workflow_id: workflowId };
    const normalizedPhase = phase === "exit" ? "exit" : "entry";
    const compacted = compactTerra(terra);
    if (normalizedPhase === "entry") workflow.entryTerra = compacted;
    else workflow.exitTerra = compacted;
    const result = await roleRequest("learning", {
      command: "enrich",
      workflow_id: workflowId,
      phase: normalizedPhase,
      terra: compacted
    });
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowId}:reasoning:${normalizedPhase}:${Date.now()}:${reasoningSequence += 1}`,
      workflowId,
      signalRawMessageId,
      eventType: "reasoning_updated",
      processRole: "learning",
      processPid: sharedRoles.learning.worker.status().pid,
      payload: {
        schema_version: "position-reasoning-event.v2",
        phase: normalizedPhase,
        entry_terra: normalizedPhase === "entry" ? compacted : null,
        exit_terra: normalizedPhase === "exit" ? compacted : null,
        worker_result: result
      }
    });
    return result;
  }

  async function finalizeWorkflow(workflow, { signalRawMessageId, exitRawMessageId, lifecycleReview, terra }) {
    const workflowId = workflow.workflowId;
    if (workflow.completionRetryTimer) cancelTimer(workflow.completionRetryTimer);
    workflow.completionRetryTimer = null;
    let validation = null;
    let feedback = null;
    let completionError = null;
    try {
      if (terra) await enrich(signalRawMessageId, terra, "exit");
      validation = await roleRequest("prediction", {
        command: "finalize",
        workflow_id: workflowId,
        lifecycle_review: lifecycleReview
      });
      feedback = await roleRequest("learning", {
        command: "finalize",
        workflow_id: workflowId,
        validation,
        lifecycle_review: lifecycleReview
      });
      if (feedback.calibration_event && marketDataRuntime?.applyFeedback) {
        feedback.shadow_calibration = await marketDataRuntime.applyFeedback(feedback.calibration_event);
      }
      appendModelFeedback(db, {
        workflowId,
        feedbackVersion: `ocean-wave-feedback.v2:${exitRawMessageId ?? "expiry"}:${workflow.partialExits.length}`,
        status: feedback.status,
        feedback
      });
    } catch (error) {
      completionError = error;
      logger.error(`${workflowId}: completion failed: ${safeError(error)}`);
    }
    if (completionError) {
      const retryRequest = {
        signalRawMessageId,
        exitRawMessageId,
        lifecycleReview: clone(lifecycleReview),
        terra: terra ? compactTerra(terra) : null
      };
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:completion_failed:${Date.now()}:${reasoningSequence += 1}`,
        workflowId,
        signalRawMessageId,
        exitRawMessageId,
        eventType: "completion_failed",
        payload: {
          error: safeError(completionError),
          retry_after_seconds: completionRetryMs / 1000,
          request: {
            signal_raw_message_id: signalRawMessageId,
            exit_raw_message_id: exitRawMessageId,
            lifecycle_review: retryRequest.lifecycleReview,
            exit_terra: retryRequest.terra
          }
        }
      });
      armCompletionRetry(workflow, retryRequest);
      throw completionError;
    }
    {
      const processPids = {
        prediction_pid: sharedRoles.prediction.worker.status().pid,
        learning_pid: sharedRoles.learning.worker.status().pid
      };
      await releaseWorkflowState(workflow);
      active.delete(workflowId);
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflowId}:completed`,
        workflowId,
        signalRawMessageId,
        exitRawMessageId,
        eventType: "completed",
        payload: {
          ...processPids,
          workflow_state_released: true,
          shared_processes_retained: true,
          processes_released: false,
          validation,
          feedback_status: feedback?.status ?? null,
          error: null
        }
      });
    }
    return { status: "completed", workflow_id: workflowId, validation, feedback };
  }

  function runCompletion(workflow, request) {
    if (workflow.completionPromise) return workflow.completionPromise;
    const operation = finalizeWorkflow(workflow, request);
    workflow.completionPromise = operation;
    void operation.finally(() => {
      if (workflow.completionPromise === operation) workflow.completionPromise = null;
    }).catch(() => {});
    return operation;
  }

  function armCompletionRetry(workflow, request) {
    if (workflow.completionRetryTimer) cancelTimer(workflow.completionRetryTimer);
    workflow.completionRetryTimer = scheduleTimer(() => {
      workflow.completionRetryTimer = null;
      if (active.get(workflow.workflowId) !== workflow) return;
      void runCompletion(workflow, request).catch((error) => {
        logger.error(`${workflow.workflowId}: completion retry failed: ${safeError(error)}`);
      });
    }, Math.max(1_000, completionRetryMs));
    workflow.completionRetryTimer.unref?.();
  }

  function aggregateExitReview(workflow, finalReview, finalExitRawMessageId) {
    if (!workflow.partialExits.length) return finalReview;
    const finalFraction = Math.max(0, workflow.remainingFraction);
    const legs = [
      ...workflow.partialExits,
      { exitRawMessageId: finalExitRawMessageId, portfolioFraction: finalFraction, lifecycleReview: finalReview }
    ].filter((leg) => leg.portfolioFraction > 1e-9);
    const totalFraction = legs.reduce((sum, leg) => sum + leg.portfolioFraction, 0);
    const weighted = (selector) => {
      const values = legs.map((leg) => ({ fraction: leg.portfolioFraction, value: finite(selector(leg.lifecycleReview)) }));
      if (values.some((item) => item.value == null)) return null;
      const denominator = values.reduce((sum, item) => sum + item.fraction, 0);
      return denominator > 0 ? values.reduce((sum, item) => sum + item.fraction * item.value, 0) / denominator : null;
    };
    const output = clone(finalReview);
    const exitPrice = weighted((review) => review?.execution_check?.exit_execution_price);
    const grossReturn = weighted((review) => review?.execution_check?.gross_executable_return);
    const holdMinutes = weighted((review) => review?.exit?.hold_minutes);
    output.schema_version = "lifecycle-review.v1.3";
    output.status = legs.every((leg) => leg.lifecycleReview?.status === "scored")
      && exitPrice != null && grossReturn != null
      ? "scored" : "blocked_incomplete_partial_exit_data";
    output.exit = { ...(output.exit ?? {}), hold_minutes: holdMinutes };
    output.execution_check = {
      ...(output.execution_check ?? {}),
      exit_execution_price: exitPrice,
      gross_executable_return: grossReturn,
      exit_basis: "fraction_weighted_source_exits"
    };
    output.partial_exit_aggregation = {
      policy: "portfolio_fraction_weighted",
      total_fraction: totalFraction,
      weighted_exit_price: exitPrice,
      weighted_gross_return: grossReturn,
      exposure_weighted_hold_minutes: holdMinutes,
      legs: legs.map((leg) => ({
        exit_raw_message_id: leg.exitRawMessageId,
        portfolio_fraction: leg.portfolioFraction,
        exit_price: leg.lifecycleReview?.execution_check?.exit_execution_price ?? null,
        gross_return: leg.lifecycleReview?.execution_check?.gross_executable_return ?? null,
        hold_minutes: leg.lifecycleReview?.exit?.hold_minutes ?? null
      }))
    };
    return output;
  }

  async function complete({ signalRawMessageId, exitRawMessageId, lifecycleReview, terra }) {
    const workflowId = workflowIdFor(signalRawMessageId);
    const workflow = active.get(workflowId);
    if (!workflow) return { status: "not_active", workflow_id: workflowId };
    const aggregateReview = aggregateExitReview(workflow, lifecycleReview, exitRawMessageId);
    if (aggregateReview?.partial_exit_aggregation) {
      appendLifecycleReview(db, {
        signalRawMessageId,
        exitRawMessageId,
        reviewVersion: aggregateReview.schema_version ?? "lifecycle-review.v1.3",
        inputManifest: {
          aggregation_policy: aggregateReview.partial_exit_aggregation.policy,
          legs: aggregateReview.partial_exit_aggregation.legs?.map((leg) => ({
            exit_raw_message_id: leg.exit_raw_message_id,
            portfolio_fraction: leg.portfolio_fraction
          })) ?? []
        },
        status: aggregateReview.status ?? "blocked_incomplete_partial_exit_data",
        review: aggregateReview
      });
    }
    return runCompletion(workflow, { signalRawMessageId, exitRawMessageId, lifecycleReview: aggregateReview, terra });
  }

  async function recordPartialExit({ signalRawMessageId, exitRawMessageId, lifecycleReview, terra, exitFraction }) {
    const workflowId = workflowIdFor(signalRawMessageId);
    const workflow = active.get(workflowId);
    if (!workflow) return { status: "not_active", workflow_id: workflowId };
    const fractionOfRemaining = Number(exitFraction);
    if (!Number.isFinite(fractionOfRemaining) || fractionOfRemaining <= 0 || fractionOfRemaining >= 1) {
      return complete({ signalRawMessageId, exitRawMessageId, lifecycleReview, terra });
    }
    if (terra) await enrich(signalRawMessageId, terra, "exit");
    const portfolioFraction = workflow.remainingFraction * fractionOfRemaining;
    workflow.remainingFraction = Math.max(0, workflow.remainingFraction - portfolioFraction);
    workflow.partialExits.push({ exitRawMessageId, portfolioFraction, lifecycleReview: clone(lifecycleReview) });
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowId}:partial_exit:${exitRawMessageId}`,
      workflowId,
      signalRawMessageId,
      exitRawMessageId,
      eventType: "partial_exit",
      payload: {
        fraction_of_remaining: fractionOfRemaining,
        portfolio_fraction: portfolioFraction,
        remaining_fraction: workflow.remainingFraction,
        lifecycle_review: lifecycleReview,
        processes_retained: true
      }
    });
    return {
      status: "partial_exit_recorded",
      workflow_id: workflowId,
      portfolio_fraction: portfolioFraction,
      remaining_fraction: workflow.remainingFraction
    };
  }

  async function recordPositionUpdate({ signalRawMessageId, updateRawMessageId, luna, terra, marketSnapshot }) {
    const workflowId = workflowIdFor(signalRawMessageId);
    const workflow = active.get(workflowId);
    if (!workflow) return { status: "not_active", workflow_id: workflowId };
    const averageCost = finite(luna?.lifecycle?.average_cost);
    if (averageCost != null && averageCost > 0) {
      workflow.entry.current_average_cost = averageCost;
      workflow.entry.current_average_cost_basis = "latest_source_reported_average_cost";
      workflow.entry.current_average_cost_raw_message_id = updateRawMessageId;
    }
    if (terra) await enrich(signalRawMessageId, terra, "update");
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowId}:position_update:${updateRawMessageId}`,
      workflowId,
      signalRawMessageId,
      exitRawMessageId: updateRawMessageId,
      eventType: "position_update",
      payload: {
        kind: luna?.lifecycle?.kind ?? "update",
        average_cost: averageCost,
        average_cost_basis: averageCost != null ? "latest_source_reported_average_cost" : null,
        realtime_snapshot: compactSnapshot(marketSnapshot),
        position_remains_open: true
      }
    });
    return { status: "position_update_recorded", workflow_id: workflowId, average_cost: averageCost };
  }

  async function supersede(signalRawMessageId, reason = "newer_telegram_edit") {
    const workflowId = workflowIdFor(signalRawMessageId);
    const pending = opening.get(workflowId);
    if (pending) {
      try { await pending; } catch { /* A failed opening has no state to release. */ }
    }
    const workflow = active.get(workflowId);
    if (!workflow) return { status: "not_active", workflow_id: workflowId };
    if (workflow.completionRetryTimer) cancelTimer(workflow.completionRetryTimer);
    await releaseWorkflowState(workflow);
    active.delete(workflowId);
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowId}:superseded`,
      workflowId,
      signalRawMessageId,
      eventType: "superseded",
      payload: {
        reason,
        workflow_state_released: true,
        shared_processes_retained: true,
        processes_released: false
      }
    });
    return { status: "superseded", workflow_id: workflowId };
  }

  async function restore() {
    if (!enabled || stopping) return [];
    const restored = [];
    for (const saved of listResumablePositionWorkflows(db)) {
      if (active.size >= maxActive) break;
      const entry = saved.payload?.entry;
      if (!entry?.signal?.raw_message_id) continue;
      try {
        const workflow = await spawnWorkflow(saved.workflow_id, entry, "processes_restored");
        const priorEvents = listPositionWorkflowEvents(db, saved.workflow_id);
        for (const event of priorEvents.filter((candidate) => candidate.event_type === "reasoning_updated")) {
          const phase = event.payload?.phase;
          if (phase === "entry" && event.payload?.entry_terra) {
            workflow.entryTerra = clone(event.payload.entry_terra);
          } else if (phase === "exit" && event.payload?.exit_terra) {
            workflow.exitTerra = clone(event.payload.exit_terra);
          }
        }
        // Workflows created by the pre-shared-worker runtime persisted only a
        // worker status in reasoning_updated.  The full Terra result remains
        // durable in analysis_runs, so recover it once and append a canonical
        // event instead of silently losing the entry rationale on restart.
        if (!workflow.entryTerra) {
          const legacyEntryTerra = getLatestStageOutput(db, saved.signal_raw_message_id, "terra");
          if (legacyEntryTerra) {
            workflow.entryTerra = compactTerra(legacyEntryTerra);
            appendPositionWorkflowEvent(db, {
              eventKey: `${workflow.workflowId}:legacy_entry_terra_recovered`,
              workflowId: workflow.workflowId,
              signalRawMessageId: saved.signal_raw_message_id,
              eventType: "reasoning_updated",
              processRole: "learning",
              payload: {
                phase: "entry",
                entry_terra: workflow.entryTerra,
                exit_terra: null,
                recovery_source: "latest_successful_terra_analysis"
              }
            });
          }
        }
        if (workflow.entryTerra) {
          await roleRequest("learning", {
            command: "enrich",
            workflow_id: workflow.workflowId,
            phase: "entry",
            terra: workflow.entryTerra
          });
        }
        if (workflow.exitTerra) {
          await roleRequest("learning", {
            command: "enrich",
            workflow_id: workflow.workflowId,
            phase: "exit",
            terra: workflow.exitTerra
          });
        }
        for (const event of priorEvents.filter((candidate) => candidate.event_type === "partial_exit")) {
          const portfolioFraction = Number(event.payload?.portfolio_fraction);
          if (!Number.isFinite(portfolioFraction) || portfolioFraction <= 0) continue;
          workflow.partialExits.push({
            exitRawMessageId: event.exit_raw_message_id,
            portfolioFraction,
            lifecycleReview: event.payload?.lifecycle_review ?? null
          });
          workflow.remainingFraction = Math.max(0, workflow.remainingFraction - portfolioFraction);
        }
        const latestCompletionFailure = priorEvents
          .filter((event) => event.event_type === "completion_failed" && event.payload?.request)
          .at(-1);
        if (latestCompletionFailure) {
          const request = latestCompletionFailure.payload.request;
          armCompletionRetry(workflow, {
            signalRawMessageId: Number(request.signal_raw_message_id ?? saved.signal_raw_message_id),
            exitRawMessageId: request.exit_raw_message_id == null ? null : Number(request.exit_raw_message_id),
            lifecycleReview: request.lifecycle_review,
            terra: request.exit_terra ?? null
          });
        }
        restored.push(saved.workflow_id);
      } catch (error) {
        appendPositionWorkflowEvent(db, {
          eventKey: `${saved.workflow_id}:restore_failed:${Date.now()}`,
          workflowId: saved.workflow_id,
          signalRawMessageId: saved.signal_raw_message_id,
          eventType: "restore_failed",
          payload: { error: safeError(error) }
        });
      }
    }
    return restored;
  }

  async function sweepExpired(now = Date.now()) {
    for (const workflow of [...active.values()]) {
      const expiry = workflow.entry?.contract?.expiry
        ?? workflow.entry?.market_snapshot?.target_contract?.matched?.expiry
        ?? null;
      const expiryClose = expiry ? regularMarketCloseForDate(
        expiry,
        config.timezone ?? "America/Los_Angeles",
        marketCloseLocalTime
      ) : null;
      if (expiryClose && now >= expiryClose.getTime() && !workflow.finalizing) {
        workflow.finalizing = true;
        try {
          const snapshot = await marketDataRuntime.capture(config, workflow.entry.luna, new Date(now).toISOString());
          const matched = snapshot?.target_contract?.matched ?? null;
          const entryContract = workflow.entry?.contract ?? {};
          const entryPrice = finite(workflow.entry?.current_average_cost) ?? finite(typeof entryContract.entry_price === "object"
            ? entryContract.entry_price?.value
            : entryContract.entry_price) ?? finite(workflow.entry?.market_snapshot?.target_contract?.matched?.ask);
          const spot = finite(snapshot?.market_state?.underlying_price ?? snapshot?.market_state?.spot);
          const strike = finite(entryContract.strike ?? matched?.strike);
          const optionType = String(entryContract.option_type ?? matched?.option_type ?? "").toLowerCase();
          const bid = finite(matched?.bid);
          const intrinsic = spot != null && strike != null
            ? optionType === "call" ? Math.max(0, spot - strike)
              : optionType === "put" ? Math.max(0, strike - spot) : null
            : null;
          const exitPrice = bid != null && bid >= 0 ? bid : intrinsic;
          const holdMinutes = Math.max(0, (expiryClose.getTime() - Date.parse(workflow.openedAt)) / 60000);
          const grossReturn = entryPrice != null && entryPrice > 0 && exitPrice != null
            ? (exitPrice - entryPrice) / entryPrice : null;
          if (workflow.partialExits.length > 0 && workflow.remainingFraction > 1e-9) {
            appendPositionWorkflowEvent(db, {
              eventKey: `${workflow.workflowId}:awaiting_human_choice`,
              workflowId: workflow.workflowId,
              signalRawMessageId: workflow.entry.signal.raw_message_id,
              eventType: "awaiting_human_choice",
              payload: {
                reason: "expiry_reached_with_unsignaled_remaining_position",
                expiry,
                remaining_fraction: workflow.remainingFraction,
                partial_exit_count: workflow.partialExits.length,
                expiry_reference_price: exitPrice,
                expiry_reference_basis: bid != null && bid >= 0 ? "expiry_last_available_bid" : "intrinsic_settlement_estimate",
                snapshot: compactSnapshot(snapshot),
                operator_choice_required: true
              }
            });
            await releaseWorkflowState(workflow);
            active.delete(workflow.workflowId);
            await Promise.resolve(dependencies.notifier?.send?.(
              "interpretation",
              `Ocean-Wave 到期仓位等待您的选择\n${workflow.entry.contract?.symbol ?? "UNKNOWN"} ${workflow.entry.contract?.strike ?? "?"} ${workflow.entry.contract?.option_type ?? ""}\n剩余仓位 ${(workflow.remainingFraction * 100).toFixed(2)}%，到期参考价 ${exitPrice ?? "缺失"}。请告诉程序如何结算。`
            )).catch(() => {});
            continue;
          }
          const lifecycleReview = {
            schema_version: "lifecycle-review.v1.3",
            status: grossReturn == null ? "blocked_missing_execution_data" : "scored",
            signal: { ...workflow.entry.signal, contract: entryContract, action: "buy_to_open" },
            exit: {
              raw_message_id: null,
              message_id: null,
              published_at: expiryClose.toISOString(),
              action: "sell_to_close_at_expiry",
              hold_minutes: holdMinutes
            },
            entry_prediction: workflow.entry?.market_snapshot?.ocean_wave ?? null,
            entry_prediction_status: "scored_point_in_time",
            execution_check: {
              status: grossReturn == null ? "abstained_missing_execution_input" : "checked_expiry_close",
              entry_execution_price: entryPrice,
              exit_execution_price: exitPrice,
              entry_basis: workflow.entry?.current_average_cost != null
                ? "latest_source_reported_average_cost"
                : entryContract.entry_price ? "source_reported_fill" : "point_in_time_ask",
              exit_basis: bid != null && bid >= 0 ? "expiry_last_available_bid" : "intrinsic_settlement_estimate",
              gross_executable_return: grossReturn,
              accepted_as_executable: grossReturn != null,
              independently_verified: true
            },
            timing: { expiry_close_at: expiryClose.toISOString(), captured_at: snapshot?.captured_at ?? null },
            missing: grossReturn == null ? ["expiry_execution_price"] : [],
            close_policy: "hold_until_expiry_unless_explicit_sell_to_close"
          };
          appendPositionWorkflowEvent(db, {
            eventKey: `${workflow.workflowId}:expiry_close_observed`,
            workflowId: workflow.workflowId,
            signalRawMessageId: workflow.entry.signal.raw_message_id,
            eventType: "expiry_close_observed",
            payload: { expiry, snapshot: compactSnapshot(snapshot), lifecycle_review: lifecycleReview }
          });
          await complete({
            signalRawMessageId: workflow.entry.signal.raw_message_id,
            exitRawMessageId: null,
            lifecycleReview,
            terra: null
          });
          continue;
        } catch (error) {
          workflow.finalizing = false;
          appendPositionWorkflowEvent(db, {
            eventKey: `${workflow.workflowId}:expiry_close_failed:${Date.now()}`,
            workflowId: workflow.workflowId,
            signalRawMessageId: workflow.entry.signal.raw_message_id,
            eventType: "expiry_close_failed",
            payload: { error: safeError(error), retryable: true }
          });
          logger.error(`${workflow.workflowId}: expiry close failed: ${safeError(error)}`);
          continue;
        }
      }
      // Never age out a valid dated option before its expiry close.  Explicit
      // Sell-to-close events are handled by complete()/recordPartialExit().
      if (expiryClose) continue;
      const openedAt = Date.parse(workflow.openedAt);
      if (!Number.isFinite(openedAt) || now - openedAt <= orphanMaxHoldMs) continue;
      if (workflow.completionRetryTimer) cancelTimer(workflow.completionRetryTimer);
      await releaseWorkflowState(workflow);
      active.delete(workflow.workflowId);
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflow.workflowId}:expired`,
        workflowId: workflow.workflowId,
        signalRawMessageId: workflow.entry.signal.raw_message_id,
        eventType: "expired",
        payload: {
          reason: "unresolved-expiry orphan safety limit exceeded",
          orphan_max_hold_hours: Number(settings.orphanMaxHoldHours ?? 720),
          workflow_state_released: true,
          shared_processes_retained: true,
          processes_released: false
        }
      });
    }
  }

  const sweepTimer = enabled ? setInterval(() => {
    void sweepExpired().catch((error) => logger.error(`Position workflow sweep failed: ${safeError(error)}`));
  }, 60_000) : null;
  sweepTimer?.unref?.();

  async function closeAll(reason = "listener_shutdown") {
    if (stopping) return;
    stopping = true;
    if (sweepTimer) clearInterval(sweepTimer);
    await Promise.allSettled([...opening.values()]);
    for (const workflow of [...active.values()]) {
      if (workflow.completionRetryTimer) cancelTimer(workflow.completionRetryTimer);
      active.delete(workflow.workflowId);
      appendPositionWorkflowEvent(db, {
        eventKey: `${workflow.workflowId}:suspended:${Date.now()}`,
        workflowId: workflow.workflowId,
        signalRawMessageId: workflow.entry.signal.raw_message_id,
        eventType: "suspended",
        payload: {
          reason,
          processes_released: true,
          shared_processes_released: true,
          prediction_pid: sharedRoles.prediction.worker.status().pid,
          learning_pid: sharedRoles.learning.worker.status().pid
        }
      });
    }
    await shutdownSharedWorkers();
  }

  return {
    open,
    prime,
    enrich,
    complete,
    recordPartialExit,
    recordPositionUpdate,
    supersede,
    restore,
    sweepExpired,
    closeAll,
    status: () => {
      const prediction = sharedRoles?.prediction.worker.status() ?? { running: false, pid: null };
      const learning = sharedRoles?.learning.worker.status() ?? { running: false, pid: null };
      return {
        enabled,
        active: active.size,
        max_active: maxActive,
        worker_process_count: Number(prediction.running === true) + Number(learning.running === true),
        shared_workers: { prediction, learning }
      };
    }
  };
}

export { workflowIdFor };
