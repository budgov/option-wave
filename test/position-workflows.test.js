import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendAnalysis,
  appendPositionWorkflowEvent,
  appendRawMessage,
  listPositionWorkflowEvents,
  openDatabase
} from "../src/db.js";
import { createPositionWorkflowManager, workflowIdFor } from "../src/position-workflows.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function config() {
  return {
    __root: projectRoot,
    marketData: { maxLiveLagSeconds: 300 },
    positionWorkflow: {
      enabled: true,
      maxActive: 4,
      workerStartupTimeoutSeconds: 5,
      workerRequestTimeoutSeconds: 5,
      workerShutdownTimeoutSeconds: 2,
      completionRetrySeconds: 3600,
      orphanMaxHoldHours: 720
    }
  };
}

function snapshot(publishedAt) {
  return {
    schema_version: "ocean-wave-snapshot.v2",
    provider: "schwab",
    source_role: "primary",
    data_tier: "realtime",
    signal_published_at: publishedAt,
    observed_at: publishedAt,
    captured_at: publishedAt,
    time_alignment: { aligned: true, lag_seconds: 0 },
    market_state: { underlying_price: 700 },
    target_contract: {
      requested: { expiry: "2026-08-21", strike: 700, option_type: "call" },
      matched: { expiry: "2026-08-21", strike: 700, option_type: "call", bid: 1.1, ask: 1.2, quote_timestamp: publishedAt },
      exact_expiry_match: true,
      exact_strike_match: true,
      exact_option_type_match: true
    },
    contract_assessment: { decision: "support" },
    ocean_wave: {
      native_core: true,
      trend_score: 0.3,
      direction: "bullish",
      confidence: 0.7,
      expectations: {
        "5.0": { horizon_minutes: 5, probability_up: 0.62, expected_return: 0.001 },
        "30.0": { horizon_minutes: 30, probability_up: 0.68, expected_return: 0.003 }
      },
      factor_table: [
        { factor: "premium_elo", signal: 0.4, confidence: 0.8, dynamic_weight: 0.4, contribution: 0.16 },
        { factor: "iv_surface", signal: -0.1, confidence: 0.6, dynamic_weight: 0.2, contribution: -0.02 }
      ]
    }
  };
}

function raw(messageId, publishedAt) {
  return {
    channelKey: "source",
    chatId: "-1001",
    messageId,
    publishedAt,
    receivedAt: publishedAt,
    rawText: "SPY CALL 700 8/21 @1.2",
    raw: {}
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}

test("verified entry uses two shared role processes and releases only workflow state after feedback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-workflow-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const feedbackEvents = [];
  const marketDataRuntime = {
    status: () => ({ pid: 9001 }),
    applyFeedback: async (event) => {
      feedbackEvents.push(event);
      return { status: "updated", deployment_status: "shadow_only", global_samples: 1 };
    }
  };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime, logger: { log() {}, error() {} } });
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("10", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = {
      schema_version: "luna.v1",
      classification: "options_signal",
      contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" }
    };
    const opened = await manager.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    assert.equal(opened.status, "opened");
    assert.equal(manager.status().active, 1);
    const workflowId = workflowIdFor(stored.id);
    const startEvent = listPositionWorkflowEvents(db, workflowId).find((event) => event.event_type === "processes_started");
    const predictionPid = startEvent.payload.prediction_pid;
    const learningPid = startEvent.payload.learning_pid;
    assert.notEqual(predictionPid, learningPid);
    assert.equal(processAlive(predictionPid), true);
    assert.equal(processAlive(learningPid), true);

    await manager.enrich(stored.id, { schema_version: "terra.v1", status: "scored", inference: { why_now: "flow" } });
    const exit = appendRawMessage(db, { ...raw("11", new Date(Date.parse(publishedAt) + 30 * 60_000).toISOString()), replyToMessageId: "10", rawText: "止盈" });
    const result = await manager.complete({
      signalRawMessageId: stored.id,
      exitRawMessageId: exit.id,
      terra: { schema_version: "terra.v1", status: "scored", inference: { why_now: "flow confirmed" } },
      lifecycleReview: {
        status: "scored",
        exit: { hold_minutes: 30 },
        execution_check: { gross_executable_return: 0.25 }
      }
    });
    assert.equal(result.status, "completed");
    assert.equal(result.validation.status, "verified");
    assert.equal(result.feedback.deployment_status, "shadow_only");
    assert.equal(result.feedback.reasoning.entry_terra.inference.why_now, "flow");
    assert.equal(result.feedback.reasoning.exit_terra.inference.why_now, "flow confirmed");
    assert.equal(feedbackEvents.length, 1);
    assert.equal(manager.status().active, 0);
    assert.equal(manager.status().worker_process_count, 2);
    assert.equal(processAlive(predictionPid), true);
    assert.equal(processAlive(learningPid), true);
    const completed = listPositionWorkflowEvents(db, workflowId).at(-1);
    assert.equal(completed.event_type, "completed");
    assert.equal(completed.payload.workflow_state_released, true);
    assert.equal(completed.payload.shared_processes_retained, true);
    assert.equal(completed.payload.processes_released, false);
    const reasoningEvents = listPositionWorkflowEvents(db, workflowId)
      .filter((event) => event.event_type === "reasoning_updated");
    assert.equal(reasoningEvents[0].payload.phase, "entry");
    assert.equal(reasoningEvents[0].payload.entry_terra.inference.why_now, "flow");
    assert.equal(reasoningEvents[0].payload.exit_terra, null);
    assert.equal(reasoningEvents.at(-1).payload.phase, "exit");
    assert.equal(reasoningEvents.at(-1).payload.entry_terra, null);
    assert.equal(reasoningEvents.at(-1).payload.exit_terra.inference.why_now, "flow confirmed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_feedback").get().count, 1);
    await manager.closeAll("test_complete");
    assert.equal(processAlive(predictionPid), false);
    assert.equal(processAlive(learningPid), false);
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deterministic entry priming is idempotent and Luna confirms without reopening workers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-prime-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const manager = createPositionWorkflowManager(config(), db, {
    marketDataRuntime: { status: () => ({ pid: 1 }) },
    logger: { log() {}, error() {} }
  });
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("prime-10", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const hint = {
      schema_version: "signal-hint.v2",
      explicit: true,
      classification: "options_signal",
      action: "buy_to_open",
      contract: {
        symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call",
        entry_price: 1.2, entry_price_raw: "1.2", price_kind: "source_reported_fill"
      }
    };
    const [first, duplicate] = await Promise.all([
      manager.prime({ row, hint, marketSnapshot: snapshot(publishedAt) }),
      manager.prime({ row, hint, marketSnapshot: snapshot(publishedAt) })
    ]);
    assert.deepEqual(new Set([first.status, duplicate.status]), new Set(["primed", "already_open"]));
    assert.equal(manager.status().active, 1);
    let events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    assert.equal(events.filter((event) => event.event_type === "processes_started").length, 1);

    const confirmed = await manager.open({
      row,
      luna: {
        schema_version: "luna.v1",
        classification: "options_signal",
        contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" }
      },
      marketSnapshot: snapshot(publishedAt),
      raw: { raw_text: row.raw_text }
    });
    assert.equal(confirmed.status, "confirmed");
    events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    assert.equal(events.filter((event) => event.event_type === "processes_started").length, 1);
    assert.equal(events.filter((event) => event.event_type === "opened").length, 2);
    assert.equal(events.filter((event) => event.event_type === "opened").at(-1).payload.entry.signal.intake_basis, "luna_confirmed");

    const rejected = await manager.prime({
      row: { ...row, id: row.id + 1 },
      hint: { ...hint, explicit: false },
      marketSnapshot: snapshot(publishedAt)
    });
    assert.equal(rejected.status, "not_eligible");
    assert.equal(manager.status().active, 1);
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("listener shutdown releases shared workers and restart restores entry reasoning from DB events", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-restore-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const runtime = { status: () => ({ pid: 1 }), applyFeedback: async () => ({ status: "updated" }) };
  const first = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  let second;
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("20", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = { classification: "options_signal", contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" } };
    await first.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    await first.enrich(stored.id, {
      schema_version: "terra.v1",
      status: "scored",
      inference: { why_now: "entry persisted" }
    });
    const firstStatus = first.status();
    const firstPredictionPid = firstStatus.shared_workers.prediction.pid;
    const firstLearningPid = firstStatus.shared_workers.learning.pid;
    await first.closeAll("test_restart");
    assert.equal(first.status().active, 0);
    assert.equal(processAlive(firstPredictionPid), false);
    assert.equal(processAlive(firstLearningPid), false);

    second = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
    const restored = await second.restore();
    assert.deepEqual(restored, [workflowIdFor(stored.id)]);
    assert.equal(second.status().active, 1);
    const exit = appendRawMessage(db, {
      ...raw("21", new Date(Date.parse(publishedAt) + 30 * 60_000).toISOString()),
      replyToMessageId: "20",
      rawText: "止盈"
    });
    const completed = await second.complete({
      signalRawMessageId: stored.id,
      exitRawMessageId: exit.id,
      terra: {
        schema_version: "terra.v1",
        status: "scored",
        inference: { why_now: "exit persisted separately" }
      },
      lifecycleReview: {
        status: "scored",
        exit: { hold_minutes: 30 },
        execution_check: { gross_executable_return: 0.2 }
      }
    });
    assert.equal(completed.feedback.reasoning.entry_terra.inference.why_now, "entry persisted");
    assert.equal(completed.feedback.reasoning.exit_terra.inference.why_now, "exit persisted separately");
  } finally {
    await first.closeAll();
    await second?.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart recovers legacy entry Terra from the durable successful analysis", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-legacy-terra-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const runtime = { status: () => ({ pid: 1 }), applyFeedback: async () => ({ status: "updated" }) };
  const first = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  let second;
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("legacy-20", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = {
      classification: "options_signal",
      contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" }
    };
    await first.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    const terra = {
      schema_version: "terra.v1",
      status: "scored",
      inference: { why_now: "legacy durable entry rationale" }
    };
    appendAnalysis(db, {
      rawMessageId: stored.id,
      stage: "terra",
      schemaVersion: "terra.v1",
      model: "test",
      status: "ok",
      input: {},
      output: terra
    });
    appendPositionWorkflowEvent(db, {
      eventKey: `${workflowIdFor(stored.id)}:legacy-worker-status`,
      workflowId: workflowIdFor(stored.id),
      signalRawMessageId: stored.id,
      eventType: "reasoning_updated",
      processRole: "learning",
      payload: { status: "reasoning_updated" }
    });
    await first.closeAll("test_legacy_restart");

    second = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
    assert.deepEqual(await second.restore(), [workflowIdFor(stored.id)]);
    const recovered = listPositionWorkflowEvents(db, workflowIdFor(stored.id))
      .find((event) => event.payload?.recovery_source === "latest_successful_terra_analysis");
    assert.equal(recovered.payload.entry_terra.inference.why_now, "legacy durable entry rationale");

    const exit = appendRawMessage(db, {
      ...raw("legacy-21", new Date(Date.parse(publishedAt) + 30 * 60_000).toISOString()),
      replyToMessageId: "legacy-20",
      rawText: "止盈"
    });
    const completed = await second.complete({
      signalRawMessageId: stored.id,
      exitRawMessageId: exit.id,
      terra: { schema_version: "terra.v1", status: "scored", inference: { why_now: "exit" } },
      lifecycleReview: {
        status: "scored",
        exit: { hold_minutes: 30 },
        execution_check: { gross_executable_return: 0.2 }
      }
    });
    assert.equal(completed.feedback.reasoning.entry_terra.inference.why_now, "legacy durable entry rationale");
  } finally {
    await first.closeAll();
    await second?.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("partial and final exits retain both shared workers while releasing completed workflow state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-partial-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const runtime = { status: () => ({ pid: 1 }), applyFeedback: async () => ({ status: "updated" }) };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("30", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = { classification: "options_signal", contract: { symbol: "TSLA", expiry: "2026-08-21", strike: 350, option_type: "call", open_action: "buy_to_open" } };
    await manager.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    const workflowId = workflowIdFor(stored.id);
    const start = listPositionWorkflowEvents(db, workflowId).find((event) => event.event_type === "processes_started");
    const partialRow = appendRawMessage(db, { ...raw("31", new Date(Date.parse(publishedAt) + 48.1 * 60_000).toISOString()), replyToMessageId: "30", rawText: "卖出50%仓位 @3.28" });
    const partial = await manager.recordPartialExit({
      signalRawMessageId: stored.id,
      exitRawMessageId: partialRow.id,
      exitFraction: 0.5,
      terra: null,
      lifecycleReview: { status: "scored", exit: { hold_minutes: 48.1 }, execution_check: { exit_execution_price: 3.28, gross_executable_return: (3.28 - 2.69) / 2.69 } }
    });
    assert.equal(partial.status, "partial_exit_recorded");
    assert.equal(partial.remaining_fraction, 0.5);
    assert.equal(manager.status().active, 1);
    assert.equal(processAlive(start.payload.prediction_pid), true);
    assert.equal(processAlive(start.payload.learning_pid), true);
    const secondPartialRow = appendRawMessage(db, { ...raw("31b", new Date(Date.parse(publishedAt) + 70 * 60_000).toISOString()), replyToMessageId: "30", rawText: "盈利自控 @3.40" });
    const secondPartial = await manager.recordPartialExit({
      signalRawMessageId: stored.id,
      exitRawMessageId: secondPartialRow.id,
      exitFraction: 0.5,
      terra: null,
      lifecycleReview: { status: "scored", exit: { hold_minutes: 70 }, execution_check: { exit_execution_price: 3.40, gross_executable_return: (3.40 - 2.69) / 2.69 } }
    });
    assert.equal(secondPartial.portfolio_fraction, 0.25);
    assert.equal(secondPartial.remaining_fraction, 0.25);
    const finalRow = appendRawMessage(db, { ...raw("32", new Date(Date.parse(publishedAt) + 127.6167 * 60_000).toISOString()), replyToMessageId: "30", rawText: "清掉@3.20" });
    const completed = await manager.complete({
      signalRawMessageId: stored.id,
      exitRawMessageId: finalRow.id,
      terra: null,
      lifecycleReview: { status: "scored", exit: { hold_minutes: 127.6167 }, execution_check: { exit_execution_price: 3.20, gross_executable_return: (3.20 - 2.69) / 2.69 } }
    });
    assert.equal(completed.status, "completed");
    assert.ok(Math.abs(completed.validation.gross_executable_return - ((3.29 - 2.69) / 2.69)) < 1e-9);
    assert.ok(Math.abs(completed.validation.hold_minutes - (48.1 * 0.5 + 70 * 0.25 + 127.6167 * 0.25)) < 1e-6);
    const aggregateRows = db.prepare("SELECT review_version,review_json FROM lifecycle_reviews").all();
    assert.equal(aggregateRows.length, 1);
    assert.equal(aggregateRows[0].review_version, "lifecycle-review.v1.3");
    const persistedAggregate = JSON.parse(aggregateRows[0].review_json);
    assert.equal(persistedAggregate.partial_exit_aggregation.legs.length, 3);
    assert.ok(Math.abs(persistedAggregate.execution_check.exit_execution_price - 3.29) < 1e-9);
    assert.equal(manager.status().active, 0);
    assert.equal(processAlive(start.payload.prediction_pid), true);
    assert.equal(processAlive(start.payload.learning_pid), true);
    await manager.closeAll("test_complete");
    assert.equal(processAlive(start.payload.prediction_pid), false);
    assert.equal(processAlive(start.payload.learning_pid), false);
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("multiple positions share exactly two role processes and keep isolated workflow state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-shared-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const runtime = { status: () => ({ pid: 1 }), applyFeedback: async () => ({ status: "updated" }) };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  try {
    const publishedAtA = new Date().toISOString();
    const publishedAtB = new Date(Date.parse(publishedAtA) + 1_000).toISOString();
    const storedA = appendRawMessage(db, raw("50", publishedAtA));
    const storedB = appendRawMessage(db, raw("51", publishedAtB));
    const luna = { classification: "options_signal", contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" } };
    for (const [stored, publishedAt] of [[storedA, publishedAtA], [storedB, publishedAtB]]) {
      const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
      await manager.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    }
    const startA = listPositionWorkflowEvents(db, workflowIdFor(storedA.id))
      .find((event) => event.event_type === "processes_started");
    const startB = listPositionWorkflowEvents(db, workflowIdFor(storedB.id))
      .find((event) => event.event_type === "processes_started");
    assert.equal(startA.payload.prediction_pid, startB.payload.prediction_pid);
    assert.equal(startA.payload.learning_pid, startB.payload.learning_pid);
    assert.notEqual(startA.payload.prediction_pid, startA.payload.learning_pid);
    assert.equal(manager.status().active, 2);
    assert.equal(manager.status().worker_process_count, 2);

    await manager.enrich(storedA.id, { schema_version: "terra.v1", inference: { why_now: "position A" } });
    await manager.enrich(storedB.id, { schema_version: "terra.v1", inference: { why_now: "position B" } });
    const exitA = appendRawMessage(db, { ...raw("52", new Date(Date.parse(publishedAtA) + 5 * 60_000).toISOString()), replyToMessageId: "50", rawText: "止盈" });
    const resultA = await manager.complete({
      signalRawMessageId: storedA.id,
      exitRawMessageId: exitA.id,
      terra: { schema_version: "terra.v1", inference: { why_now: "exit A" } },
      lifecycleReview: { status: "scored", exit: { hold_minutes: 5 }, execution_check: { gross_executable_return: 0.1 } }
    });
    assert.equal(resultA.feedback.reasoning.entry_terra.inference.why_now, "position A");
    assert.equal(manager.status().active, 1);
    assert.equal(processAlive(startA.payload.prediction_pid), true);
    assert.equal(processAlive(startA.payload.learning_pid), true);

    const exitB = appendRawMessage(db, { ...raw("53", new Date(Date.parse(publishedAtB) + 10 * 60_000).toISOString()), replyToMessageId: "51", rawText: "止盈" });
    const resultB = await manager.complete({
      signalRawMessageId: storedB.id,
      exitRawMessageId: exitB.id,
      terra: { schema_version: "terra.v1", inference: { why_now: "exit B" } },
      lifecycleReview: { status: "scored", exit: { hold_minutes: 10 }, execution_check: { gross_executable_return: 0.15 } }
    });
    assert.equal(resultB.feedback.reasoning.entry_terra.inference.why_now, "position B");
    assert.equal(resultB.feedback.reasoning.exit_terra.inference.why_now, "exit B");
    assert.equal(manager.status().active, 0);
    assert.equal(manager.status().worker_process_count, 2);
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a crashed shared learning worker is restarted and entry reasoning is replayed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-worker-crash-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const runtime = { status: () => ({ pid: 1 }), applyFeedback: async () => ({ status: "updated" }) };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("60", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = { classification: "options_signal", contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" } };
    await manager.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    await manager.enrich(stored.id, {
      schema_version: "terra.v1",
      inference: { why_now: "replay this entry" }
    });
    const originalLearningPid = manager.status().shared_workers.learning.pid;
    process.kill(originalLearningPid);
    await waitFor(() => !processAlive(originalLearningPid));

    const exit = appendRawMessage(db, { ...raw("61", new Date(Date.parse(publishedAt) + 15 * 60_000).toISOString()), replyToMessageId: "60", rawText: "清掉" });
    const result = await manager.complete({
      signalRawMessageId: stored.id,
      exitRawMessageId: exit.id,
      terra: { schema_version: "terra.v1", inference: { why_now: "exit after restart" } },
      lifecycleReview: { status: "scored", exit: { hold_minutes: 15 }, execution_check: { gross_executable_return: 0.12 } }
    });
    const replacementLearningPid = manager.status().shared_workers.learning.pid;
    assert.notEqual(replacementLearningPid, originalLearningPid);
    assert.equal(processAlive(replacementLearningPid), true);
    assert.equal(result.feedback.reasoning.entry_terra.inference.why_now, "replay this entry");
    assert.equal(result.feedback.reasoning.exit_terra.inference.why_now, "exit after restart");
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a transient completion failure stays resumable and releases state only after a successful retry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-completion-retry-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  let feedbackAttempts = 0;
  const runtime = {
    status: () => ({ pid: 1 }),
    applyFeedback: async () => {
      feedbackAttempts += 1;
      if (feedbackAttempts === 1) throw new Error("temporary calibration lock");
      return { status: "updated", deployment_status: "shadow_only" };
    }
  };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  try {
    const publishedAt = new Date().toISOString();
    const stored = appendRawMessage(db, raw("70", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const luna = {
      classification: "options_signal",
      contract: { symbol: "SPY", expiry: "2026-08-21", strike: 700, option_type: "call", open_action: "buy_to_open" }
    };
    await manager.open({ row, luna, marketSnapshot: snapshot(publishedAt), raw: { raw_text: row.raw_text } });
    await manager.enrich(stored.id, { schema_version: "terra.v1", inference: { why_now: "entry retained" } });
    const exit = appendRawMessage(db, {
      ...raw("71", new Date(Date.parse(publishedAt) + 15 * 60_000).toISOString()),
      replyToMessageId: "70",
      rawText: "清掉@1.5"
    });
    const request = {
      signalRawMessageId: stored.id,
      exitRawMessageId: exit.id,
      terra: { schema_version: "terra.v1", inference: { why_now: "exit retained" } },
      lifecycleReview: {
        status: "scored",
        exit: { hold_minutes: 15 },
        execution_check: { gross_executable_return: 0.25 }
      }
    };
    await assert.rejects(manager.complete(request), /temporary calibration lock/);
    assert.equal(manager.status().active, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_feedback").get().count, 0);
    let events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    assert.equal(events.at(-1).event_type, "completion_failed");
    assert.equal(events.some((event) => event.event_type === "completed"), false);
    assert.equal(events.at(-1).payload.request.exit_raw_message_id, exit.id);

    const completed = await manager.complete(request);
    assert.equal(completed.status, "completed");
    assert.equal(completed.feedback.reasoning.entry_terra.inference.why_now, "entry retained");
    assert.equal(completed.feedback.reasoning.exit_terra.inference.why_now, "exit retained");
    assert.equal(feedbackAttempts, 2);
    assert.equal(manager.status().active, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_feedback").get().count, 1);
    events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    assert.equal(events.at(-1).event_type, "completed");
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dated options ignore orphan timeout and finalize only at expiry close without an explicit exit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-expiry-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const feedbackEvents = [];
  const expiry = "2026-09-18";
  const runtime = {
    status: () => ({ pid: 1 }),
    capture: async (_config, _luna, asOf) => {
      const result = snapshot(asOf);
      result.target_contract.requested.expiry = expiry;
      result.target_contract.matched.expiry = expiry;
      result.target_contract.matched.bid = 2;
      result.target_contract.matched.ask = 2.1;
      return result;
    },
    applyFeedback: async (event) => {
      feedbackEvents.push(event);
      return { status: "updated", deployment_status: "shadow_only" };
    }
  };
  const manager = createPositionWorkflowManager(config(), db, { marketDataRuntime: runtime, logger: { log() {}, error() {} } });
  try {
    const publishedAt = "2026-08-01T16:00:00.000Z";
    const stored = appendRawMessage(db, raw("40", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const entrySnapshot = snapshot(publishedAt);
    entrySnapshot.target_contract.requested.expiry = expiry;
    entrySnapshot.target_contract.matched.expiry = expiry;
    const luna = {
      classification: "options_signal",
      contract: { symbol: "SPY", expiry, strike: 700, option_type: "call", open_action: "buy_to_open", entry_price: 1.2 }
    };
    await manager.open({ row, luna, marketSnapshot: entrySnapshot, raw: { raw_text: row.raw_text } });

    // More than the 30-day orphan limit has elapsed, but the contract still
    // has not reached its own expiry close and must remain active.
    await manager.sweepExpired(Date.parse("2026-09-17T20:00:00.000Z"));
    assert.equal(manager.status().active, 1);
    assert.equal(listPositionWorkflowEvents(db, workflowIdFor(stored.id)).some((event) => event.event_type === "expired"), false);

    await manager.sweepExpired(Date.parse("2026-09-18T20:00:01.000Z"));
    assert.equal(manager.status().active, 0);
    assert.equal(feedbackEvents.length, 1);
    const events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    const expiryEvent = events.find((event) => event.event_type === "expiry_close_observed");
    assert.equal(expiryEvent.payload.lifecycle_review.execution_check.exit_execution_price, 2);
    assert.equal(expiryEvent.payload.lifecycle_review.execution_check.exit_basis, "expiry_last_available_bid");
    assert.equal(expiryEvent.payload.lifecycle_review.close_policy, "hold_until_expiry_unless_explicit_sell_to_close");
    assert.equal(events.at(-1).event_type, "completed");
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a partially exited position asks for human choice at expiry and releases workflow state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "position-expiry-choice-"));
  const db = openDatabase(path.join(directory, "test.sqlite"));
  const expiry = "2026-09-18";
  const notifications = [];
  const runtime = {
    status: () => ({ pid: 1 }),
    capture: async (_config, _luna, asOf) => {
      const result = snapshot(asOf);
      result.target_contract.requested.expiry = expiry;
      result.target_contract.matched.expiry = expiry;
      result.target_contract.matched.bid = 2;
      return result;
    },
    applyFeedback: async () => ({ status: "updated" })
  };
  const manager = createPositionWorkflowManager(config(), db, {
    marketDataRuntime: runtime,
    notifier: { send: async (...args) => notifications.push(args) },
    logger: { log() {}, error() {} }
  });
  try {
    const publishedAt = "2026-08-01T16:00:00.000Z";
    const stored = appendRawMessage(db, raw("80", publishedAt));
    const row = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(stored.id);
    const entrySnapshot = snapshot(publishedAt);
    entrySnapshot.target_contract.requested.expiry = expiry;
    entrySnapshot.target_contract.matched.expiry = expiry;
    const luna = { classification: "options_signal", contract: { symbol: "SPY", expiry, strike: 700, option_type: "call", open_action: "buy_to_open", entry_price: 1.2 } };
    await manager.open({ row, luna, marketSnapshot: entrySnapshot, raw: { raw_text: row.raw_text } });
    const partialRow = appendRawMessage(db, { ...raw("81", "2026-08-15T16:00:00.000Z"), replyToMessageId: "80", rawText: "盈利自控" });
    await manager.recordPartialExit({
      signalRawMessageId: stored.id,
      exitRawMessageId: partialRow.id,
      exitFraction: 0.5,
      terra: null,
      lifecycleReview: { status: "scored", exit: { hold_minutes: 1 }, execution_check: { exit_execution_price: 1.5, gross_executable_return: 0.25 } }
    });
    await manager.sweepExpired(Date.parse("2026-09-18T20:00:01.000Z"));
    assert.equal(manager.status().active, 0);
    const events = listPositionWorkflowEvents(db, workflowIdFor(stored.id));
    const awaiting = events.at(-1);
    assert.equal(awaiting.event_type, "awaiting_human_choice");
    assert.equal(awaiting.payload.remaining_fraction, 0.5);
    assert.equal(awaiting.payload.partial_exit_count, 1);
    assert.equal(awaiting.payload.expiry_reference_price, 2);
    assert.equal(notifications.length, 1);
  } finally {
    await manager.closeAll();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
