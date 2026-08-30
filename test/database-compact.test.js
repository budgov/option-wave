import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { runDatabaseCompaction } from "../scripts/database-compact.js";
import {
  appendAnalysis,
  appendInterpretationEvent,
  appendLifecycleReview,
  appendMarketSnapshot,
  appendMediaAnalysis,
  appendMediaAsset,
  appendModelFeedback,
  appendPositionWorkflowEvent,
  appendRawMessage,
  checkpointAndCloseDatabase,
  openDatabase,
  setOperationalState
} from "../src/db.js";

function hashFile(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ live = false, legacyTerra = true, sidecars = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-db-compact-"));
  const database = path.join(root, "data", "ocean-wave.sqlite");
  writeJson(path.join(root, "config.json"), { data: { database: "data/ocean-wave.sqlite" } });
  const db = openDatabase(database);
  const publishedAt = "2026-08-21T15:00:00.000Z";
  const receivedAt = "2026-08-21T15:00:00.250Z";
  const signal = appendRawMessage(db, {
    channelKey: "meigu_baijialun",
    chatId: "-1001",
    messageId: "2058",
    publishedAt,
    receivedAt,
    rawText: "SPY 看涨 650 Call @0.50",
    raw: {}
  });
  const rawPrompt = {
    database_id: signal.id,
    channel_key: "meigu_baijialun",
    chat_id: "-1001",
    message_id: "2058",
    version: 1,
    published_at: publishedAt,
    received_at: receivedAt,
    edited_at: null,
    reply_to_message_id: null,
    raw_text: "SPY 看涨 650 Call @0.50",
    source_semantics: { entryAction: "buy_to_open", exitAction: "sell_to_close" },
    deterministic_signal_hint: { classification: "options_signal" },
    media_ingest_error: null,
    media_evidence: []
  };
  const luna = {
    schema_version: "luna.v1",
    classification: "options_signal",
    signal_id: "fixture-2058",
    contract: { symbol: "SPY", expiry: "2026-08-21", strike: 650, option_type: "call", side: "buy" },
    confidence: { overall: 0.9 }
  };
  appendAnalysis(db, {
    rawMessageId: signal.id,
    stage: "luna",
    schemaVersion: "luna.v1",
    model: "fixture",
    status: "ok",
    input: rawPrompt,
    output: luna
  });
  const snapshot = {
    schema_version: "ocean-wave-market.v1",
    provider: "schwab",
    data_tier: "realtime",
    observed_at: publishedAt,
    as_of: publishedAt,
    captured_at: receivedAt,
    target_contract: { matched: { bid: 0.49, ask: 0.51, quote_timestamp: publishedAt } },
    chain: Array.from({ length: 300 }, (_, index) => ({
      symbol: `SPY260821C00${String(640000 + index).padStart(6, "0")}`,
      strike: 640 + index / 2,
      bid: index / 100,
      ask: index / 100 + 0.02,
      delta: 0.5,
      gamma: 0.02,
      theta: -0.03,
      volatility: 0.25
    }))
  };
  const snapshotId = appendMarketSnapshot(db, signal.id, snapshot);
  const legacyInput = { raw: rawPrompt, luna, marketSnapshot: snapshot };
  const terraIds = [];
  if (legacyTerra) {
    terraIds.push(appendAnalysis(db, {
      rawMessageId: signal.id,
      stage: "terra",
      schemaVersion: "terra.v1",
      model: "fixture",
      status: "error",
      input: legacyInput,
      error: "retryable fixture"
    }));
    terraIds.push(appendAnalysis(db, {
      rawMessageId: signal.id,
      stage: "terra",
      schemaVersion: "terra.v1",
      model: "fixture",
      status: "ok",
      input: legacyInput,
      output: { schema_version: "terra.v1", status: "scored" }
    }));
    appendAnalysis(db, {
      rawMessageId: signal.id,
      stage: "terra",
      schemaVersion: "terra.v1",
      model: "fixture",
      status: "error",
      input: { ...legacyInput, marketSnapshot: { ...snapshot, provider: "not-the-durable-snapshot" } },
      error: "must remain unmodified"
    });
  }

  const exit = appendRawMessage(db, {
    channelKey: "meigu_baijialun",
    chatId: "-1001",
    messageId: "2059",
    replyToMessageId: "2058",
    publishedAt: "2026-08-21T15:30:00.000Z",
    receivedAt: "2026-08-21T15:30:00.100Z",
    rawText: "清掉@0.94",
    raw: {}
  });
  appendLifecycleReview(db, {
    signalRawMessageId: signal.id,
    exitRawMessageId: exit.id,
    reviewVersion: "fixture.v1",
    inputManifest: { signal: signal.id, exit: exit.id },
    status: "scored",
    review: { pnl: 0.44 }
  });
  appendPositionWorkflowEvent(db, {
    eventKey: "active:opened",
    workflowId: "active-position",
    signalRawMessageId: signal.id,
    eventType: "opened",
    payload: { entry: true }
  });
  appendPositionWorkflowEvent(db, {
    eventKey: "done:opened",
    workflowId: "completed-position",
    signalRawMessageId: signal.id,
    eventType: "opened",
    payload: { entry: true }
  });
  appendPositionWorkflowEvent(db, {
    eventKey: "done:completed",
    workflowId: "completed-position",
    signalRawMessageId: signal.id,
    exitRawMessageId: exit.id,
    eventType: "completed",
    payload: { done: true }
  });
  appendPositionWorkflowEvent(db, {
    eventKey: "done:later-correction",
    workflowId: "completed-position",
    signalRawMessageId: signal.id,
    exitRawMessageId: exit.id,
    eventType: "semantic_correction",
    payload: { corrected: true }
  });
  appendModelFeedback(db, {
    workflowId: "completed-position",
    feedbackVersion: "fixture.v1",
    status: "recorded",
    feedback: { brier: 0.1 }
  });
  const media = appendMediaAsset(db, {
    rawMessageId: exit.id,
    mediaIndex: 0,
    telegramKind: "photo",
    mimeType: "image/jpeg",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    storagePath: "data/media/fixture.jpg"
  });
  appendMediaAnalysis(db, {
    mediaAssetId: media.id,
    schemaVersion: "media-vision.v1",
    model: "fixture",
    status: "ok",
    output: { visible_text: "0.94" }
  });
  appendInterpretationEvent(db, {
    eventKey: "fixture:resolved",
    rawMessageId: exit.id,
    eventType: "resolved",
    payload: { meaning: "sell_to_close" }
  });
  setOperationalState(db, "telegram_cursor:meigu_baijialun", { message_id: "2059" });
  setOperationalState(db, "telegram_cursor:go_finance", { message_id: "3391" });
  db.prepare(`
    INSERT INTO daily_reports(report_date,created_at,model,input_manifest_json,report_json)
    VALUES(?,?,?,?,?)
  `).run("2026-08-21", new Date().toISOString(), "fixture", "{}", "{}");
  checkpointAndCloseDatabase(db);
  assert.equal(fs.existsSync(`${database}-wal`), false);
  assert.equal(fs.existsSync(`${database}-shm`), false);
  writeJson(path.join(root, "data", "listener-runtime.json"), {
    schema_version: "listener-runtime.v1",
    instance_id: "fixture",
    status: live ? "ready" : "stopped",
    pid: live ? process.pid : 999_999,
    stopped_at: live ? null : "2026-08-21T20:00:00.000Z"
  });
  if (sidecars) {
    fs.writeFileSync(`${database}-wal`, "must-not-touch");
    fs.writeFileSync(`${database}-shm`, "must-not-touch");
  }
  return { root, database, snapshot, snapshotId, terraIds };
}

function removeFixture(root) {
  assert.match(path.basename(root), /^ow-db-compact-/);
  fs.rmSync(root, { recursive: true, force: true });
}

test("database compaction defaults to dry-run while the live database stays byte-identical", () => {
  const fixtureData = fixture({ live: true });
  try {
    const before = hashFile(fixtureData.database);
    const result = runDatabaseCompaction({
      workspaceRoot: fixtureData.root,
      outputManifest: "outputs/dry-run.json",
      isProcessAlive: (pid) => pid === process.pid
    });
    assert.equal(result.exitCode, 0, JSON.stringify({ errors: result.manifest.errors, migration: result.manifest.migration }, null, 2));
    assert.equal(result.manifest.status, "planned_apply_currently_blocked");
    assert.equal(result.manifest.plan.eligible_rows, 2);
    assert.equal(result.manifest.plan.skipped.durable_snapshot_not_byte_identical, 1);
    assert.ok(result.manifest.plan.estimated_payload_savings_bytes > 0);
    assert.equal(hashFile(fixtureData.database), before);
    assert.equal(fs.existsSync(path.join(fixtureData.root, "data", "db-archives")), false);
  } finally {
    removeFixture(fixtureData.root);
  }
});

test("apply refuses before database analysis when any recorded PID is alive", () => {
  const fixtureData = fixture({ live: true });
  try {
    const before = hashFile(fixtureData.database);
    const result = runDatabaseCompaction({
      workspaceRoot: fixtureData.root,
      apply: true,
      outputManifest: "outputs/live-refusal.json",
      isProcessAlive: (pid) => pid === process.pid
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, "refused_not_verified_cold_database");
    assert.equal(result.manifest.plan, null);
    assert.equal(hashFile(fixtureData.database), before);
    assert.equal(fs.existsSync(path.join(fixtureData.root, "data", "db-archives")), false);
  } finally {
    removeFixture(fixtureData.root);
  }
});

test("apply leaves present production WAL/SHM sidecars byte-identical and refuses", () => {
  const fixtureData = fixture({ sidecars: true });
  try {
    const before = hashFile(fixtureData.database);
    const wal = fs.readFileSync(`${fixtureData.database}-wal`, "utf8");
    const shm = fs.readFileSync(`${fixtureData.database}-shm`, "utf8");
    const result = runDatabaseCompaction({
      workspaceRoot: fixtureData.root,
      apply: true,
      outputManifest: "outputs/sidecar-refusal.json",
      isProcessAlive: () => false
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, "refused_not_verified_cold_database");
    assert.equal(result.manifest.sidecars.wal_exists, true);
    assert.equal(result.manifest.sidecars.shm_exists, true);
    assert.equal(fs.readFileSync(`${fixtureData.database}-wal`, "utf8"), wal);
    assert.equal(fs.readFileSync(`${fixtureData.database}-shm`, "utf8"), shm);
    assert.equal(hashFile(fixtureData.database), before);
  } finally {
    removeFixture(fixtureData.root);
  }
});

test("cold apply archives first and compacts only byte-identical Terra snapshot duplication", () => {
  const fixtureData = fixture();
  try {
    const originalBytes = fs.readFileSync(fixtureData.database);
    const originalHash = hashFile(fixtureData.database);
    const result = runDatabaseCompaction({
      workspaceRoot: fixtureData.root,
      apply: true,
      outputManifest: "outputs/applied.json",
      isProcessAlive: () => false,
      now: new Date("2026-08-21T21:00:00.000Z")
    });
    assert.equal(result.exitCode, 0, JSON.stringify({ errors: result.manifest.errors, migration: result.manifest.migration }, null, 2));
    assert.equal(result.manifest.status, "applied");
    assert.equal(result.manifest.plan.eligible_rows, 2);
    assert.deepEqual(result.manifest.after.table_counts, result.manifest.before.table_counts);
    assert.equal(result.manifest.after.integrity_check, "ok");
    assert.deepEqual(result.manifest.after.foreign_key_violations, []);
    assert.deepEqual(result.manifest.after.active_workflows, [
      { workflow_id: "active-position", signal_raw_message_id: 1 }
    ]);
    assert.equal(result.manifest.archive.decompression_verified, true);
    const archivedBytes = gunzipSync(fs.readFileSync(result.manifest.archive.archive_path));
    assert.equal(crypto.createHash("sha256").update(archivedBytes).digest("hex"), originalHash);
    assert.deepEqual(archivedBytes, originalBytes);
    const archiveManifest = JSON.parse(fs.readFileSync(result.manifest.archive.manifest_path, "utf8"));
    assert.equal(archiveManifest.source_sha256, originalHash);
    assert.equal(archiveManifest.decompression_verified, true);

    const db = new DatabaseSync(fixtureData.database, { readOnly: true });
    try {
      const storedSnapshot = db.prepare("SELECT snapshot_json FROM market_snapshots WHERE id=?").get(fixtureData.snapshotId);
      assert.equal(storedSnapshot.snapshot_json, JSON.stringify(fixtureData.snapshot));
      for (const id of fixtureData.terraIds) {
        const input = JSON.parse(db.prepare("SELECT input_json FROM analysis_runs WHERE id=?").get(id).input_json);
        assert.equal(input.schema_version, "terra-input-manifest.v1");
        assert.equal(input.market_snapshot.id, fixtureData.snapshotId);
        assert.equal(input.raw_message_id, 1);
      }
      const mismatched = JSON.parse(db.prepare("SELECT input_json FROM analysis_runs WHERE stage='terra' ORDER BY id DESC LIMIT 1").get().input_json);
      assert.equal(mismatched.marketSnapshot.provider, "not-the-durable-snapshot");
      assert.equal(db.prepare("SELECT COUNT(*) n FROM raw_messages").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM lifecycle_reviews").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM model_feedback").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM market_snapshots").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM position_workflow_events").get().n, 4);
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='analysis_runs_deny_update'").get();
      assert.match(trigger.sql, /append-only/);
    } finally {
      db.close();
    }
    assert.equal(fs.existsSync(`${fixtureData.database}-wal`), false);
    assert.equal(fs.existsSync(`${fixtureData.database}-shm`), false);
  } finally {
    removeFixture(fixtureData.root);
  }
});

test("zero eligible rows is a strict no-op without archive, VACUUM, or replacement", () => {
  const fixtureData = fixture({ legacyTerra: false });
  try {
    const beforeHash = hashFile(fixtureData.database);
    const beforeStat = fs.statSync(fixtureData.database);
    const result = runDatabaseCompaction({
      workspaceRoot: fixtureData.root,
      apply: true,
      outputManifest: "outputs/nothing.json",
      isProcessAlive: () => false
    });
    const afterStat = fs.statSync(fixtureData.database);
    assert.equal(result.exitCode, 0);
    assert.equal(result.manifest.status, "nothing_to_compact");
    assert.equal(result.manifest.plan.eligible_rows, 0);
    assert.equal(result.manifest.archive, null);
    assert.equal(result.manifest.migration, null);
    assert.equal(hashFile(fixtureData.database), beforeHash);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(fs.existsSync(path.join(fixtureData.root, "data", "db-archives")), false);
  } finally {
    removeFixture(fixtureData.root);
  }
});
