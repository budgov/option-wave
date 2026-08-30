import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { atomicWriteFileSync } from "../src/atomic-file.js";
import { terraInputManifest } from "../src/pipeline.js";
import {
  assertInsideWorkspace,
  defaultProcessAlive,
  inspectListenerRuntime,
  listenerGuardBlocked
} from "./maintenance-clean.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const ACTIVE_TERMINALS = new Set(["completed", "expired", "cancelled", "superseded"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function relativePath(root, filename) {
  return path.relative(root, filename).replaceAll("\\", "/");
}

function isInside(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymlinkAncestors(root, filename) {
  const absolute = assertInsideWorkspace(root, filename);
  const parts = path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean);
  let cursor = path.resolve(root);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Refusing path below symlink/reparse point: ${relativePath(root, cursor)}`);
    }
  }
  return absolute;
}

function resolveDatabase(root) {
  const configPath = path.join(root, "config.json");
  if (!fs.existsSync(configPath) || fs.lstatSync(configPath).isSymbolicLink()) {
    throw new Error("A regular workspace config.json is required.");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const configured = config.data?.database ?? "data/ocean-wave.sqlite";
  const databasePath = assertInsideWorkspace(root, path.isAbsolute(configured) ? configured : path.resolve(root, configured), "database");
  if (!isInside(path.join(root, "data"), databasePath)) throw new Error("Database must remain below workspace data/.");
  assertNoSymlinkAncestors(root, databasePath);
  if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
  const stat = fs.lstatSync(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Database must be a regular non-symlink file.");
  return databasePath;
}

function sidecarState(databasePath) {
  return {
    wal_path: `${databasePath}-wal`,
    shm_path: `${databasePath}-shm`,
    wal_exists: fs.existsSync(`${databasePath}-wal`),
    shm_exists: fs.existsSync(`${databasePath}-shm`),
    policy: "apply requires both production sidecars to be absent; this command never checkpoints, directly reads, copies, deletes, or replaces them"
  };
}

function controlledStopVerified(listener, sidecars) {
  return listener.status === "stopped"
    && !listenerGuardBlocked(listener)
    && !sidecars.wal_exists
    && !sidecars.shm_exists;
}

function fileFingerprint(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Database identity changed to a non-regular file.");
  const bytes = fs.readFileSync(filename);
  return {
    size_bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    device: stat.dev,
    inode: stat.ino,
    sha256: sha256(bytes)
  };
}

function sameFingerprint(left, right) {
  return left.size_bytes === right.size_bytes
    && left.mtime_ms === right.mtime_ms
    && left.device === right.device
    && left.inode === right.inode
    && left.sha256 === right.sha256;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function userTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function hashRows(db, table, omitted = new Set()) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const selected = columns.map((column) => column.name).filter((name) => !omitted.has(name));
  const primary = columns.filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => column.name);
  const order = primary.length ? primary : selected;
  const sql = `SELECT ${selected.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table)}`
    + (order.length ? ` ORDER BY ${order.map(quoteIdentifier).join(",")}` : "");
  const hash = crypto.createHash("sha256");
  for (const row of db.prepare(sql).iterate()) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function activeWorkflows(db, tables) {
  if (!tables.includes("position_workflow_events")) return [];
  const events = db.prepare(`
    SELECT workflow_id,signal_raw_message_id,event_type,id
    FROM position_workflow_events ORDER BY id
  `).all();
  const workflows = new Map();
  for (const event of events) {
    const current = workflows.get(event.workflow_id) ?? {
      workflow_id: event.workflow_id,
      signal_raw_message_id: Number(event.signal_raw_message_id),
      opened: false,
      terminal: false
    };
    if (event.event_type === "opened") current.opened = true;
    if (ACTIVE_TERMINALS.has(event.event_type)) current.terminal = true;
    workflows.set(event.workflow_id, current);
  }
  return [...workflows.values()].filter((item) => item.opened && !item.terminal)
    .map(({ workflow_id, signal_raw_message_id }) => ({ workflow_id, signal_raw_message_id }))
    .sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
}

function databaseVerification(db) {
  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  const integrity = integrityRows.length === 1 && Object.values(integrityRows[0])[0] === "ok";
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const tables = userTables(db);
  const tableCounts = Object.fromEntries(tables.map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count)
  ]));
  const contentHashes = Object.fromEntries(tables.map((table) => [
    table,
    hashRows(db, table, table === "analysis_runs" ? new Set(["input_json"]) : new Set())
  ]));
  const schemaRows = db.prepare(`
    SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name
  `).all();
  const cursors = tables.includes("operational_state")
    ? db.prepare("SELECT key,value,updated_at FROM operational_state WHERE key LIKE 'telegram_cursor:%' ORDER BY key").all()
    : [];
  return {
    integrity_check: integrity ? "ok" : integrityRows,
    foreign_key_violations: foreignKeyViolations,
    table_counts: tableCounts,
    content_hashes_excluding_analysis_input: contentHashes,
    schema_sha256: sha256(JSON.stringify(schemaRows)),
    telegram_cursors: cursors,
    active_workflows: activeWorkflows(db, tables),
    analysis_input_bytes: tables.includes("analysis_runs")
      ? Number(db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(input_json AS BLOB))),0) AS bytes FROM analysis_runs").get().bytes)
      : 0
  };
}

function coreRawMatches(rawRow, embedded) {
  const comparable = [
    [rawRow.id, embedded.database_id],
    [rawRow.channel_key, embedded.channel_key],
    [rawRow.telegram_chat_id, embedded.chat_id],
    [rawRow.telegram_message_id, embedded.message_id],
    [rawRow.version, embedded.version],
    [rawRow.published_at, embedded.published_at],
    [rawRow.received_at, embedded.received_at],
    [rawRow.edited_at, embedded.edited_at],
    [rawRow.reply_to_message_id, embedded.reply_to_message_id],
    [rawRow.raw_text, embedded.raw_text]
  ];
  return comparable.every(([left, right]) => (left == null && right == null) || String(left) === String(right));
}

export function buildTerraCompactionPlan(db) {
  const updates = [];
  const skipped = {};
  const noteSkipped = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const rows = db.prepare(`
    SELECT id,raw_message_id,input_json FROM analysis_runs
    WHERE stage='terra' ORDER BY id
  `).all();
  for (const analysis of rows) {
    let legacy;
    try {
      legacy = JSON.parse(analysis.input_json);
    } catch {
      noteSkipped("invalid_json");
      continue;
    }
    if (legacy?.schema_version === "terra-input-manifest.v1") {
      noteSkipped("already_compact");
      continue;
    }
    if (!legacy?.raw || !legacy?.luna || !legacy?.marketSnapshot) {
      noteSkipped("not_verified_legacy_shape");
      continue;
    }
    const rawRow = db.prepare("SELECT * FROM raw_messages WHERE id=?").get(Number(analysis.raw_message_id));
    if (!rawRow || !coreRawMatches(rawRow, legacy.raw)) {
      noteSkipped("raw_association_mismatch");
      continue;
    }
    const lunaJson = JSON.stringify(legacy.luna);
    const lunaRun = db.prepare(`
      SELECT id FROM analysis_runs
      WHERE raw_message_id=? AND stage='luna' AND output_json=?
      ORDER BY id DESC LIMIT 1
    `).get(Number(analysis.raw_message_id), lunaJson);
    if (!lunaRun) {
      noteSkipped("durable_luna_mismatch");
      continue;
    }
    const snapshotJson = JSON.stringify(legacy.marketSnapshot);
    const snapshot = db.prepare(`
      SELECT id,provider,data_tier,as_of,snapshot_json FROM market_snapshots
      WHERE raw_message_id=? AND snapshot_json=? ORDER BY id DESC LIMIT 1
    `).get(Number(analysis.raw_message_id), snapshotJson);
    if (!snapshot || sha256(snapshot.snapshot_json) !== sha256(snapshotJson)) {
      noteSkipped("durable_snapshot_not_byte_identical");
      continue;
    }
    const compact = terraInputManifest(rawRow, legacy.luna, {
      id: Number(snapshot.id),
      snapshot: legacy.marketSnapshot,
      snapshot_json: snapshot.snapshot_json
    }, legacy.raw);
    const compactJson = JSON.stringify(compact);
    if (Buffer.byteLength(compactJson) >= Buffer.byteLength(analysis.input_json)) {
      noteSkipped("no_size_reduction");
      continue;
    }
    updates.push({
      analysis_run_id: Number(analysis.id),
      raw_message_id: Number(analysis.raw_message_id),
      luna_analysis_run_id: Number(lunaRun.id),
      market_snapshot_id: Number(snapshot.id),
      original_bytes: Buffer.byteLength(analysis.input_json),
      compact_bytes: Buffer.byteLength(compactJson),
      savings_bytes: Buffer.byteLength(analysis.input_json) - Buffer.byteLength(compactJson),
      original_sha256: sha256(analysis.input_json),
      compact_sha256: sha256(compactJson),
      snapshot_sha256: sha256(snapshotJson),
      compact_json: compactJson,
      original_json: analysis.input_json
    });
  }
  return {
    updates,
    report: {
      terra_rows_scanned: rows.length,
      eligible_rows: updates.length,
      original_bytes: updates.reduce((sum, item) => sum + item.original_bytes, 0),
      compact_bytes: updates.reduce((sum, item) => sum + item.compact_bytes, 0),
      estimated_payload_savings_bytes: updates.reduce((sum, item) => sum + item.savings_bytes, 0),
      skipped,
      items: updates.map(({ compact_json, original_json, ...item }) => item)
    }
  };
}

function analyzeDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY;");
    db.exec("BEGIN;");
    try {
      const result = { plan: buildTerraCompactionPlan(db), verification: databaseVerification(db) };
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

function compareVerification(before, after, expectedUpdates) {
  const failures = [];
  if (after.integrity_check !== "ok") failures.push("integrity_check");
  if (after.foreign_key_violations.length) failures.push("foreign_key_check");
  for (const field of [
    "table_counts",
    "content_hashes_excluding_analysis_input",
    "schema_sha256",
    "telegram_cursors",
    "active_workflows"
  ]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) failures.push(field);
  }
  if (before.analysis_input_bytes - after.analysis_input_bytes
      !== expectedUpdates.reduce((sum, item) => sum + item.savings_bytes, 0)) {
    failures.push("analysis_input_byte_reconciliation");
  }
  return failures;
}

function validateCompactedInputs(db, updates) {
  const errors = [];
  for (const update of updates) {
    const row = db.prepare("SELECT raw_message_id,input_json FROM analysis_runs WHERE id=?").get(update.analysis_run_id);
    if (!row || Number(row.raw_message_id) !== update.raw_message_id || sha256(row.input_json) !== update.compact_sha256) {
      errors.push({ analysis_run_id: update.analysis_run_id, error: "compacted_row_hash_or_association_mismatch" });
      continue;
    }
    let compact;
    try {
      compact = JSON.parse(row.input_json);
    } catch {
      errors.push({ analysis_run_id: update.analysis_run_id, error: "compacted_row_invalid_json" });
      continue;
    }
    const snapshot = db.prepare("SELECT provider,data_tier,as_of,snapshot_json FROM market_snapshots WHERE id=?")
      .get(update.market_snapshot_id);
    const luna = db.prepare("SELECT output_json FROM analysis_runs WHERE id=? AND stage='luna'")
      .get(update.luna_analysis_run_id);
    if (compact.schema_version !== "terra-input-manifest.v1"
        || Number(compact.raw_message_id) !== update.raw_message_id
        || Number(compact.market_snapshot?.id) !== update.market_snapshot_id
        || !snapshot || sha256(snapshot.snapshot_json) !== compact.market_snapshot?.sha256
        || !luna || sha256(luna.output_json) !== compact.luna_result?.sha256) {
      errors.push({ analysis_run_id: update.analysis_run_id, error: "manifest_reference_validation_failed" });
    }
  }
  return errors;
}

function migrateTemporaryDatabase(tempDatabase, updates) {
  const db = new DatabaseSync(tempDatabase);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    const trigger = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='analysis_runs_deny_update'
    `).get();
    db.exec("BEGIN IMMEDIATE;");
    try {
      if (trigger?.sql) db.exec("DROP TRIGGER analysis_runs_deny_update;");
      const statement = db.prepare("UPDATE analysis_runs SET input_json=? WHERE id=? AND input_json=?");
      for (const update of updates) {
        const result = statement.run(update.compact_json, update.analysis_run_id, update.original_json);
        if (Number(result.changes) !== 1) throw new Error(`Analysis row ${update.analysis_run_id} changed during migration.`);
      }
      if (trigger?.sql) db.exec(trigger.sql);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    db.exec("VACUUM; PRAGMA optimize;");
  } finally {
    db.close();
  }
}

function makeArchive(root, databasePath, sourceFingerprint, now) {
  const archiveDirectory = path.join(root, "data", "db-archives");
  assertNoSymlinkAncestors(root, path.join(archiveDirectory, "placeholder"));
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const unique = crypto.randomUUID();
  const basename = `${path.basename(databasePath)}.${timestamp}.${sourceFingerprint.sha256.slice(0, 12)}.${unique}`;
  const archivePath = path.join(archiveDirectory, `${basename}.gz`);
  const archiveManifestPath = path.join(archiveDirectory, `${basename}.manifest.json`);
  const original = fs.readFileSync(databasePath);
  if (sha256(original) !== sourceFingerprint.sha256 || original.length !== sourceFingerprint.size_bytes) {
    throw new Error("Database changed before cold archive creation.");
  }
  const compressed = gzipSync(original, { level: 9 });
  atomicWriteFileSync(archivePath, compressed, { mode: 0o600, allowCopyFallback: false });
  const archived = fs.readFileSync(archivePath);
  const restored = gunzipSync(archived);
  if (sha256(archived) !== sha256(compressed)
      || restored.length !== original.length
      || sha256(restored) !== sourceFingerprint.sha256
      || !restored.equals(original)) {
    throw new Error("Cold archive decompression verification failed.");
  }
  const archiveManifest = {
    schema_version: "database-cold-archive.v1",
    created_at: now.toISOString(),
    source_database: relativePath(root, databasePath),
    source_size_bytes: original.length,
    source_sha256: sourceFingerprint.sha256,
    gzip_size_bytes: archived.length,
    gzip_sha256: sha256(archived),
    decompression_verified: true
  };
  atomicWriteFileSync(archiveManifestPath, `${JSON.stringify(archiveManifest, null, 2)}\n`, {
    mode: 0o600,
    allowCopyFallback: false
  });
  return {
    archive_path: archivePath,
    manifest_path: archiveManifestPath,
    source_sha256: sourceFingerprint.sha256,
    gzip_sha256: archiveManifest.gzip_sha256,
    source_size_bytes: original.length,
    gzip_size_bytes: archived.length,
    decompression_verified: true
  };
}

function manifestPath(root, requested, now) {
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const filename = requested
    ? assertInsideWorkspace(root, path.isAbsolute(requested) ? requested : path.resolve(root, requested), "manifest")
    : path.join(root, "outputs", `database-compact-${timestamp}.json`);
  if (!isInside(path.join(root, "outputs"), filename)) throw new Error("Manifest must be below workspace outputs/.");
  assertNoSymlinkAncestors(root, filename);
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error("Manifest target is a symlink.");
  return filename;
}

function writeManifest(root, filename, manifest) {
  assertNoSymlinkAncestors(root, filename);
  atomicWriteFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    allowCopyFallback: true
  });
}

function guardState(databasePath, runtimePath, isProcessAlive) {
  return {
    listener: inspectListenerRuntime(runtimePath, isProcessAlive),
    sidecars: sidecarState(databasePath)
  };
}

function guardStillStopped(databasePath, runtimePath, isProcessAlive) {
  const guard = guardState(databasePath, runtimePath, isProcessAlive);
  if (!controlledStopVerified(guard.listener, guard.sidecars)) {
    throw new Error("Controlled-stop guard failed: runtime must be stopped, all recorded PIDs offline, and WAL/SHM absent.");
  }
  return guard;
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function atomicReplaceDatabase(tempDatabase, databasePath) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tempDatabase, databasePath);
      return attempt + 1;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !new Set(["EPERM", "EACCES", "EBUSY"]).has(error.code)) throw error;
      pause(Math.min(250, 10 * 2 ** attempt));
    }
  }
  throw lastError;
}

function removeTemporaryDirectory(directory, allowedParent) {
  if (!directory || !fs.existsSync(directory)) return;
  const resolved = path.resolve(directory);
  const parent = path.resolve(allowedParent);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(".db-compact-")) {
    throw new Error(`Refusing unsafe temporary cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function runDatabaseCompaction({
  workspaceRoot = DEFAULT_ROOT,
  apply = false,
  outputManifest,
  isProcessAlive = defaultProcessAlive,
  now = new Date()
} = {}) {
  const root = fs.realpathSync(path.resolve(workspaceRoot));
  const databasePath = resolveDatabase(root);
  const runtimePath = path.join(path.dirname(databasePath), "listener-runtime.json");
  const outputPath = manifestPath(root, outputManifest, now);
  let guard = guardState(databasePath, runtimePath, isProcessAlive);
  const manifest = {
    schema_version: "database-compact.v1",
    generated_at: now.toISOString(),
    mode: apply ? "apply" : "dry_run",
    status: "initializing",
    workspace_root: root,
    database_path: databasePath,
    listener: guard.listener,
    sidecars: guard.sidecars,
    policy: {
      only_mutation: "analysis_runs.input_json legacy Terra payload -> terra-input-manifest.v1",
      exact_snapshot_match_required: true,
      preserves_market_snapshots: true,
      preserves_all_rows_and_relationships: true,
      production_wal_shm_operations: "none",
      live_dry_run_note: "SQLite may internally consult an existing WAL for a consistent read; this command never directly opens or changes sidecar files",
      apply_requires_runtime_status: "stopped"
    },
    plan: null,
    before: null,
    after: null,
    archive: null,
    migration: null,
    errors: []
  };
  if (apply && !controlledStopVerified(guard.listener, guard.sidecars)) {
    manifest.status = "refused_not_verified_cold_database";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 2 };
  }

  let tempDirectory = null;
  let tempParent = null;
  let replaced = false;
  try {
    let analysis;
    let sourceFingerprint = null;
    if (apply || (!guard.sidecars.wal_exists && !guard.sidecars.shm_exists)) {
      sourceFingerprint = fileFingerprint(databasePath);
      tempParent = apply ? path.dirname(databasePath) : os.tmpdir();
      tempDirectory = fs.mkdtempSync(path.join(tempParent, ".db-compact-"));
      const probeDatabase = path.join(tempDirectory, path.basename(databasePath));
      fs.copyFileSync(databasePath, probeDatabase, fs.constants.COPYFILE_EXCL);
      if (sha256(fs.readFileSync(probeDatabase)) !== sourceFingerprint.sha256) {
        throw new Error("Temporary analysis copy hash mismatch.");
      }
      analysis = analyzeDatabase(probeDatabase);
    } else {
      // A live WAL database can only be reported consistently through SQLite's
      // normal read path. Apply has already been rejected above and this code
      // never opens or manipulates the sidecar paths directly.
      analysis = analyzeDatabase(databasePath);
    }
    manifest.plan = analysis.plan.report;
    manifest.before = analysis.verification;
    if (!apply) {
      manifest.status = controlledStopVerified(guard.listener, guard.sidecars)
        ? "planned_cold_apply_available"
        : "planned_apply_currently_blocked";
      writeManifest(root, outputPath, manifest);
      return { manifest, manifestPath: outputPath, exitCode: 0 };
    }
    if (analysis.verification.integrity_check !== "ok" || analysis.verification.foreign_key_violations.length) {
      throw new Error("Source database failed integrity or foreign-key validation.");
    }
    if (!analysis.plan.updates.length) {
      manifest.status = "nothing_to_compact";
      writeManifest(root, outputPath, manifest);
      return { manifest, manifestPath: outputPath, exitCode: 0 };
    }
    guard = guardStillStopped(databasePath, runtimePath, isProcessAlive);
    manifest.listener = guard.listener;
    manifest.sidecars = guard.sidecars;
    if (!sameFingerprint(sourceFingerprint, fileFingerprint(databasePath))) {
      throw new Error("Source database changed after temporary analysis.");
    }
    manifest.archive = makeArchive(root, databasePath, sourceFingerprint, now);
    guardStillStopped(databasePath, runtimePath, isProcessAlive);
    if (!sameFingerprint(sourceFingerprint, fileFingerprint(databasePath))) {
      throw new Error("Source database changed after cold archive creation.");
    }

    const tempDatabase = path.join(tempDirectory, path.basename(databasePath));
    migrateTemporaryDatabase(tempDatabase, analysis.plan.updates);
    const migrated = analyzeDatabase(tempDatabase);
    const compactErrors = (() => {
      const db = new DatabaseSync(tempDatabase, { readOnly: true });
      try { return validateCompactedInputs(db, analysis.plan.updates); } finally { db.close(); }
    })();
    const verificationFailures = compareVerification(
      analysis.verification,
      migrated.verification,
      analysis.plan.updates
    );
    if (migrated.plan.report.eligible_rows !== 0) verificationFailures.push("eligible_rows_remain_after_migration");
    if (compactErrors.length) verificationFailures.push("compact_manifest_reference_validation");
    manifest.after = migrated.verification;
    manifest.migration = {
      updated_rows: analysis.plan.updates.length,
      before_size_bytes: sourceFingerprint.size_bytes,
      temporary_size_bytes: fs.statSync(tempDatabase).size,
      temporary_sha256: sha256(fs.readFileSync(tempDatabase)),
      verification_failures: verificationFailures,
      compact_manifest_errors: compactErrors,
      atomic_replace_attempts: null
    };
    if (verificationFailures.length) throw new Error(`Temporary database verification failed: ${verificationFailures.join(", ")}`);

    guard = guardStillStopped(databasePath, runtimePath, isProcessAlive);
    manifest.listener = guard.listener;
    manifest.sidecars = guard.sidecars;
    if (!sameFingerprint(sourceFingerprint, fileFingerprint(databasePath))) {
      throw new Error("Source database changed before atomic replacement.");
    }
    manifest.status = "verified_pending_atomic_replace";
    writeManifest(root, outputPath, manifest);
    manifest.migration.atomic_replace_attempts = atomicReplaceDatabase(tempDatabase, databasePath);
    replaced = true;
    const installedFingerprint = fileFingerprint(databasePath);
    if (installedFingerprint.sha256 !== manifest.migration.temporary_sha256) {
      throw new Error("Installed database hash differs from verified temporary database.");
    }
    manifest.migration.installed_size_bytes = installedFingerprint.size_bytes;
    manifest.migration.installed_sha256 = installedFingerprint.sha256;
    manifest.status = "applied";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 0 };
  } catch (error) {
    manifest.errors.push(String(error.message ?? error));
    manifest.status = replaced ? "replacement_completed_but_postcheck_failed" : "failed_safe_original_preserved";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 1 };
  } finally {
    if (tempDirectory) removeTemporaryDirectory(tempDirectory, tempParent);
  }
}

function parseArguments(argv) {
  let apply = false;
  let outputManifest;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--manifest") {
      outputManifest = argv[index += 1];
      if (!outputManifest) throw new Error("--manifest requires a path below outputs/.");
    } else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { apply, outputManifest, help: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: npm run database:compact -- [--apply] [--manifest outputs/name.json]");
      console.log("Default is dry-run. Apply requires a stopped runtime and absent database WAL/SHM sidecars.");
    } else {
      const result = runDatabaseCompaction(options);
      console.log(JSON.stringify({
        status: result.manifest.status,
        mode: result.manifest.mode,
        eligible_rows: result.manifest.plan?.eligible_rows ?? 0,
        estimated_payload_savings_bytes: result.manifest.plan?.estimated_payload_savings_bytes ?? 0,
        manifest: result.manifestPath
      }, null, 2));
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(`Database compaction failed safely: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
