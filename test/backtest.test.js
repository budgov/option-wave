import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBacktestReadiness, buildSignalLifecycles, executableOptionPnl, promotionGate } from "../src/backtest.js";
import { appendAnalysis, appendLifecycleReview, appendMarketSnapshot, appendRawMessage, openDatabase } from "../src/db.js";

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-backtest-"));
  const db = openDatabase(path.join(dir, "audit.sqlite"));
  const signal = appendRawMessage(db, {
    channelKey: "meigu_baijialun", chatId: "1", messageId: "10",
    publishedAt: "2026-07-01T14:00:00Z", receivedAt: "2026-07-01T14:00:01Z",
    rawText: "fixture", raw: {}
  });
  appendAnalysis(db, {
    rawMessageId: signal.id, stage: "luna", schemaVersion: "luna.v1", model: "fixture", status: "ok", input: {},
    output: { schema_version: "luna.v1", classification: "options_signal", signal_id: "s1", contract: { symbol: "ABC", expiry: "2026-07-03", strike: 10, option_type: "call", side: "buy" }, confidence: { overall: 0.9 } }
  });
  appendMarketSnapshot(db, signal.id, { provider: "none", data_tier: "text_only", as_of: "2026-07-01T14:00:00Z" });
  const outcome = appendRawMessage(db, {
    channelKey: "meigu_baijialun", chatId: "1", messageId: "11", replyToMessageId: "10",
    publishedAt: "2026-07-01T15:00:00Z", receivedAt: "2026-07-01T15:00:01Z",
    rawText: "fixture outcome", raw: {}
  });
  appendAnalysis(db, {
    rawMessageId: outcome.id, stage: "luna", schemaVersion: "luna.v1", model: "fixture", status: "ok", input: {},
    output: { schema_version: "luna.v1", classification: "outcome", source: { reply_to_message_id: "10" }, follow_up: { parent_message_id: "10" } }
  });
  const commentary = appendRawMessage(db, {
    channelKey: "meigu_baijialun", chatId: "1", messageId: "12",
    publishedAt: "2026-07-01T16:00:00Z", receivedAt: "2026-07-01T16:00:01Z",
    rawText: "market commentary", raw: {}
  });
  appendAnalysis(db, {
    rawMessageId: commentary.id, stage: "luna", schemaVersion: "luna.v1", model: "fixture", status: "ok", input: {},
    output: { schema_version: "luna.v1", classification: "non_signal" }
  });
  appendMarketSnapshot(db, commentary.id, {
    provider: "schwab", data_tier: "realtime", as_of: "2026-07-01T16:00:00Z",
    observed_at: "2026-07-01T16:00:00Z", captured_at: "2026-07-01T16:00:00Z"
  });
  return db;
}

test("readiness separates channel self-report from verified outcome", () => {
  const audit = buildBacktestReadiness(fixtureDb(), ["meigu_baijialun", "go_finance"]);
  assert.equal(audit.counts.signals, 1);
  assert.equal(audit.counts.self_reported_outcomes, 1);
  assert.equal(audit.counts.independently_verified_outcomes, 0);
  assert.equal(audit.counts.point_in_time_snapshots, 0);
  assert.equal(audit.training_allowed, false);
  assert.ok(audit.blockers.some((b) => b.code === "channel_backfill_incomplete"));
});

test("executable P&L crosses the spread and charges fees", () => {
  const bought = executableOptionPnl({ side: "buy", entryBid: 1, entryAsk: 1.1, exitBid: 1.5, exitAsk: 1.6, contracts: 2, fees: 3 });
  assert.equal(bought.entry_fill, 1.1);
  assert.equal(bought.exit_fill, 1.5);
  assert.ok(Math.abs(bought.gross_pnl - 80) < 1e-10);
  assert.ok(Math.abs(bought.net_pnl - 77) < 1e-10);
  const sold = executableOptionPnl({ side: "sell", entryBid: 1, entryAsk: 1.1, exitBid: 0.5, exitAsk: 0.6, contracts: 1, fees: 1 });
  assert.equal(sold.entry_fill, 1);
  assert.equal(sold.exit_fill, 0.6);
  assert.ok(Math.abs(sold.gross_pnl - 40) < 1e-10);
  assert.ok(Math.abs(sold.net_pnl - 39) < 1e-10);
});

test("promotion gate rejects a promising but insufficient challenger", () => {
  const result = promotionGate({
    independentGroups: 50, outOfSampleMonths: 2,
    brierImprovementCiLow: 0.01, loglossImprovementCiLow: 0.01,
    calibrationSlope: 1, calibrationIntercept: 0, ece: 0.02,
    netEvCiLow: 0.01, doubleSlippageNetEv: 0.01,
    shadowDays: 5, shadowSignals: 20
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.independent_groups, false);
  assert.equal(result.checks.shadow_run, false);
});

test("backtest and readiness count final edits, successful retries, snapshots, and exits only once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-backtest-edits-"));
  const db = openDatabase(path.join(dir, "audit.sqlite"));
  try {
    const entry = appendRawMessage(db, {
      channelKey: "meigu_baijialun", chatId: "-1002059", messageId: "2058",
      publishedAt: "2026-08-21T15:00:00.000Z", receivedAt: "2026-08-21T15:00:01.000Z",
      rawText: "SPY 650 Call 8/21 @0.50", raw: {}
    });
    const signalOutput = {
      schema_version: "luna.v1", classification: "options_signal", signal_id: "spy-2058",
      contract: { symbol: "SPY", expiry: "2026-08-21", strike: 650, option_type: "call", side: "buy" },
      confidence: { overall: 0.9 }
    };
    appendAnalysis(db, {
      rawMessageId: entry.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: signalOutput
    });
    appendAnalysis(db, {
      rawMessageId: entry.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: signalOutput
    });
    for (const capturedAt of ["2026-08-21T15:00:01.000Z", "2026-08-21T15:00:02.000Z"]) {
      appendMarketSnapshot(db, entry.id, {
        provider: "schwab", data_tier: "realtime", as_of: capturedAt,
        observed_at: capturedAt, captured_at: capturedAt,
        target_contract: { matched: { quote_timestamp: capturedAt } }
      });
    }

    const exitBase = {
      channelKey: "meigu_baijialun", chatId: "-1002059", messageId: "2059", replyToMessageId: "2058",
      publishedAt: "2026-08-21T15:30:00.000Z", receivedAt: "2026-08-21T15:30:01.000Z", raw: {}
    };
    const original = appendRawMessage(db, { ...exitBase, rawText: "清掉@0.90" });
    appendAnalysis(db, {
      rawMessageId: original.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close", follow_up: { parent_message_id: "2058" }, lifecycle: { reference_exit_price: 0.90 } }
    });
    const editedAt = "2026-08-21T15:35:00.000Z";
    const edited = appendRawMessage(db, {
      ...exitBase, rawText: "清掉@0.94", editedAt, receivedAt: "2026-08-21T15:35:01.000Z"
    });
    const finalExitOutput = {
      schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close",
      follow_up: { parent_message_id: "2058" }, lifecycle: { reference_exit_price: 0.94 }
    };
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: finalExitOutput
    });
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: finalExitOutput
    });
    for (const exitRawMessageId of [original.id, edited.id]) {
      appendLifecycleReview(db, {
        signalRawMessageId: entry.id, exitRawMessageId, reviewVersion: "lifecycle-review.v1.2",
        inputManifest: { exitRawMessageId }, status: "scored", review: { schema_version: "lifecycle-review.v1.2", status: "scored" }
      });
    }

    const correctedExit = appendRawMessage(db, {
      ...exitBase, messageId: "2060", replyToMessageId: "2058", rawText: "清掉@1.20",
      publishedAt: "2026-08-21T15:40:00.000Z", receivedAt: "2026-08-21T15:40:01.000Z"
    });
    appendAnalysis(db, {
      rawMessageId: correctedExit.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { ...finalExitOutput, lifecycle: { reference_exit_price: 1.20 } }
    });
    appendLifecycleReview(db, {
      signalRawMessageId: entry.id, exitRawMessageId: correctedExit.id, reviewVersion: "lifecycle-review.v1.2",
      inputManifest: { exitRawMessageId: correctedExit.id }, status: "scored",
      review: { schema_version: "lifecycle-review.v1.2", status: "scored" }
    });

    const lifecycles = buildSignalLifecycles(db);
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].follow_ups.length, 1);
    assert.equal(lifecycles[0].follow_ups[0].raw_message_id, correctedExit.id);
    assert.equal(lifecycles[0].follow_ups[0].published_at, "2026-08-21T15:40:00.000Z");
    assert.equal(lifecycles[0].self_reported_outcome_count, 1);

    const audit = buildBacktestReadiness(db, ["meigu_baijialun"]);
    assert.equal(audit.counts.raw_messages, 3);
    assert.equal(audit.counts.raw_message_versions, 4);
    assert.equal(audit.counts.luna_runs, 3);
    assert.equal(audit.counts.signals, 1);
    assert.equal(audit.counts.self_reported_outcomes, 1);
    assert.equal(audit.counts.point_in_time_snapshots, 1);
    assert.equal(audit.counts.lifecycle_exits, 1);
    assert.equal(audit.counts.lifecycle_linked, 1);
    assert.equal(audit.counts.lifecycle_scored, 1);
    assert.equal(audit.snapshot_tiers.length, 1);
    assert.deepEqual({ ...audit.snapshot_tiers[0] }, { provider: "schwab", data_tier: "realtime", n: 1 });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
