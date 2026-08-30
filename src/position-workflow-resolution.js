import crypto from "node:crypto";
import { appendPositionWorkflowEvent, listPositionWorkflowEvents } from "./db.js";

const CLOSED_TERMINAL_EVENTS = new Set(["completed", "expired", "cancelled", "superseded"]);
const RESOLUTION_EVENT = "human_choice_resolved";
const EPSILON = 1e-9;

function finite(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function normalizeRequest(request) {
  const workflowId = String(request?.workflowId ?? "").trim();
  if (!workflowId) throw new Error("Missing --workflow-id.");

  const disposition = request?.disposition == null ? null : String(request.disposition).trim();
  const hasExitPrice = request?.exitPrice !== undefined && request?.exitPrice !== null && request?.exitPrice !== "";
  const hasExitAt = request?.exitAt !== undefined && request?.exitAt !== null && request?.exitAt !== "";
  if (disposition) {
    if (disposition !== "unscored-no-settlement") {
      throw new Error("--disposition must be unscored-no-settlement.");
    }
    if (hasExitPrice || hasExitAt) {
      throw new Error("An unscored/no-settlement disposition cannot include --exit-price or --exit-at.");
    }
    return { workflowId, disposition, exitPrice: null, exitAt: null };
  }

  if (!hasExitPrice || !hasExitAt) {
    throw new Error("Closing the remainder requires both --exit-price and --exit-at.");
  }
  const exitPrice = finite(request.exitPrice);
  if (exitPrice == null || exitPrice < 0) throw new Error("--exit-price must be a finite non-negative number.");
  const exitAtInput = String(request.exitAt).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(exitAtInput)) {
    throw new Error("--exit-at must be an ISO 8601 timestamp with an explicit timezone.");
  }
  const parsedExitAt = Date.parse(exitAtInput);
  if (!Number.isFinite(parsedExitAt)) throw new Error("--exit-at must be a valid timestamp.");
  return {
    workflowId,
    disposition: "settled-final-exit",
    exitPrice,
    exitAt: new Date(parsedExitAt).toISOString()
  };
}

function fingerprint(normalized) {
  return crypto.createHash("sha256").update(JSON.stringify({
    schema_version: "human-choice-resolution.v1",
    workflow_id: normalized.workflowId,
    disposition: normalized.disposition,
    exit_price: normalized.exitPrice,
    exit_at: normalized.exitAt
  })).digest("hex");
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(`Persisted ${label} is inconsistent with geometric partial exits.`);
  }
}

function entryPriceFrom(entry, events) {
  const latestAverageCost = events
    .filter((event) => event.event_type === "position_update")
    .map((event) => finite(event.payload?.average_cost))
    .filter((value) => value != null && value > 0)
    .at(-1);
  if (latestAverageCost != null) return { value: latestAverageCost, basis: "latest_source_reported_average_cost" };
  const contractPrice = typeof entry?.contract?.entry_price === "object"
    ? finite(entry.contract.entry_price?.value)
    : finite(entry?.contract?.entry_price);
  if (contractPrice != null && contractPrice > 0) return { value: contractPrice, basis: "source_reported_fill" };
  const ask = finite(entry?.market_snapshot?.target_contract?.matched?.ask);
  return ask != null && ask > 0 ? { value: ask, basis: "point_in_time_ask" } : { value: null, basis: null };
}

function reconstruct(events) {
  const opened = events.filter((event) => event.event_type === "opened").at(-1);
  const entry = opened?.payload?.entry;
  if (!opened || !entry?.signal) throw new Error("Workflow has no reconstructable opened entry event.");
  const scoped = events.filter((event) => Number(event.id) >= Number(opened.id));
  let remainingFraction = 1;
  const partialExits = [];
  for (const event of scoped.filter((candidate) => candidate.event_type === "partial_exit")) {
    const fractionOfRemaining = finite(event.payload?.fraction_of_remaining);
    if (fractionOfRemaining == null || fractionOfRemaining <= 0 || fractionOfRemaining >= 1) {
      throw new Error(`Partial-exit event ${event.id} has an invalid fraction_of_remaining.`);
    }
    const portfolioFraction = remainingFraction * fractionOfRemaining;
    const persistedPortfolioFraction = finite(event.payload?.portfolio_fraction);
    if (persistedPortfolioFraction != null) {
      assertClose(persistedPortfolioFraction, portfolioFraction, `portfolio_fraction in event ${event.id}`);
    }
    remainingFraction = Math.max(0, remainingFraction - portfolioFraction);
    const persistedRemaining = finite(event.payload?.remaining_fraction);
    if (persistedRemaining != null) {
      assertClose(persistedRemaining, remainingFraction, `remaining_fraction in event ${event.id}`);
    }
    partialExits.push({
      event_id: Number(event.id),
      exit_raw_message_id: event.exit_raw_message_id,
      fraction_of_remaining: fractionOfRemaining,
      portfolio_fraction: portfolioFraction,
      lifecycle_review: event.payload?.lifecycle_review ?? null
    });
  }
  return {
    opened,
    entry,
    events: scoped,
    partialExits,
    remainingFraction,
    entryPrice: entryPriceFrom(entry, scoped)
  };
}

function weightedLegValue(legs, selector) {
  const values = legs.map((leg) => ({ fraction: leg.portfolio_fraction, value: finite(selector(leg)) }));
  if (values.some((item) => item.value == null)) return null;
  const denominator = values.reduce((sum, item) => sum + item.fraction, 0);
  return denominator > 0
    ? values.reduce((sum, item) => sum + item.fraction * item.value, 0) / denominator
    : null;
}

function buildResolution(normalized, state, awaiting) {
  const openedAt = Date.parse(String(state.entry.signal.published_at ?? state.opened.created_at));
  if (!Number.isFinite(openedAt)) throw new Error("Workflow entry timestamp cannot be reconstructed.");
  const awaitingRemaining = finite(awaiting.payload?.remaining_fraction);
  if (awaitingRemaining != null) assertClose(awaitingRemaining, state.remainingFraction, "awaiting-choice remaining_fraction");
  const awaitingCount = finite(awaiting.payload?.partial_exit_count);
  if (awaitingCount != null && awaitingCount !== state.partialExits.length) {
    throw new Error("Persisted partial_exit_count is inconsistent with workflow events.");
  }
  if (state.partialExits.length === 0 || state.remainingFraction <= EPSILON) {
    throw new Error("Awaiting-human-choice workflow does not have a partial exit and positive remainder.");
  }

  const partialLegs = state.partialExits.map((leg) => ({
    kind: "partial_exit",
    exit_raw_message_id: leg.exit_raw_message_id,
    fraction_of_remaining: leg.fraction_of_remaining,
    portfolio_fraction: leg.portfolio_fraction,
    exit_price: finite(leg.lifecycle_review?.execution_check?.exit_execution_price),
    gross_return: finite(leg.lifecycle_review?.execution_check?.gross_executable_return),
    hold_minutes: finite(leg.lifecycle_review?.exit?.hold_minutes),
    review_status: leg.lifecycle_review?.status ?? null
  }));

  if (normalized.disposition === "unscored-no-settlement") {
    return {
      status: "unscored_no_settlement",
      lifecycleReview: {
        schema_version: "lifecycle-review.v1.3",
        status: "unscored_no_settlement",
        signal: { ...state.entry.signal, contract: state.entry.contract, action: "buy_to_open" },
        exit: { action: "operator_unscored_no_settlement", published_at: null, hold_minutes: null },
        execution_check: {
          status: "unscored_no_settlement",
          entry_execution_price: state.entryPrice.value,
          entry_basis: state.entryPrice.basis,
          exit_execution_price: null,
          exit_basis: "operator_declined_settlement",
          gross_executable_return: null,
          accepted_as_executable: false,
          independently_verified: false
        },
        partial_exit_aggregation: {
          policy: "geometric_fraction_of_remaining_reconstructed_from_events",
          total_fraction: 1 - state.remainingFraction,
          remaining_fraction: state.remainingFraction,
          legs: [...partialLegs, {
            kind: "unsettled_remainder",
            exit_raw_message_id: null,
            portfolio_fraction: state.remainingFraction,
            exit_price: null,
            gross_return: null,
            hold_minutes: null,
            review_status: "unscored_no_settlement"
          }]
        },
        missing: ["final_exit_price", "final_exit_timestamp"],
        close_policy: "operator_explicit_unscored_no_settlement"
      }
    };
  }

  const exitAtMs = Date.parse(normalized.exitAt);
  if (exitAtMs < openedAt) throw new Error("--exit-at cannot precede the workflow entry timestamp.");
  const holdMinutes = (exitAtMs - openedAt) / 60000;
  const grossReturn = state.entryPrice.value != null
    ? (normalized.exitPrice - state.entryPrice.value) / state.entryPrice.value
    : null;
  const finalLeg = {
    kind: "operator_final_exit",
    exit_raw_message_id: null,
    portfolio_fraction: state.remainingFraction,
    exit_price: normalized.exitPrice,
    gross_return: grossReturn,
    hold_minutes: holdMinutes,
    review_status: grossReturn == null ? "blocked_missing_execution_data" : "scored"
  };
  const legs = [...partialLegs, finalLeg];
  const weightedExitPrice = weightedLegValue(legs, (leg) => leg.exit_price);
  const weightedGrossReturn = weightedLegValue(legs, (leg) => leg.gross_return);
  const weightedHoldMinutes = weightedLegValue(legs, (leg) => leg.hold_minutes);
  const scored = legs.every((leg) => leg.review_status === "scored")
    && weightedExitPrice != null && weightedGrossReturn != null;
  return {
    status: scored ? "scored" : "blocked_incomplete_partial_exit_data",
    lifecycleReview: {
      schema_version: "lifecycle-review.v1.3",
      status: scored ? "scored" : "blocked_incomplete_partial_exit_data",
      signal: { ...state.entry.signal, contract: state.entry.contract, action: "buy_to_open" },
      exit: {
        raw_message_id: null,
        message_id: null,
        published_at: normalized.exitAt,
        action: "operator_sell_to_close_remainder",
        hold_minutes: weightedHoldMinutes
      },
      entry_prediction: state.entry?.market_snapshot?.ocean_wave ?? null,
      entry_prediction_status: "scored_point_in_time",
      execution_check: {
        status: scored ? "checked_operator_final_exit" : "blocked_incomplete_partial_exit_data",
        entry_execution_price: state.entryPrice.value,
        entry_basis: state.entryPrice.basis,
        exit_execution_price: weightedExitPrice,
        exit_basis: "fraction_weighted_source_exits_and_operator_final_exit",
        gross_executable_return: weightedGrossReturn,
        accepted_as_executable: scored,
        independently_verified: false,
        operator_final_exit_price: normalized.exitPrice
      },
      timing: { operator_final_exit_at: normalized.exitAt },
      partial_exit_aggregation: {
        policy: "geometric_fraction_of_remaining_reconstructed_from_events",
        total_fraction: legs.reduce((sum, leg) => sum + leg.portfolio_fraction, 0),
        remaining_fraction_before_resolution: state.remainingFraction,
        weighted_exit_price: weightedExitPrice,
        weighted_gross_return: weightedGrossReturn,
        exposure_weighted_hold_minutes: weightedHoldMinutes,
        legs
      },
      missing: scored ? [] : ["complete_partial_exit_execution_data"],
      close_policy: "operator_supplied_final_exit_for_unsignaled_remainder"
    }
  };
}

export function resolveAwaitingHumanChoice(db, request) {
  const normalized = normalizeRequest(request);
  const resolutionFingerprint = fingerprint(normalized);
  db.exec("BEGIN IMMEDIATE");
  try {
    const events = listPositionWorkflowEvents(db, normalized.workflowId);
    if (events.length === 0) throw new Error(`Unknown workflow_id: ${normalized.workflowId}`);
    const priorResolution = events.filter((event) => event.event_type === RESOLUTION_EVENT).at(-1);
    if (priorResolution) {
      if (priorResolution.payload?.resolution_fingerprint !== resolutionFingerprint) {
        throw new Error(`Workflow ${normalized.workflowId} was already resolved with a different disposition.`);
      }
      const completed = events.find((event) => event.event_type === "completed"
        && event.payload?.resolution_fingerprint === resolutionFingerprint);
      if (!completed) throw new Error(`Workflow ${normalized.workflowId} has an incomplete prior human resolution.`);
      db.exec("COMMIT");
      return {
        status: "already_resolved",
        workflow_id: normalized.workflowId,
        disposition: normalized.disposition,
        resolution_fingerprint: resolutionFingerprint
      };
    }

    const state = reconstruct(events);
    const terminalAfterOpen = state.events.filter((event) => CLOSED_TERMINAL_EVENTS.has(event.event_type));
    if (terminalAfterOpen.length > 0) {
      throw new Error(`Workflow ${normalized.workflowId} is already terminal (${terminalAfterOpen.at(-1).event_type}).`);
    }
    const awaiting = state.events.filter((event) => event.event_type === "awaiting_human_choice").at(-1);
    if (!awaiting) throw new Error(`Workflow ${normalized.workflowId} is not awaiting human choice.`);
    const resolution = buildResolution(normalized, state, awaiting);
    const signalRawMessageId = Number(state.opened.signal_raw_message_id);
    const common = {
      schema_version: "human-choice-resolution.v1",
      resolution_fingerprint: resolutionFingerprint,
      disposition: normalized.disposition,
      operator_final_exit_price: normalized.exitPrice,
      operator_final_exit_at: normalized.exitAt,
      awaiting_event_id: Number(awaiting.id),
      reconstructed_partial_exit_count: state.partialExits.length,
      reconstructed_remaining_fraction: state.remainingFraction,
      settled_fraction: normalized.disposition === "settled-final-exit" ? state.remainingFraction : 0,
      unsettled_unscored_fraction: normalized.disposition === "unscored-no-settlement" ? state.remainingFraction : 0,
      remaining_fraction_after_resolution: normalized.disposition === "settled-final-exit" ? 0 : null,
      lifecycle_review: resolution.lifecycleReview
    };
    appendPositionWorkflowEvent(db, {
      eventKey: `${normalized.workflowId}:human_choice_resolved`,
      workflowId: normalized.workflowId,
      signalRawMessageId,
      eventType: RESOLUTION_EVENT,
      payload: common
    });
    appendPositionWorkflowEvent(db, {
      eventKey: `${normalized.workflowId}:completed:human_choice_resolution`,
      workflowId: normalized.workflowId,
      signalRawMessageId,
      eventType: "completed",
      payload: {
        completion_basis: "offline_operator_human_choice_resolution",
        disposition: normalized.disposition,
        resolution_fingerprint: resolutionFingerprint,
        lifecycle_status: resolution.status,
        settled_fraction: common.settled_fraction,
        unsettled_unscored_fraction: common.unsettled_unscored_fraction,
        remaining_fraction_after_resolution: common.remaining_fraction_after_resolution,
        workflow_state_released: true,
        shared_processes_retained: true,
        processes_released: false,
        model_feedback_status: "not_applied_offline_after_state_release",
        error: null
      }
    });
    db.exec("COMMIT");
    return {
      status: "resolved",
      workflow_id: normalized.workflowId,
      disposition: normalized.disposition,
      lifecycle_status: resolution.status,
      reconstructed_partial_exit_count: state.partialExits.length,
      reconstructed_remaining_fraction: state.remainingFraction,
      resolution_fingerprint: resolutionFingerprint
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the resolution error. */ }
    throw error;
  }
}
