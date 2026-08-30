import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { atomicWriteFileSync } from "../src/atomic-file.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const VISION_SUFFIX = ".vision.png";
const ORIGINAL_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tiff", ".img"];
const ARTIFACT_ROOTS = ["build", "work"];
const PYTHON_SCAN_SKIP = new Set([".git", ".venv", "node_modules", ".secrets", "data", "outputs"]);
const LEGACY_NORMALIZER = "scripts/normalize-image.py";
const NATIVE_DEPLOYMENT_MANIFEST = "data/ocean-wave-state/native-core-deployment.json";

function asRelative(root, filename) {
  return path.relative(root, filename).replaceAll("\\", "/");
}

function artifactKey(relative) {
  return process.platform === "win32" ? relative.toLowerCase() : relative;
}

export function assertInsideWorkspace(root, filename, label = "path") {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(filename);
  const relative = path.relative(absoluteRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of the workspace: ${absolute}`);
  }
  return absolute;
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
      throw new Error(`Refusing a path below a symlink/reparse point: ${asRelative(root, cursor)}`);
    }
  }
  return absolute;
}

function resolveWorkspaceChild(root, value, label) {
  const filename = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  return assertInsideWorkspace(root, filename, label);
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM" || error.code === "EACCES") return true;
    throw error;
  }
}

function processRecords(runtime, isProcessAlive) {
  const records = [];
  const seen = new Set();
  function visit(value, location) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (Number.isSafeInteger(Number(value.pid)) && Number(value.pid) > 0) {
      const pid = Number(value.pid);
      const key = `${location}:${pid}`;
      if (!seen.has(key)) {
        seen.add(key);
        try {
          records.push({ role: location || "listener", pid, alive: Boolean(isProcessAlive(pid)) });
        } catch (error) {
          records.push({ role: location || "listener", pid, alive: null, error: String(error.message ?? error) });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "pid") continue;
      if (child && typeof child === "object") visit(child, location ? `${location}.${key}` : key);
    }
  }
  visit(runtime, "listener");
  return records;
}

function inspectListener(runtimePath, isProcessAlive) {
  const result = {
    runtime_path: runtimePath,
    exists: fs.existsSync(runtimePath),
    status: null,
    instance_id: null,
    processes: [],
    blocking_processes: [],
    verification_error: null
  };
  if (!result.exists) {
    result.verification_error = "listener runtime is missing; offline state cannot be verified";
    return result;
  }
  try {
    if (fs.lstatSync(runtimePath).isSymbolicLink()) {
      throw new Error("listener runtime is a symlink/reparse point");
    }
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    result.status = runtime.status ?? null;
    result.instance_id = runtime.instance_id ?? null;
    result.processes = processRecords(runtime, isProcessAlive);
    result.blocking_processes = result.processes.filter((record) => record.alive !== false);
    const terminal = new Set(["stopped", "failed"]);
    if (!result.status) {
      result.verification_error = "listener runtime status is missing";
    } else if (!terminal.has(result.status) && !result.processes.some((record) => record.role === "listener")) {
      result.verification_error = `listener runtime status ${result.status} has no verifiable primary PID`;
    }
  } catch (error) {
    result.verification_error = String(error.message ?? error);
  }
  return result;
}

function blockedListener(listener) {
  return Boolean(listener.verification_error || listener.blocking_processes.length);
}

function emptyInventory() {
  return {
    files: [],
    directories: [],
    blocked: [],
    summary: { file_count: 0, bytes: 0, directory_count: 0, by_category: {} }
  };
}

function addBlocked(inventory, root, filename, category, reason) {
  inventory.blocked.push({ path: asRelative(root, filename), category, reason });
}

function addCandidate(inventory, candidateMap, root, filename, category, extra = {}) {
  const absolute = assertInsideWorkspace(root, filename, "candidate");
  assertNoSymlinkAncestors(root, absolute);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    addBlocked(inventory, root, absolute, category, "symlink_or_reparse_point");
    return;
  }
  if (!stat.isFile()) {
    addBlocked(inventory, root, absolute, category, "not_a_regular_file");
    return;
  }
  const relative = asRelative(root, absolute);
  if (!candidateMap.has(relative)) {
    candidateMap.set(relative, {
      path: relative,
      category,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      device: stat.dev,
      inode: stat.ino,
      ...extra
    });
  }
}

function addDirectory(directoryMap, root, filename, category, preserve = false) {
  const absolute = assertInsideWorkspace(root, filename, "directory candidate");
  const relative = asRelative(root, absolute);
  const current = directoryMap.get(relative);
  if (!current || (current.preserve && !preserve)) directoryMap.set(relative, { path: relative, category, preserve });
}

function findOriginal(root, derived) {
  const prefix = derived.slice(0, -VISION_SUFFIX.length);
  const possible = ORIGINAL_EXTENSIONS.includes(path.extname(prefix).toLowerCase())
    ? [prefix]
    : [prefix, ...ORIGINAL_EXTENSIONS.map((extension) => `${prefix}${extension}`)];
  for (const filename of possible) {
    if (!isInside(root, filename) || !fs.existsSync(filename)) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.size > 0) return { filename, stat };
  }
  return null;
}

function nativeDeploymentProtection(root) {
  const manifestPath = path.resolve(root, NATIVE_DEPLOYMENT_MANIFEST);
  const result = { files: new Set(), blockedRoots: new Set(), reason: null };
  if (!fs.existsSync(manifestPath)) return result;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("manifest_is_not_a_regular_file");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.schema_version !== "native-core-deployment.v1") throw new Error("unsupported_manifest_schema");
    if (manifest.status === "deployed") return result;
    if (typeof manifest.staged_path !== "string" || !manifest.staged_path.trim()) throw new Error("missing_staged_path");
    const staged = path.isAbsolute(manifest.staged_path)
      ? path.resolve(manifest.staged_path) : path.resolve(root, manifest.staged_path);
    const workRoot = path.resolve(root, "work");
    if (!isInside(workRoot, staged) || path.extname(staged).toLowerCase() !== ".pyd") {
      throw new Error("staged_path_is_outside_native_work_root");
    }
    result.files.add(artifactKey(asRelative(root, staged)));
    result.reason = "pending_native_core_deployment";
  } catch (error) {
    // If deployment evidence exists but cannot be trusted, fail closed for the
    // entire native work tree rather than deleting the only staged artifact.
    result.blockedRoots.add("work");
    result.reason = `native_deployment_manifest_unverifiable:${error.message ?? error}`;
  }
  return result;
}

function scanVisionFiles(root, inventory, candidateMap) {
  const mediaRoot = path.join(root, "data", "media");
  if (!fs.existsSync(mediaRoot)) return;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith(VISION_SUFFIX)) {
          addBlocked(inventory, root, filename, "derived_vision_png", "symlink_or_reparse_point");
        }
      } else if (entry.isDirectory()) {
        walk(filename);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(VISION_SUFFIX)) {
        const original = findOriginal(root, filename);
        if (!original) {
          addBlocked(inventory, root, filename, "derived_vision_png", "missing_nonempty_original");
          continue;
        }
        addCandidate(inventory, candidateMap, root, filename, "derived_vision_png", {
          original_path: asRelative(root, original.filename),
          original_size_bytes: original.stat.size
        });
      }
    }
  }
  const stat = fs.lstatSync(mediaRoot);
  if (stat.isSymbolicLink()) {
    addBlocked(inventory, root, mediaRoot, "derived_vision_png", "media_root_is_symlink_or_reparse_point");
    return;
  }
  walk(mediaRoot);
}

function scanArtifactRoot(root, relativeRoot, inventory, candidateMap, directoryMap, deploymentProtection) {
  const target = path.resolve(root, relativeRoot);
  if (!fs.existsSync(target)) return;
  const rootStat = fs.lstatSync(target);
  if (rootStat.isSymbolicLink()) {
    addBlocked(inventory, root, target, "build_work_artifact", "artifact_root_is_symlink_or_reparse_point");
    return;
  }
  if (!rootStat.isDirectory()) {
    addBlocked(inventory, root, target, "build_work_artifact", "artifact_root_is_not_a_directory");
    return;
  }
  addDirectory(directoryMap, root, target, "build_work_artifact", true);
  if (deploymentProtection.blockedRoots.has(relativeRoot)) {
    addBlocked(inventory, root, target, "build_work_artifact", deploymentProtection.reason);
    return;
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        addBlocked(inventory, root, filename, "build_work_artifact", "symlink_or_reparse_point");
      } else if (entry.isDirectory()) {
        walk(filename);
        addDirectory(directoryMap, root, filename, "build_work_artifact");
      } else if (entry.isFile()) {
        const relative = asRelative(root, filename);
        if (deploymentProtection.files.has(artifactKey(relative))) {
          addBlocked(inventory, root, filename, "build_work_artifact", "pending_native_core_deployment");
        } else {
          addCandidate(inventory, candidateMap, root, filename, "build_work_artifact");
        }
      } else {
        addBlocked(inventory, root, filename, "build_work_artifact", "unsupported_file_type");
      }
    }
  }
  walk(target);
}

function scanPythonCaches(root, inventory, candidateMap, directoryMap, excludedRoots) {
  function scanCache(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        addBlocked(inventory, root, filename, "python_bytecode_cache", "symlink_or_reparse_point");
      } else if (entry.isDirectory()) {
        scanCache(filename);
        addDirectory(directoryMap, root, filename, "python_bytecode_cache");
      } else if (entry.isFile() && [".pyc", ".pyo"].includes(path.extname(entry.name).toLowerCase())) {
        addCandidate(inventory, candidateMap, root, filename, "python_bytecode_cache");
      } else {
        addBlocked(inventory, root, filename, "python_bytecode_cache", "non_bytecode_file_in_cache");
      }
    }
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (PYTHON_SCAN_SKIP.has(entry.name) || excludedRoots.some((excluded) => path.resolve(filename) === excluded)) continue;
      if (entry.name === "__pycache__") {
        if (entry.isSymbolicLink()) {
          addBlocked(inventory, root, filename, "python_bytecode_cache", "cache_is_symlink_or_reparse_point");
        } else {
          scanCache(filename);
          addDirectory(directoryMap, root, filename, "python_bytecode_cache");
        }
      } else if (!entry.isSymbolicLink()) {
        walk(filename);
      }
    }
  }
  walk(root);
}

function scanInventory(root) {
  const inventory = emptyInventory();
  const candidateMap = new Map();
  const directoryMap = new Map();
  const deploymentProtection = nativeDeploymentProtection(root);
  scanVisionFiles(root, inventory, candidateMap);
  const artifactRoots = ARTIFACT_ROOTS.map((relative) => path.resolve(root, relative));
  for (const relativeRoot of ARTIFACT_ROOTS) {
    scanArtifactRoot(root, relativeRoot, inventory, candidateMap, directoryMap, deploymentProtection);
  }
  scanPythonCaches(root, inventory, candidateMap, directoryMap, artifactRoots);
  const legacy = path.resolve(root, LEGACY_NORMALIZER);
  if (fs.existsSync(legacy)) {
    addCandidate(inventory, candidateMap, root, legacy, "legacy_python_image_preprocessor", {
      replacement: "src/media.js (sharp/libvips)"
    });
  }
  inventory.files = [...candidateMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  inventory.directories = [...directoryMap.values()].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  inventory.blocked.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of inventory.files) {
    const category = inventory.summary.by_category[file.category] ?? { file_count: 0, bytes: 0 };
    category.file_count += 1;
    category.bytes += file.size_bytes;
    inventory.summary.by_category[file.category] = category;
    inventory.summary.file_count += 1;
    inventory.summary.bytes += file.size_bytes;
  }
  inventory.summary.directory_count = inventory.directories.filter((directory) => !directory.preserve).length;
  return inventory;
}

function databaseStats(databasePath) {
  const result = {
    path: databasePath,
    exists: fs.existsSync(databasePath),
    action: "statistics_only",
    file_bytes: null,
    estimated_reclaimable_payload_bytes: 0,
    redundancy: {},
    errors: [],
    note: "Logical payload estimate only; no DELETE, VACUUM, checkpoint, WAL, or SHM operation was performed."
  };
  if (!result.exists) return result;
  let db;
  try {
    const databaseStat = fs.lstatSync(databasePath);
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      throw new Error("database is not a regular workspace file");
    }
    result.file_bytes = databaseStat.size;
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY;");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const collect = (key, required, sql, reclaimable = true) => {
      if (!required.every((table) => tables.has(table))) return;
      try {
        const row = db.prepare(sql).get();
        const stat = { rows: Number(row.rows ?? 0), payload_bytes: Number(row.payload_bytes ?? 0) };
        result.redundancy[key] = stat;
        if (reclaimable) result.estimated_reclaimable_payload_bytes += stat.payload_bytes;
      } catch (error) {
        result.errors.push(`${key}: ${error.message ?? error}`);
      }
    };
    collect("superseded_raw_versions", ["raw_messages"], `
      WITH ranked AS (
        SELECT raw_text,raw_json,
          ROW_NUMBER() OVER (
            PARTITION BY telegram_chat_id,telegram_message_id
            ORDER BY version DESC,id DESC
          ) AS rank
        FROM raw_messages
      )
      SELECT COUNT(*) AS rows,
        COALESCE(SUM(LENGTH(COALESCE(raw_text,''))+LENGTH(COALESCE(raw_json,''))),0) AS payload_bytes
      FROM ranked WHERE rank>1
    `, false);
    collect("superseded_analysis_runs", ["raw_messages", "analysis_runs"], `
      WITH canonical_raw AS (
        SELECT id FROM (
          SELECT id,ROW_NUMBER() OVER (
            PARTITION BY telegram_chat_id,telegram_message_id
            ORDER BY version DESC,id DESC
          ) AS rank
          FROM raw_messages
        ) WHERE rank=1
      ), ranked AS (
        SELECT a.id,a.input_json,a.output_json,a.error_text,
          ROW_NUMBER() OVER (
            PARTITION BY a.raw_message_id,a.stage
            ORDER BY CASE WHEN a.status='ok' THEN 0 ELSE 1 END,a.id DESC
          ) AS rank,
          CASE WHEN canonical_raw.id IS NULL THEN 1 ELSE 0 END AS obsolete_raw
        FROM analysis_runs a LEFT JOIN canonical_raw ON canonical_raw.id=a.raw_message_id
      )
      SELECT COUNT(*) AS rows,
        COALESCE(SUM(LENGTH(COALESCE(input_json,''))+LENGTH(COALESCE(output_json,''))+LENGTH(COALESCE(error_text,''))),0) AS payload_bytes
      FROM ranked WHERE rank>1 OR obsolete_raw=1
    `);
    collect("duplicate_lifecycle_reviews", ["lifecycle_reviews"], `
      WITH ranked AS (
        SELECT review_json,
          ROW_NUMBER() OVER (
            PARTITION BY signal_raw_message_id,exit_raw_message_id
            ORDER BY id DESC
          ) AS rank
        FROM lifecycle_reviews
      )
      SELECT COUNT(*) AS rows,COALESCE(SUM(LENGTH(COALESCE(review_json,''))),0) AS payload_bytes
      FROM ranked WHERE rank>1
    `);
    collect("duplicate_daily_reports", ["daily_reports"], `
      WITH ranked AS (
        SELECT input_manifest_json,report_json,
          ROW_NUMBER() OVER (PARTITION BY report_date ORDER BY id DESC) AS rank
        FROM daily_reports
      )
      SELECT COUNT(*) AS rows,
        COALESCE(SUM(LENGTH(COALESCE(input_manifest_json,''))+LENGTH(COALESCE(report_json,''))),0) AS payload_bytes
      FROM ranked WHERE rank>1
    `);
    collect("legacy_full_chain_snapshots", ["market_snapshots"], `
      SELECT COUNT(*) AS rows,COALESCE(SUM(LENGTH(COALESCE(snapshot_json,''))),0) AS payload_bytes
      FROM market_snapshots WHERE json_type(snapshot_json,'$.chain') IS NOT NULL
    `, false);
  } catch (error) {
    result.errors.push(String(error.message ?? error));
  } finally {
    db?.close();
  }
  return result;
}

function manifestFilename(root, requested, now) {
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const filename = requested
    ? resolveWorkspaceChild(root, requested, "manifest")
    : path.join(root, "outputs", `maintenance-clean-${timestamp}.json`);
  const outputsRoot = path.join(root, "outputs");
  if (!isInside(outputsRoot, filename)) {
    throw new Error(`manifest must be written below ${outputsRoot}`);
  }
  assertNoSymlinkAncestors(root, filename);
  return filename;
}

function writeManifest(root, filename, manifest) {
  assertNoSymlinkAncestors(root, filename);
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) {
    throw new Error("manifest target is a symlink/reparse point");
  }
  atomicWriteFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: true
  });
}

function revalidateCandidate(root, candidate) {
  const filename = assertNoSymlinkAncestors(root, path.resolve(root, candidate.path));
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("candidate_is_not_a_regular_file");
  if (stat.size !== candidate.size_bytes || stat.mtimeMs !== candidate.mtime_ms
      || stat.dev !== candidate.device || stat.ino !== candidate.inode) {
    throw new Error("candidate_changed_since_scan");
  }
  if (candidate.category === "derived_vision_png") {
    if (!filename.toLowerCase().endsWith(VISION_SUFFIX)) throw new Error("invalid_vision_candidate_name");
    const original = path.resolve(root, candidate.original_path);
    const originalStat = fs.lstatSync(assertNoSymlinkAncestors(root, original));
    if (originalStat.isSymbolicLink() || !originalStat.isFile() || originalStat.size <= 0) {
      throw new Error("missing_nonempty_original");
    }
  } else if (candidate.category === "python_bytecode_cache") {
    const segments = candidate.path.split("/");
    if (!segments.includes("__pycache__") || ![".pyc", ".pyo"].includes(path.extname(filename).toLowerCase())) {
      throw new Error("invalid_python_cache_candidate");
    }
  } else if (candidate.category === "build_work_artifact") {
    if (!ARTIFACT_ROOTS.some((relative) => isInside(path.resolve(root, relative), filename))) {
      throw new Error("invalid_build_work_candidate");
    }
  } else if (candidate.category === "legacy_python_image_preprocessor") {
    if (path.resolve(filename) !== path.resolve(root, LEGACY_NORMALIZER)) throw new Error("invalid_legacy_candidate");
  } else {
    throw new Error("unknown_cleanup_category");
  }
  return filename;
}

function applyInventory(root, inventory, runtimePath, isProcessAlive) {
  const deleted = { files: [], bytes: 0, directories_pruned: [], errors: [] };
  let listenerAbort = null;
  const stillOffline = () => {
    const listener = inspectListener(runtimePath, isProcessAlive);
    if (blockedListener(listener)) listenerAbort = listener;
    return !listenerAbort;
  };
  for (const candidate of inventory.files) {
    if (!stillOffline()) break;
    try {
      const protection = nativeDeploymentProtection(root);
      if (protection.files.has(artifactKey(candidate.path))
          || [...protection.blockedRoots].some((blockedRoot) => isInside(path.resolve(root, blockedRoot), path.resolve(root, candidate.path)))) {
        throw new Error("pending_native_core_deployment");
      }
      const filename = revalidateCandidate(root, candidate);
      fs.unlinkSync(filename);
      deleted.files.push({ path: candidate.path, category: candidate.category, size_bytes: candidate.size_bytes });
      deleted.bytes += candidate.size_bytes;
    } catch (error) {
      deleted.errors.push({ path: candidate.path, error: String(error.message ?? error) });
    }
  }
  if (!listenerAbort) {
    for (const directory of inventory.directories) {
      if (directory.preserve) continue;
      if (!stillOffline()) break;
      try {
        const filename = assertNoSymlinkAncestors(root, path.resolve(root, directory.path));
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("directory_is_not_regular");
        fs.rmdirSync(filename);
        deleted.directories_pruned.push(directory.path);
      } catch (error) {
        if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(error.code)) {
          deleted.errors.push({ path: directory.path, error: String(error.message ?? error) });
        }
      }
    }
  }
  return { deleted, listenerAbort };
}

function baseManifest(root, apply, listener, databasePath, now) {
  return {
    schema_version: "maintenance-clean.v1",
    generated_at: now.toISOString(),
    mode: apply ? "apply" : "dry_run",
    status: "initializing",
    workspace_root: root,
    listener,
    policy: {
      offline_only: true,
      database_action: "statistics_only",
      cleanup_categories: [
        "derived_vision_png",
        "python_bytecode_cache",
        "build_work_artifact",
        "legacy_python_image_preprocessor"
      ],
      protected: [
        "data/ocean-wave.sqlite (and SQLite-managed WAL/SHM)",
        "data/ocean-wave-state",
        "pending native core staged artifact",
        "data/media original images",
        ".venv",
        "option_wave/*.pyd"
      ],
      database_path: asRelative(root, databasePath)
    },
    inventory: emptyInventory(),
    database: {
      path: databasePath,
      action: "statistics_only",
      status: "pending"
    },
    deleted: { files: [], bytes: 0, directories_pruned: [], errors: [] }
  };
}

export function runMaintenanceCleanup({
  workspaceRoot = DEFAULT_ROOT,
  apply = false,
  manifestPath,
  isProcessAlive = defaultProcessAlive,
  now = new Date()
} = {}) {
  const root = fs.realpathSync(path.resolve(workspaceRoot));
  const configPath = path.join(root, "config.json");
  let configuredDatabase = "data/ocean-wave.sqlite";
  if (fs.existsSync(configPath)) {
    if (fs.lstatSync(configPath).isSymbolicLink()) throw new Error("config.json must not be a symlink/reparse point");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    configuredDatabase = config.data?.database ?? configuredDatabase;
  }
  const databasePath = resolveWorkspaceChild(root, configuredDatabase, "database");
  const dataRoot = path.join(root, "data");
  if (!isInside(dataRoot, databasePath)) {
    throw new Error("configured database must remain below data/ and outside every cleanup root");
  }
  const databaseSegments = asRelative(root, databasePath).split("/");
  if (databaseSegments.includes("__pycache__")
      || (isInside(path.join(dataRoot, "media"), databasePath) && databasePath.toLowerCase().endsWith(VISION_SUFFIX))) {
    throw new Error("configured database overlaps a cleanup allowlist and cannot be maintained safely");
  }
  const runtimePath = path.join(path.dirname(databasePath), "listener-runtime.json");
  const outputPath = manifestFilename(root, manifestPath, now);
  const listener = inspectListener(runtimePath, isProcessAlive);
  const manifest = baseManifest(root, Boolean(apply), listener, databasePath, now);

  if (apply && blockedListener(listener)) {
    manifest.status = "refused_listener_alive_or_unverifiable";
    manifest.database.status = "skipped_listener_guard";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 2 };
  }

  manifest.inventory = scanInventory(root);
  manifest.database = databaseStats(databasePath);
  if (!apply) {
    manifest.status = "planned";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 0 };
  }

  const finalListenerCheck = inspectListener(runtimePath, isProcessAlive);
  manifest.listener = finalListenerCheck;
  if (blockedListener(finalListenerCheck)) {
    manifest.status = "refused_listener_started_during_scan";
    writeManifest(root, outputPath, manifest);
    return { manifest, manifestPath: outputPath, exitCode: 2 };
  }

  manifest.status = "approved_pending_apply";
  writeManifest(root, outputPath, manifest);
  const applied = applyInventory(root, manifest.inventory, runtimePath, isProcessAlive);
  manifest.deleted = applied.deleted;
  if (applied.listenerAbort) {
    manifest.listener = applied.listenerAbort;
    manifest.status = "partially_applied_then_listener_started";
  } else if (manifest.deleted.errors.length) {
    manifest.status = "applied_with_errors";
  } else {
    manifest.status = "applied";
  }
  writeManifest(root, outputPath, manifest);
  return {
    manifest,
    manifestPath: outputPath,
    exitCode: manifest.status === "applied" ? 0 : 1
  };
}

function parseArguments(argv) {
  let apply = false;
  let manifestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--manifest") {
      manifestPath = argv[index += 1];
      if (!manifestPath) throw new Error("--manifest requires a path below outputs/");
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { apply, manifestPath, help: false };
}

function usage() {
  return [
    "Usage: npm run maintenance:clean -- [--apply] [--manifest outputs/name.json]",
    "Default: offline inventory only (dry-run). --apply is refused while a recorded listener/worker PID is alive."
  ].join("\n");
}

export {
  blockedListener as listenerGuardBlocked,
  defaultProcessAlive,
  inspectListener as inspectListenerRuntime
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = runMaintenanceCleanup(options);
      console.log(JSON.stringify({
        status: result.manifest.status,
        mode: result.manifest.mode,
        candidate_files: result.manifest.inventory.summary.file_count,
        candidate_bytes: result.manifest.inventory.summary.bytes,
        manifest: result.manifestPath
      }, null, 2));
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(`Maintenance cleanup failed safely: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
