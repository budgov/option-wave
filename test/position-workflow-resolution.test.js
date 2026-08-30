import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPositionWorkflowEvent,
  appendRawMessage,
  listPositionWorkflowEvents,
  openDatabase
} from "../src/db.js";
import { resolveAwaitingHumanChoice } from "../src/position-workflow-resolution.js";

function raw(messageId, publishedAt, rawText = "SPY CALL 700 @2.00") {
  return {
    channelKey: "source",
    chatId: "-1001",
    messageId,
    publishedAt,
    receivedAt: publishedAt,
    rawText,
    raw: {}
  };
}

function appendEvent(db, workflowId, signalRawMessageId, eventType, payload, exitRawMessageId = null) {
  return appendPositionWorkflowEvent(db, {
    eventKey: `${workflowId}:${eventType}:${listPositionWorkflowEvents(db, workflowId).length + 1}`,
    workflowId,
    signalRawMessageId,
    exitRawMessageId,
    eventType,
    payload
  });
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-human-resolution-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const openedAt = "2026-08-01T16:00:00.000Z";
  const signal = appendRawMessage(db, raw("100", openedAt));
  const firstExit = appendRawMessage(db, raw("101", "2026-08-01T17:00:00.000Z", "盈利自控 @3.00"));
  const secondExit = appendRawMessage(db, raw("102", "2026-08-01T18:00:00.000Z", "盈利自控 @4.00"));
  const workflowId = `position-raw-${signal.id}`;
  appendEvent(db, workflowId, signal.id, "opened", {
    entry: {
      schema_version: "position-entry.v1",
      signal: {
        raw_message_id: signal.id,
        published_at: openedAt,
        raw_text: "SPY CALL 700 @2.00"
      },
      contract: { symbol: "SPY", strike: 700, option_type: "call", entry_price: 2 },
      market_snapshot: { ocean_wave: { direction: "bullish", confidence: 0.7 } }
    }
  });
  appendEvent(db, workflowId, signal.id, "position_update", {
    average_cost: 2.5,
    average_cost_basis: "latest_source_reported_average_cost"
  }, signal.id);
  appendEvent(db, workflowId, signal.id, "partial_exit", {
    fraction_of_remaining: 0.5,
    portfolio_fraction: 0.5,
    remaining_fraction: 0.5,
    lifecycle_review: {
      status: "scored",
      exit: { hold_minutes: 60 },
      execution_check: { exit_execution_price: 3, gross_executable_return: 0.2 }
    }
  }, firstExit.id);
  appendEvent(db, workflowId, signal.id, "partial_exit", {
    fraction_of_remaining: 0.5,
    portfolio_fraction: 0.25,
    remaining_fraction: 0.25,
    lifecycle_review: {
      status: "scored",
      exit: { hold_minutes: 120 },
      execution_check: { exit_execution_price: 4, gross_executable_return: 0.6 }
    }
  }, secondExit.id);
  appendEvent(db, workflowId, signal.id, "awaiting_human_choice", {
    reason: "expiry_reached_with_unsignaled_remaining_position",
    remaining_fraction: 0.25,
    partial_exit_count: 2,
    operator_choice_required: true
  });

  const unrelatedSignal = appendRawMessage(db, raw("200", openedAt, "TSLA CALL 300 @1.00"));
  const unrelatedWorkflowId = `position-raw-${unrelatedSignal.id}`;
  appendEvent(db, unrelatedWorkflowId, unrelatedSignal.id, "opened", {
    entry: {
      signal: { raw_message_id: unrelatedSignal.id, published_at: openedAt },
      contract: { symbol: "TSLA", strike: 300, option_type: "call", entry_price: 1 }
    }
  });
  return { directory, db, workflowId, unrelatedWorkflowId };
}

test("operator final exit atomically resolves an awaiting workflow from geometric persisted legs", () => {
  const state = fixture();
  try {
    const oldEvents = listPositionWorkflowEvents(state.db, state.workflowId);
    const unrelatedBefore = listPositionWorkflowEvents(state.db, state.unrelatedWorkflowId);
    const result = resolveAwaitingHumanChoice(state.db, {
      workflowId: state.workflowId,
      exitPrice: 5,
      exitAt: "2026-08-01T20:00:00Z"
    });
    assert.equal(result.status, "resolved");
    assert.equal(result.lifecycle_status, "scored");
    assert.equal(result.reconstructed_partial_exit_count, 2);
    assert.equal(result.reconstructed_remaining_fraction, 0.25);

    const events = listPositionWorkflowEvents(state.db, state.workflowId);
    assert.deepEqual(events.slice(0, oldEvents.length).map((event) => event.id), oldEvents.map((event) => event.id));
    assert.deepEqual(events.slice(-2).map((event) => event.event_type), ["human_choice_resolved", "completed"]);
    const review = events.at(-2).payload.lifecycle_review;
    assert.equal(review.execution_check.entry_execution_price, 2.5);
    assert.equal(review.execution_check.weighted_exit_price, undefined);
    assert.equal(review.partial_exit_aggregation.weighted_exit_price, 3.75);
    assert.equal(review.partial_exit_aggregation.weighted_gross_return, 0.5);
    assert.equal(review.partial_exit_aggregation.exposure_weighted_hold_minutes, 120);
    assert.deepEqual(review.partial_exit_aggregation.legs.map((leg) => leg.portfolio_fraction), [0.5, 0.25, 0.25]);
    assert.equal(events.at(-2).payload.settled_fraction, 0.25);
    assert.equal(events.at(-2).payload.remaining_fraction_after_resolution, 0);
    assert.deepEqual(listPositionWorkflowEvents(state.db, state.unrelatedWorkflowId), unrelatedBefore);

    const repeated = resolveAwaitingHumanChoice(state.db, {
      workflowId: state.workflowId,
      exitPrice: "5.0",
      exitAt: "2026-08-01T20:00:00.000Z"
    });
    assert.equal(repeated.status, "already_resolved");
    assert.equal(listPositionWorkflowEvents(state.db, state.workflowId).length, events.length);
  } finally {
    state.db.close();
    fs.rmSync(state.directory, { recursive: true, force: true });
  }
});

test("explicit no-settlement disposition completes without fabricating an exit", () => {
  const state = fixture();
  try {
    const result = resolveAwaitingHumanChoice(state.db, {
      workflowId: state.workflowId,
      disposition: "unscored-no-settlement"
    });
    assert.equal(result.lifecycle_status, "unscored_no_settlement");
    const events = listPositionWorkflowEvents(state.db, state.workflowId);
    const resolution = events.at(-2);
    assert.equal(resolution.event_type, "human_choice_resolved");
    assert.equal(resolution.payload.operator_final_exit_price, null);
    assert.equal(resolution.payload.operator_final_exit_at, null);
    assert.equal(resolution.payload.unsettled_unscored_fraction, 0.25);
    assert.equal(resolution.payload.remaining_fraction_after_resolution, null);
    assert.equal(resolution.payload.lifecycle_review.execution_check.exit_execution_price, null);
    assert.equal(resolution.payload.lifecycle_review.partial_exit_aggregation.remaining_fraction, 0.25);
    assert.equal(events.at(-1).payload.model_feedback_status, "not_applied_offline_after_state_release");
  } finally {
    state.db.close();
    fs.rmSync(state.directory, { recursive: true, force: true });
  }
});

test("conflicting repeats and other terminal workflows are rejected without appending", () => {
  const state = fixture();
  try {
    resolveAwaitingHumanChoice(state.db, {
      workflowId: state.workflowId,
      exitPrice: 5,
      exitAt: "2026-08-01T20:00:00Z"
    });
    const resolvedCount = listPositionWorkflowEvents(state.db, state.workflowId).length;
    assert.throws(() => resolveAwaitingHumanChoice(state.db, {
      workflowId: state.workflowId,
      exitPrice: 5.01,
      exitAt: "2026-08-01T20:00:00Z"
    }), /already resolved with a different disposition/);
    assert.equal(listPositionWorkflowEvents(state.db, state.workflowId).length, resolvedCount);

    const unrelatedSignalId = listPositionWorkflowEvents(state.db, state.unrelatedWorkflowId)[0].signal_raw_message_id;
    appendEvent(state.db, state.unrelatedWorkflowId, unrelatedSignalId, "completed", { completion_basis: "normal_live_completion" });
    const terminalCount = listPositionWorkflowEvents(state.db, state.unrelatedWorkflowId).length;
    assert.throws(() => resolveAwaitingHumanChoice(state.db, {
      workflowId: state.unrelatedWorkflowId,
      disposition: "unscored-no-settlement"
    }), /already terminal/);
    assert.equal(listPositionWorkflowEvents(state.db, state.unrelatedWorkflowId).length, terminalCount);
  } finally {
    state.db.close();
    fs.rmSync(state.directory, { recursive: true, force: true });
  }
});

test("inconsistent persisted geometric state fails closed and rolls back", () => {
  const state = fixture();
  try {
    const badSignal = appendRawMessage(state.db, raw("300", "2026-08-01T16:00:00.000Z"));
    const badExit = appendRawMessage(state.db, raw("301", "2026-08-01T17:00:00.000Z", "盈利自控"));
    const workflowId = `position-raw-${badSignal.id}`;
    appendEvent(state.db, workflowId, badSignal.id, "opened", {
      entry: {
        signal: { raw_message_id: badSignal.id, published_at: "2026-08-01T16:00:00.000Z" },
        contract: { symbol: "PLTR", strike: 200, option_type: "call", entry_price: 1 }
      }
    });
    appendEvent(state.db, workflowId, badSignal.id, "partial_exit", {
      fraction_of_remaining: 0.5,
      portfolio_fraction: 0.4,
      remaining_fraction: 0.5,
      lifecycle_review: { status: "scored" }
    }, badExit.id);
    appendEvent(state.db, workflowId, badSignal.id, "awaiting_human_choice", {
      remaining_fraction: 0.5,
      partial_exit_count: 1
    });
    const before = listPositionWorkflowEvents(state.db, workflowId).length;
    assert.throws(() => resolveAwaitingHumanChoice(state.db, {
      workflowId,
      disposition: "unscored-no-settlement"
    }), /inconsistent with geometric partial exits/);
    assert.equal(listPositionWorkflowEvents(state.db, workflowId).length, before);
  } finally {
    state.db.close();
    fs.rmSync(state.directory, { recursive: true, force: true });
  }
});
