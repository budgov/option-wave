import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisSessionKey,
  archiveSecondaryContext,
  canArchiveAsSecondaryContext,
  humanInterpretationRequest,
  messageClockDeltaMilliseconds,
  rawRowForPrompt,
  terraInputManifest
} from "../src/pipeline.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRawMessage, getLatestStageOutput, openDatabase } from "../src/db.js";

test("pipeline exposes configured channel semantics to Luna", () => {
  const config = { channelSemantics: { source: { entryAction: "buy_to_open", exitAction: "sell_to_close" } } };
  const raw = rawRowForPrompt(config, {
    id: 1, channel_key: "source", telegram_chat_id: "1", telegram_message_id: "2", version: 1,
    published_at: "2026-01-01T00:00:00.000Z", received_at: "2026-01-01T00:00:00.000Z", raw_text: "entry"
  });
  assert.deepEqual(raw.source_semantics, { entryAction: "buy_to_open", exitAction: "sell_to_close" });
});

test("Luna and Terra sessions are isolated by message, version, and retry", () => {
  const row = { id: 42, channel_key: "go_finance", version: 2 };
  assert.equal(analysisSessionKey("luna", row, 1), "luna-go_finance-raw42-v2-a1");
  assert.equal(analysisSessionKey("terra", row, 2), "terra-go_finance-raw42-v2-a2");
  assert.notEqual(analysisSessionKey("terra", row, 1), analysisSessionKey("terra", { ...row, id: 43 }, 1));
});

test("Terra audit input references the durable snapshot instead of duplicating its option chain", () => {
  const snapshot = {
    provider: "schwab",
    data_tier: "realtime_option_chain",
    observed_at: "2026-08-21T17:00:00.000Z",
    option_chain: { deliberately_large: "x".repeat(100_000) }
  };
  const manifest = terraInputManifest({
    id: 42,
    channel_key: "go_finance",
    telegram_message_id: "2059",
    version: 2,
    published_at: "2026-08-21T16:59:00.000Z",
    received_at: "2026-08-21T16:59:59.000Z",
    edited_at: "2026-08-21T17:00:00.000Z"
  }, {
    schema_version: "luna.v1",
    classification: "update",
    lifecycle_action: "sell_to_close",
    contract: { symbol: "TSLA", strike: 347.5, option_type: "call" }
  }, { id: 9, snapshot, snapshot_json: JSON.stringify(snapshot) }, {
    schema_version: "terra-raw-prompt.v1",
    deliberately_large: "y".repeat(100_000)
  });
  assert.equal(manifest.market_snapshot.id, 9);
  assert.equal(manifest.telegram_message.event_at, "2026-08-21T17:00:00.000Z");
  assert.equal(manifest.telegram_message.clock_delta_ms, -1000);
  assert.match(manifest.market_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.luna_result.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.raw_prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(manifest).includes("deliberately_large"), false);
  assert.ok(JSON.stringify(manifest).length < 2_000);
});

test("message clock delta remains signed and distinguishes missing timestamps", () => {
  assert.equal(messageClockDeltaMilliseconds({
    received_at: "2026-08-21T16:59:59.000Z",
    edited_at: "2026-08-21T17:00:00.000Z"
  }), -1000);
  assert.equal(messageClockDeltaMilliseconds({
    receivedAt: "2026-08-21T17:00:01.250Z",
    publishedAt: "2026-08-21T17:00:00.000Z"
  }), 1250);
  assert.equal(messageClockDeltaMilliseconds({ publishedAt: "2026-08-21T17:00:00.000Z" }), null);
});

test("only language uncertainty enters human interpretation, not model abstention", () => {
  const config = { listener: { humanInterpretationConfidenceThreshold: 0.75 } };
  const pending = humanInterpretationRequest(config, {
    classification: "non_signal", confidence: { overall: 0.9 }, ambiguities: []
  }, { needs_human_interpretation: true, uncertainty_reason: "unclassified_reply" });
  assert.equal(pending.reason, "unclassified_reply");
  assert.equal(humanInterpretationRequest(config, {
    classification: "options_signal", confidence: { overall: 0.98 },
    contract: { open_action: "buy_to_open" }, ambiguities: []
  }, { needs_human_interpretation: false }), null);
});

test("strictly unrelated prose is archived locally while replies, media, and option clues stay on the AI path", () => {
  const record = {
    channelKey: "go_finance", chatId: "1", messageId: "10",
    publishedAt: "2026-08-21T16:00:00.000Z", receivedAt: "2026-08-21T16:00:00.100Z",
    rawText: "大盘仍在压力区，关注长期利率。", raw: { has_media: false }
  };
  const hint = { schema_version: "signal-hint.v2", classification: "non_signal", explicit: false };
  assert.equal(canArchiveAsSecondaryContext(record, hint), true);
  assert.equal(canArchiveAsSecondaryContext({ ...record, replyToMessageId: "9" }, hint), false);
  assert.equal(canArchiveAsSecondaryContext({ ...record, raw: { has_media: true } }, hint), false);
  assert.equal(canArchiveAsSecondaryContext(record, { ...hint, needs_human_interpretation: true }), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-secondary-router-"));
  const db = openDatabase(path.join(root, "router.sqlite"));
  try {
    const stored = appendRawMessage(db, record);
    assert.equal(archiveSecondaryContext(db, record, stored.id, hint).inserted, true);
    assert.equal(archiveSecondaryContext(db, record, stored.id, hint).inserted, false);
    const luna = getLatestStageOutput(db, stored.id, "luna");
    assert.equal(luna.classification, "non_signal");
    assert.equal(luna.data_role, "secondary_market_context");
    assert.equal(luna.routing.excluded_from_option_calculation, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_runs").get().n, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
