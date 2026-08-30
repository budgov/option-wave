import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAnalysis, appendMarketSnapshot, appendMediaAnalysis, appendMediaAsset, appendRawMessage, listDailyLifecycleReviews, openDatabase } from "../src/db.js";
import { backfillLifecycleReviews, buildLifecycleReview, lunaWithSignalContract, resolveSignalContext } from "../src/lifecycle.js";

function raw(channelKey, messageId, publishedAt, rawText, replyToMessageId = null) {
  return { channelKey, chatId: "-1001", messageId, publishedAt, receivedAt: publishedAt, rawText, replyToMessageId, raw: {} };
}

function luna(db, rawMessageId, output) {
  appendAnalysis(db, { rawMessageId, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output });
}

test("sell-to-close resolves its buy-to-open reply chain and scores point-in-time snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-lifecycle-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entry = appendRawMessage(db, raw("source", "10", "2026-01-01T15:00:00.000Z", "SPY call"));
    luna(db, entry.id, { classification: "options_signal", signal_id: "s1", contract: { symbol: "SPY", option_type: "call", side: "buy" } });
    appendMarketSnapshot(db, entry.id, {
      as_of: "2026-01-01T15:00:00.000Z", observed_at: "2026-01-01T15:00:00.000Z", data_tier: "historical_tick", provider: "test",
      target_contract: { matched: { bid: 1.0, ask: 1.1 } }, ocean_wave: { trend_score: 0.2, confidence: 0.7 }
    });
    const exit = appendRawMessage(db, raw("source", "11", "2026-01-01T15:30:00.000Z", "止盈", "10"));
    const exitLuna = { classification: "outcome", lifecycle_action: "sell_to_close", follow_up: { parent_message_id: "10" } };
    luna(db, exit.id, exitLuna);
    appendMarketSnapshot(db, exit.id, {
      as_of: "2026-01-01T15:30:00.000Z", observed_at: "2026-01-01T15:30:00.000Z", data_tier: "historical_tick", provider: "test",
      target_contract: { matched: { bid: 1.5, ask: 1.6 } }
    });
    const context = resolveSignalContext(db, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), exitLuna);
    assert.equal(context.signalRow.id, entry.id);
    const built = buildLifecycleReview(db, context, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), {
      as_of: "2026-01-01T15:30:00.000Z", observed_at: "2026-01-01T15:30:00.000Z", data_tier: "historical_tick", target_contract: { matched: { bid: 1.5, ask: 1.6 } }
    });
    assert.equal(built.status, "scored");
    assert.equal(built.review.entry_prediction_status, "scored_point_in_time");
    assert.equal(built.review.execution_check.status, "checked_point_in_time");
    assert.equal(built.review.execution_check.gross_executable_return, (1.5 - 1.1) / 1.1);
    const summary = backfillLifecycleReviews(db);
    assert.deepEqual({ exits: summary.exits, linked: summary.linked, scored: summary.scored, blocked: summary.blocked }, { exits: 1, linked: 1, scored: 1, blocked: 0 });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reported post-add average cost becomes the lifecycle cost basis while snapshots remain point-in-time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-average-cost-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entry = appendRawMessage(db, raw("source", "20", "2026-01-01T15:00:00.000Z", "SPY Call 700 @0.35"));
    luna(db, entry.id, { classification: "options_signal", signal_id: "avg", contract: { symbol: "SPY", option_type: "call", strike: 700, entry_price: { value: 0.35 } } });
    appendMarketSnapshot(db, entry.id, {
      as_of: "2026-01-01T15:00:00.000Z", observed_at: "2026-01-01T15:00:00.000Z", data_tier: "realtime", provider: "test",
      target_contract: { matched: { bid: 0.34, ask: 0.36 } }, ocean_wave: { trend_score: 0.01 }
    });
    const add = appendRawMessage(db, raw("source", "21", "2026-01-01T15:10:00.000Z", "補倉目前成本價@0.25", "20"));
    luna(db, add.id, { classification: "update", lifecycle: { kind: "add", average_cost: 0.25 } });
    appendMarketSnapshot(db, add.id, {
      as_of: "2026-01-01T15:10:00.000Z", observed_at: "2026-01-01T15:10:00.000Z", data_tier: "realtime", provider: "test",
      target_contract: { matched: { bid: 0.19, ask: 0.21 } }
    });
    const exit = appendRawMessage(db, raw("source", "22", "2026-01-01T15:30:00.000Z", "清掉@0.34", "20"));
    const exitLuna = { classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { reference_exit_price: 0.34 }, follow_up: { parent_message_id: "20" } };
    luna(db, exit.id, exitLuna);
    const exitRow = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id);
    const context = resolveSignalContext(db, exitRow, exitLuna);
    const built = buildLifecycleReview(db, context, exitRow, {
      as_of: "2026-01-01T15:30:00.000Z", observed_at: "2026-01-01T15:30:00.000Z", data_tier: "realtime",
      target_contract: { matched: { bid: 0.33, ask: 0.35 } }
    });
    assert.equal(built.review.execution_check.entry_execution_price, 0.25);
    assert.equal(built.review.execution_check.entry_basis, "latest_source_reported_average_cost");
    assert.ok(Math.abs(built.review.execution_check.gross_executable_return - 0.36) < 1e-12);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exit parsing cannot erase the opening contract with null fields", () => {
  const merged = lunaWithSignalContract(
    { classification: "outcome", contract: { symbol: "TSLA", expiry: null, strike: null } },
    { signalRow: { id: 1, channel_key: "source", telegram_message_id: "10" }, signalLuna: { signal_id: "s1", contract: { symbol: "TSLA", expiry: "2026-07-17", strike: 400, option_type: "call" } } }
  );
  assert.equal(merged.contract.expiry, "2026-07-17");
  assert.equal(merged.contract.strike, 400);
});

test("cropped outcome media cannot overwrite the opening contract identity", () => {
  const merged = lunaWithSignalContract(
    { classification: "outcome", evidence: { raw_text: "盈利自控" }, contract: { symbol: "QQQ", expiry: "2026-08-19", strike: 100, option_type: "put" } },
    { signalRow: { id: 1, channel_key: "source", telegram_message_id: "10" }, signalLuna: { signal_id: "s1", contract: { symbol: "QQQ", expiry: null, strike: 717, option_type: "put" } } },
    { target_contract: { resolved: { expiry: "2026-08-19", expiry_inferred: true, expiry_policy: "nearest_listed_expiry" }, matched: { expiry: "2026-08-19" } } }
  );
  assert.equal(merged.contract.strike, 717);
  assert.equal(merged.contract.expiry, "2026-08-19");
  assert.equal(merged.contract.expiry_resolution.inferred, true);
});

test("a unique symbol ledger links an exit when its reply chain is broken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-ledger-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entry = appendRawMessage(db, raw("source", "10", "2026-01-01T15:00:00.000Z", "XYZ CALL 100"));
    luna(db, entry.id, { classification: "options_signal", signal_id: "xyz", contract: { symbol: "XYZ", strike: 100, option_type: "call" } });
    const unrelated = appendRawMessage(db, raw("source", "11", "2026-01-01T15:10:00.000Z", "comment"));
    luna(db, unrelated.id, { classification: "non_signal" });
    const exit = appendRawMessage(db, raw("source", "12", "2026-01-01T15:20:00.000Z", "XYZ止盈", "11"));
    const context = resolveSignalContext(db, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), {
      classification: "outcome", lifecycle_action: "sell_to_close", contract: { symbol: "XYZ" }
    });
    assert.equal(context.signalRow.id, entry.id);
    assert.equal(context.resolution, "unique_contract_ledger");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("symbol ledger abstains when two contracts are equally plausible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-ledger-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    for (const [id, strike] of [["10", 100], ["11", 105]]) {
      const entry = appendRawMessage(db, raw("source", id, `2026-01-01T15:${id}:00.000Z`, `XYZ CALL ${strike}`));
      luna(db, entry.id, { classification: "options_signal", signal_id: id, contract: { symbol: "XYZ", strike, option_type: "call" } });
    }
    const exit = appendRawMessage(db, raw("source", "12", "2026-01-01T16:00:00.000Z", "XYZ止盈"));
    const context = resolveSignalContext(db, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), {
      classification: "outcome", lifecycle_action: "sell_to_close", contract: { symbol: "XYZ" }
    });
    assert.equal(context, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("late realtime quotes do not score a lifecycle review", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-lifecycle-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entry = appendRawMessage(db, raw("source", "10", "2026-01-01T15:00:00.000Z", "SPY call"));
    luna(db, entry.id, { classification: "options_signal", signal_id: "s1", contract: { symbol: "SPY", option_type: "call", side: "buy" } });
    appendMarketSnapshot(db, entry.id, {
      as_of: "2026-01-01T15:30:00.000Z", captured_at: "2026-01-01T15:30:00.000Z",
      data_tier: "realtime", provider: "test",
      target_contract: { matched: { bid: 1.0, ask: 1.1 } }, ocean_wave: { trend_score: 0.2, confidence: 0.7 }
    });
    const exit = appendRawMessage(db, raw("source", "11", "2026-01-01T15:31:00.000Z", "止盈", "10"));
    const exitLuna = { classification: "outcome", lifecycle_action: "sell_to_close", follow_up: { parent_message_id: "10" } };
    const context = resolveSignalContext(db, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), exitLuna);
    const built = buildLifecycleReview(db, context, db.prepare("SELECT * FROM raw_messages WHERE id=?").get(exit.id), {
      as_of: "2026-01-01T15:31:00.000Z", captured_at: "2026-01-01T15:31:00.000Z",
      data_tier: "realtime", target_contract: { matched: { bid: 1.5, ask: 1.6 } }
    });
    assert.equal(built.status, "blocked_missing_execution_data");
    assert.equal(built.review.timing.entry_aligned, false);
    assert.ok(built.review.missing.includes("entry_snapshot_not_time_aligned"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source @fill and screenshot exits are executable despite delayed quotes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-source-fills-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entryTime = "2026-08-19T13:32:22.000Z";
    const entry = appendRawMessage(db, raw("source", "10", entryTime, "GOOGL CALL 345 8/19 @1.22"));
    luna(db, entry.id, {
      classification: "options_signal", signal_id: "g1",
      contract: { symbol: "GOOGL", expiry: "2026-08-19", strike: 345, option_type: "call", entry_price: { value: 1.22, kind: "source_reported_fill" } }
    });
    appendMarketSnapshot(db, entry.id, {
      as_of: "2026-08-19T14:02:22.000Z", captured_at: "2026-08-19T14:02:22.000Z",
      data_tier: "realtime", provider: "schwab",
      target_contract: { matched: { bid: 1.25, ask: 1.30 } }, ocean_wave: { trend_score: 0.2 }
    });

    const first = appendRawMessage(db, raw("source", "11", "2026-08-19T13:40:00.000Z", "盈利自控", "10"));
    luna(db, first.id, { classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { kind: "profit_control", execution_state: "source_reported_fill_candidate" }, follow_up: { parent_message_id: "10" } });
    const firstAsset = appendMediaAsset(db, { rawMessageId: first.id, mediaIndex: 0, telegramKind: "photo", sizeBytes: 1, sha256: "a".repeat(64), storagePath: "first.png" });
    appendMediaAnalysis(db, { mediaAssetId: firstAsset.id, schemaVersion: "media-vision.v1", model: "test", status: "ok", output: { entities: { prices: ["345", "1.55", "1.22"] } } });

    const last = appendRawMessage(db, raw("source", "12", "2026-08-19T13:45:00.000Z", "", "11"));
    const lastLuna = { classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { kind: "positive_pnl_display", execution_state: "unrealized_gain_displayed" }, follow_up: { parent_message_id: "11" } };
    luna(db, last.id, lastLuna);
    const lastAsset = appendMediaAsset(db, { rawMessageId: last.id, mediaIndex: 0, telegramKind: "photo", sizeBytes: 1, sha256: "b".repeat(64), storagePath: "last.png" });
    appendMediaAnalysis(db, { mediaAssetId: lastAsset.id, schemaVersion: "media-vision.v1", model: "test", status: "ok", output: { entities: { prices: ["345", "1.80", "1.22"] } } });
    const lastRow = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(last.id);
    const context = resolveSignalContext(db, lastRow, lastLuna);
    const built = buildLifecycleReview(db, context, lastRow, { data_tier: "text_only", as_of: lastRow.published_at });
    assert.equal(built.status, "execution_only_source_reported");
    assert.equal(built.review.execution_check.entry_execution_price, 1.22);
    assert.equal(built.review.execution_check.exit_execution_price, 1.8);
    assert.equal(built.review.execution_check.accepted_as_executable, true);
    assert.equal(built.review.execution_check.independently_verified, false);
    assert.equal(built.review.execution_check.gross_executable_return, (1.8 - 1.22) / 1.22);

    const final = appendRawMessage(db, raw("source", "13", "2026-08-19T13:50:00.000Z", "全部走掉了", "12"));
    const finalLuna = { classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { kind: "take_profit", execution_state: "claimed_fill" }, follow_up: { parent_message_id: "12" } };
    luna(db, final.id, finalLuna);
    const finalRow = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(final.id);
    const finalContext = resolveSignalContext(db, finalRow, finalLuna);
    const finalReview = buildLifecycleReview(db, finalContext, finalRow, { data_tier: "text_only", as_of: finalRow.published_at });
    assert.equal(finalReview.review.execution_check.exit_execution_price, 1.8);

    const afterFinal = appendRawMessage(db, raw("source", "14", "2026-08-19T13:52:00.000Z", "", "13"));
    const afterFinalLuna = { classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { kind: "positive_pnl_display", execution_state: "positive_pnl_displayed" }, follow_up: { parent_message_id: "13" } };
    luna(db, afterFinal.id, afterFinalLuna);
    const afterFinalAsset = appendMediaAsset(db, { rawMessageId: afterFinal.id, mediaIndex: 0, telegramKind: "photo", sizeBytes: 1, sha256: "c".repeat(64), storagePath: "after-final.png" });
    appendMediaAnalysis(db, { mediaAssetId: afterFinalAsset.id, schemaVersion: "media-vision.v1", model: "test", status: "ok", output: { entities: { prices: ["345", "2.10", "1.22"] } } });
    const afterFinalRow = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(afterFinal.id);
    const afterFinalContext = resolveSignalContext(db, afterFinalRow, afterFinalLuna);
    const afterFinalReview = buildLifecycleReview(db, afterFinalContext, afterFinalRow, { data_tier: "text_only", as_of: afterFinalRow.published_at });
    assert.equal(afterFinalReview.review.execution_check.exit_execution_price, 2.1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited #2059 sell closes once at the final @0.94 and uses the edit as event time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-edited-exit-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  try {
    const entry = appendRawMessage(db, raw(
      "meigu_baijialun", "2058", "2026-08-21T15:00:00.000Z",
      "SPY 650 Call 8/21 @0.50"
    ));
    luna(db, entry.id, {
      schema_version: "luna.v1", classification: "options_signal", signal_id: "spy-2058",
      contract: {
        symbol: "SPY", expiry: "2026-08-21", strike: 650, option_type: "call", side: "buy",
        entry_price: { value: 0.50, kind: "source_reported_fill" }
      }
    });

    const originalExitAt = "2026-08-21T15:30:00.000Z";
    const original = appendRawMessage(db, raw(
      "meigu_baijialun", "2059", originalExitAt, "清掉@0.90", "2058"
    ));
    luna(db, original.id, {
      schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close",
      lifecycle: { kind: "take_profit", reference_exit_price: 0.90 },
      follow_up: { parent_message_id: "2058" }
    });

    const editedAt = "2026-08-21T15:35:00.000Z";
    const edited = appendRawMessage(db, {
      ...raw("meigu_baijialun", "2059", originalExitAt, "清掉@0.94", "2058"),
      editedAt,
      receivedAt: "2026-08-21T15:35:01.000Z"
    });
    luna(db, edited.id, {
      schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close",
      lifecycle: { kind: "take_profit", reference_exit_price: 0.92 },
      follow_up: { parent_message_id: "2058" }
    });
    luna(db, edited.id, {
      schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close",
      lifecycle: { kind: "take_profit", reference_exit_price: 0.94 },
      follow_up: { parent_message_id: "2058" }
    });

    const summary = backfillLifecycleReviews(db);
    assert.deepEqual(
      { exits: summary.exits, linked: summary.linked, execution_only: summary.execution_only, appended: summary.appended },
      { exits: 1, linked: 1, execution_only: 1, appended: 1 }
    );
    const stored = db.prepare("SELECT * FROM lifecycle_reviews").all();
    assert.equal(stored.length, 1);
    assert.equal(Number(stored[0].exit_raw_message_id), edited.id);
    const review = JSON.parse(stored[0].review_json);
    assert.equal(review.execution_check.exit_execution_price, 0.94);
    assert.equal(review.exit.published_at, editedAt);
    assert.equal(review.exit.source_published_at, originalExitAt);
    assert.equal(review.exit.hold_minutes, 35);

    const daily = listDailyLifecycleReviews(db, "2026-08-21T15:34:00.000Z", "2026-08-21T15:36:00.000Z");
    assert.equal(daily.length, 1);
    assert.equal(Number(daily[0].exit_raw_message_id), edited.id);
    assert.equal(daily[0].published_at, editedAt);
    assert.equal(daily[0].source_published_at, originalExitAt);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
