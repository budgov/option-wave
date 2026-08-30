import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertInsideWorkspace, runMaintenanceCleanup } from "../scripts/maintenance-clean.js";

function write(filename, content = "fixture") {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function fileHash(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function createDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE raw_messages (
      id INTEGER PRIMARY KEY,telegram_chat_id TEXT,telegram_message_id TEXT,version INTEGER,
      raw_text TEXT,raw_json TEXT
    );
    CREATE TABLE analysis_runs (
      id INTEGER PRIMARY KEY,raw_message_id INTEGER,stage TEXT,status TEXT,
      input_json TEXT,output_json TEXT,error_text TEXT
    );
    CREATE TABLE lifecycle_reviews (
      id INTEGER PRIMARY KEY,signal_raw_message_id INTEGER,exit_raw_message_id INTEGER,review_json TEXT
    );
    CREATE TABLE daily_reports (
      id INTEGER PRIMARY KEY,report_date TEXT,input_manifest_json TEXT,report_json TEXT
    );
    CREATE TABLE market_snapshots (id INTEGER PRIMARY KEY,snapshot_json TEXT);
    INSERT INTO raw_messages VALUES
      (1,'chat','2059',1,'clear @0.90','{}'),
      (2,'chat','2059',2,'clear @0.94','{}');
    INSERT INTO analysis_runs VALUES
      (1,1,'luna','ok','{}','{"price":0.90}',NULL),
      (2,2,'luna','ok','{}','{"price":0.94}',NULL),
      (3,2,'luna','ok','{}','{"price":0.94}',NULL);
    INSERT INTO lifecycle_reviews VALUES (1,10,2,'{"old":true}'),(2,10,2,'{"latest":true}');
    INSERT INTO daily_reports VALUES
      (1,'2026-08-21','{}','{"old":true}'),
      (2,'2026-08-21','{}','{"latest":true}');
    INSERT INTO market_snapshots VALUES (1,'{"chain":[1,2,3]}');
  `);
  db.close();
}

function fixture({ live = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-maintenance-"));
  write(path.join(root, "config.json"), `${JSON.stringify({ data: { database: "data/ocean-wave.sqlite" } })}\n`);
  const database = path.join(root, "data", "ocean-wave.sqlite");
  createDatabase(database);
  write(path.join(root, "data", "listener-runtime.json"), JSON.stringify({
    schema_version: "listener-runtime.v1",
    instance_id: "fixture",
    status: live ? "ready" : "stopped",
    pid: live ? process.pid : 999_999,
    market_data_worker: { running: live, pid: live ? process.pid : 999_998 }
  }));
  write(path.join(root, "data", "media", "channel", "capture.jpg"), "original-jpeg");
  write(path.join(root, "data", "media", "channel", "capture.jpg.vision.png"), "derived-png");
  write(path.join(root, "data", "media", "channel", "orphan.vision.png"), "must-remain");
  write(path.join(root, "benchmarks", "__pycache__", "clean.pyc"), "bytecode");
  write(path.join(root, "option_wave", "__pycache__", "compiled.pyc"), "bytecode");
  write(path.join(root, "option_wave", "__pycache__", "README.txt"), "unknown");
  write(path.join(root, ".venv", "Lib", "site-packages", "pkg", "__pycache__", "venv.pyc"), "keep");
  write(path.join(root, "build", "temp", "module.obj"), "object");
  write(path.join(root, "build", "lib", "_core.pyd"), "build-copy");
  write(path.join(root, "work", "refactor", "module.obj"), "work-object");
  write(path.join(root, "work", "smoke.tmp"), "smoke");
  write(path.join(root, "option_wave", "_core.cp312-win_amd64.pyd"), "installed");
  write(path.join(root, "data", "ocean-wave-state", "model.json"), "{}");
  write(path.join(root, "scripts", "normalize-image.py"), "# legacy\n");
  return { root, database };
}

function removeFixture(root) {
  assert.match(path.basename(root), /^ow-maintenance-/);
  fs.rmSync(root, { recursive: true, force: true });
}

test("maintenance cleanup defaults to an auditable dry-run", () => {
  const { root, database } = fixture();
  try {
    const before = fileHash(database);
    const result = runMaintenanceCleanup({
      workspaceRoot: root,
      manifestPath: "outputs/dry-run.json",
      isProcessAlive: () => false,
      now: new Date("2026-08-21T20:00:00.000Z")
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.manifest.mode, "dry_run");
    assert.equal(result.manifest.status, "planned");
    assert.ok(result.manifest.inventory.files.some((item) => item.category === "derived_vision_png"));
    assert.ok(result.manifest.inventory.files.some((item) => item.category === "legacy_python_image_preprocessor"));
    assert.ok(result.manifest.inventory.blocked.some((item) => item.path.endsWith("orphan.vision.png")));
    assert.equal(result.manifest.database.redundancy.superseded_raw_versions.rows, 1);
    assert.equal(result.manifest.database.redundancy.superseded_analysis_runs.rows, 2);
    assert.equal(result.manifest.database.redundancy.duplicate_lifecycle_reviews.rows, 1);
    assert.equal(result.manifest.database.redundancy.duplicate_daily_reports.rows, 1);
    assert.equal(result.manifest.database.redundancy.legacy_full_chain_snapshots.rows, 1);
    assert.ok(result.manifest.database.estimated_reclaimable_payload_bytes > 0);
    assert.equal(fileHash(database), before);
    assert.equal(fs.existsSync(path.join(root, "data", "media", "channel", "capture.jpg.vision.png")), true);
    assert.equal(fs.existsSync(path.join(root, "scripts", "normalize-image.py")), true);
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).status, "planned");
  } finally {
    removeFixture(root);
  }
});

test("--apply refuses before inventory or deletion when a runtime PID is alive", () => {
  const { root } = fixture({ live: true });
  try {
    const derived = path.join(root, "data", "media", "channel", "capture.jpg.vision.png");
    const result = runMaintenanceCleanup({
      workspaceRoot: root,
      apply: true,
      manifestPath: "outputs/refused.json",
      isProcessAlive: (pid) => pid === process.pid
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, "refused_listener_alive_or_unverifiable");
    assert.equal(result.manifest.inventory.summary.file_count, 0);
    assert.ok(result.manifest.listener.blocking_processes.length >= 1);
    assert.equal(fs.existsSync(derived), true);
    assert.equal(fs.existsSync(path.join(root, "scripts", "normalize-image.py")), true);
    assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).status, result.manifest.status);
  } finally {
    removeFixture(root);
  }
});

test("offline --apply removes only the allowlisted reproducible artifacts", () => {
  const { root, database } = fixture();
  try {
    const before = fileHash(database);
    const result = runMaintenanceCleanup({
      workspaceRoot: root,
      apply: true,
      manifestPath: "outputs/applied.json",
      isProcessAlive: () => false
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.manifest.status, "applied");
    assert.equal(result.manifest.deleted.errors.length, 0);
    assert.ok(result.manifest.deleted.files.some((item) => item.category === "legacy_python_image_preprocessor"));
    assert.equal(fs.existsSync(path.join(root, "data", "media", "channel", "capture.jpg.vision.png")), false);
    assert.equal(fs.existsSync(path.join(root, "data", "media", "channel", "capture.jpg")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "media", "channel", "orphan.vision.png")), true);
    assert.equal(fs.existsSync(path.join(root, "benchmarks", "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(root, "option_wave", "__pycache__", "compiled.pyc")), false);
    assert.equal(fs.existsSync(path.join(root, "option_wave", "__pycache__", "README.txt")), true);
    assert.equal(fs.existsSync(path.join(root, ".venv", "Lib", "site-packages", "pkg", "__pycache__", "venv.pyc")), true);
    assert.deepEqual(fs.readdirSync(path.join(root, "build")), []);
    assert.deepEqual(fs.readdirSync(path.join(root, "work")), []);
    assert.equal(fs.existsSync(path.join(root, "option_wave", "_core.cp312-win_amd64.pyd")), true);
    assert.equal(fs.existsSync(path.join(root, "data", "ocean-wave-state", "model.json")), true);
    assert.equal(fs.existsSync(path.join(root, "scripts", "normalize-image.py")), false);
    assert.equal(fileHash(database), before);
  } finally {
    removeFixture(root);
  }
});

test("maintenance paths cannot escape the workspace or outputs manifest directory", () => {
  const { root } = fixture();
  try {
    assert.throws(() => assertInsideWorkspace(root, root), /must be a child/);
    assert.throws(() => runMaintenanceCleanup({
      workspaceRoot: root,
      manifestPath: path.join(root, "..", "escaped.json"),
      isProcessAlive: () => false
    }), /must be a child/);
    assert.throws(() => runMaintenanceCleanup({
      workspaceRoot: root,
      manifestPath: "data/not-a-manifest-location.json",
      isProcessAlive: () => false
    }), /below/);
  } finally {
    removeFixture(root);
  }
});

test("a configured database can never overlap cleanup roots", () => {
  const { root, database } = fixture();
  try {
    write(path.join(root, "config.json"), `${JSON.stringify({ data: { database: "work/live.sqlite" } })}\n`);
    write(path.join(root, "work", "live.sqlite"), "protected-database");
    assert.throws(() => runMaintenanceCleanup({
      workspaceRoot: root,
      apply: true,
      manifestPath: "outputs/must-not-run.json",
      isProcessAlive: () => false
    }), /must remain below data/);
    assert.equal(fs.readFileSync(path.join(root, "work", "live.sqlite"), "utf8"), "protected-database");
    assert.equal(fs.existsSync(database), true);
  } finally {
    removeFixture(root);
  }
});

test("--apply fails closed when listener runtime evidence is missing", () => {
  const { root } = fixture();
  try {
    fs.unlinkSync(path.join(root, "data", "listener-runtime.json"));
    const derived = path.join(root, "data", "media", "channel", "capture.jpg.vision.png");
    const result = runMaintenanceCleanup({
      workspaceRoot: root,
      apply: true,
      manifestPath: "outputs/missing-runtime.json",
      isProcessAlive: () => false
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, "refused_listener_alive_or_unverifiable");
    assert.match(result.manifest.listener.verification_error, /missing/);
    assert.equal(fs.existsSync(derived), true);
  } finally {
    removeFixture(root);
  }
});

test("pending native deployment preserves the exact staged pyd during apply", () => {
  const { root } = fixture();
  try {
    const staged = path.join(root, "work", "refactor-build", "lib", "option_wave", "_core.cp312-win_amd64.pyd");
    const disposable = path.join(root, "work", "refactor-build", "temporary.obj");
    write(staged, "approved-staged-core");
    write(disposable, "temporary-build-output");
    write(path.join(root, "data", "ocean-wave-state", "native-core-deployment.json"), JSON.stringify({
      schema_version: "native-core-deployment.v1",
      status: "pending",
      staged_path: "work/refactor-build/lib/option_wave/_core.cp312-win_amd64.pyd"
    }));
    const result = runMaintenanceCleanup({
      workspaceRoot: root,
      apply: true,
      manifestPath: "outputs/preserve-native.json",
      isProcessAlive: () => false
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(staged, "utf8"), "approved-staged-core");
    assert.equal(fs.existsSync(disposable), false);
    assert.ok(result.manifest.inventory.blocked.some((item) => (
      item.path.endsWith("_core.cp312-win_amd64.pyd") && item.reason === "pending_native_core_deployment"
    )));
  } finally {
    removeFixture(root);
  }
});
