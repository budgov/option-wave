import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendAnalysis,
  appendInterpretationEvent,
  appendIntradayEvent,
  appendRawMessage,
  checkpointAndCloseDatabase,
  listIntradayEvents,
  listPendingInterpretations,
  openDatabase
} from "../src/db.js";

test("raw messages deduplicate exact content and version edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-db-"));
  const db = openDatabase(path.join(root, "test.sqlite"));
  const base = {
    channelKey: "go_finance",
    chatId: "123",
    messageId: "77",
    publishedAt: "2026-08-16T17:00:00.000Z",
    receivedAt: "2026-08-16T17:00:01.000Z",
    rawText: "AAPL 220C",
    raw: {}
  };
  const first = appendRawMessage(db, base);
  const duplicate = appendRawMessage(db, base);
  const metadataOnlyEdit = appendRawMessage(db, { ...base, editedAt: "2026-08-16T17:00:30.000Z" });
  const replyNumber = appendRawMessage(db, { ...base, messageId: "78", replyToMessageId: 76 });
  const replyString = appendRawMessage(db, { ...base, messageId: "78", replyToMessageId: "76" });
  const edit = appendRawMessage(db, { ...base, rawText: "AAPL 225C", editedAt: "2026-08-16T17:01:00.000Z" });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(metadataOnlyEdit.inserted, false);
  assert.equal(replyNumber.inserted, true);
  assert.equal(replyString.inserted, false);
  assert.equal(edit.inserted, true);
  assert.equal(db.prepare("SELECT version FROM raw_messages WHERE telegram_message_id='77' ORDER BY id").all()[1].version, 2);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("analysis history is append-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-db-"));
  const db = openDatabase(path.join(root, "test.sqlite"));
  const id = appendAnalysis(db, {
    stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: {}
  });
  assert.throws(() => db.prepare("UPDATE analysis_runs SET status='error' WHERE id=?").run(id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM analysis_runs WHERE id=?").run(id), /append-only/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe close checkpoints WAL and preserves database integrity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-db-"));
  const filename = path.join(root, "test.sqlite");
  const db = openDatabase(filename);
  appendAnalysis(db, {
    stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {}, output: {}
  });
  checkpointAndCloseDatabase(db);
  assert.equal(fs.existsSync(`${filename}-wal`), false);
  const reopened = openDatabase(filename);
  assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM analysis_runs").get().n, 1);
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("human interpretation queue is append-only and resolves by a later event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-interpretation-"));
  const db = openDatabase(path.join(root, "test.sqlite"));
  const raw = appendRawMessage(db, {
    channelKey: "source", chatId: "1", messageId: "2",
    publishedAt: "2026-08-21T14:00:00.000Z", receivedAt: "2026-08-21T14:00:00.100Z",
    replyToMessageId: "1", rawText: "先跑一点", raw: {}
  });
  appendInterpretationEvent(db, {
    eventKey: `raw-${raw.id}:pending`, rawMessageId: raw.id, eventType: "pending",
    payload: { reason: "unclassified_reply", market_snapshot: { provider: "schwab" } }
  });
  assert.equal(listPendingInterpretations(db).length, 1);
  appendInterpretationEvent(db, {
    eventKey: `raw-${raw.id}:resolved`, rawMessageId: raw.id, eventType: "resolved",
    payload: { explanation: "sell_to_close" }
  });
  assert.equal(listPendingInterpretations(db).length, 0);
  assert.throws(() => db.prepare("DELETE FROM interpretation_events").run(), /append-only/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("intraday research events are idempotent and append-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-intraday-"));
  const db = openDatabase(path.join(root, "test.sqlite"));
  const record = {
    eventKey: "2026-08-24:QQQ:sample:2026-08-24T13:31:00Z",
    sessionDate: "2026-08-24",
    eventType: "minute_sample",
    symbol: "QQQ",
    source: "schwab",
    eventAt: "2026-08-24T13:31:00.000Z",
    payload: { price: 700.25 }
  };
  assert.equal(appendIntradayEvent(db, record).inserted, true);
  assert.equal(appendIntradayEvent(db, record).inserted, false);
  const rows = listIntradayEvents(db, { sessionDate: "2026-08-24", symbol: "qqq" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.price, 700.25);
  assert.throws(() => db.prepare("DELETE FROM intraday_events").run(), /append-only/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
