import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteFileSync } from "./atomic-file.js";

const MANIFEST_SCHEMA = "native-core-deployment.v1";
const MANIFEST_NAME = "native-core-deployment.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspacePath(root, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing from the deployment manifest.`);
  const filename = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isInside(root, filename)) throw new Error(`${label} must remain inside the workspace.`);
  return filename;
}

function assertNoSymlinkAncestors(root, filename, { requireFile = true } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must remain inside the workspace: ${filename}`);
  }
  let cursor = path.resolve(root);
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    if (!fs.existsSync(cursor)) {
      if (requireFile || index < parts.length - 1) throw new Error(`Required deployment path is missing: ${cursor}`);
      return;
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Deployment path crosses a symlink/reparse point: ${cursor}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Deployment parent is not a directory: ${cursor}`);
    if (index === parts.length - 1 && requireFile && !stat.isFile()) {
      throw new Error(`Deployment input is not a regular file: ${cursor}`);
    }
  }
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function processAlive(pid) {
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

function marketWorkerPids(runtimeState) {
  const pids = new Set();
  function visit(value, location) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (location.includes("market_data_worker")) {
      const pid = Number(value.pid);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") visit(child, location ? `${location}.${key}` : key);
    }
  }
  visit(runtimeState, "");
  return [...pids];
}

function assertNoLiveMarketWorker(runtime, isProcessAlive) {
  for (const pid of marketWorkerPids(runtime.previousState)) {
    if (isProcessAlive(pid)) throw new Error(`Previous market-data worker PID ${pid} is still alive; native deployment was refused.`);
  }
}

function readManifest(filename) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Native deployment manifest is not a regular file.");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Native deployment manifest is malformed: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Native deployment manifest is malformed.");
  }
  if (manifest.schema_version !== MANIFEST_SCHEMA) throw new Error("Unsupported native deployment manifest schema.");
  return manifest;
}

function writeManifest(filename, manifest) {
  if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || !fs.lstatSync(filename).isFile())) {
    throw new Error("Native deployment manifest target is not a regular file.");
  }
  const write = atomicWriteFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: false
  });
  if (write.atomic !== true) throw new Error("Native deployment manifest was not written atomically.");
}

function validateManifestPaths(config, manifest) {
  const root = fs.realpathSync(path.resolve(config.__root));
  const staged = workspacePath(root, manifest.staged_path, "staged_path");
  const target = workspacePath(root, manifest.target_path, "target_path");
  const stagedRoot = path.join(root, "work");
  const targetRoot = path.join(root, "option_wave");
  if (!isInside(stagedRoot, staged)) throw new Error("staged_path must remain below work/.");
  if (path.dirname(target) !== targetRoot) throw new Error("target_path must be directly below option_wave/.");
  if (!/^_core(?:\.[A-Za-z0-9_-]+)*\.pyd$/.test(path.basename(target))) {
    throw new Error("target_path is not a versioned Ocean-Wave native core.");
  }
  if (path.basename(staged) !== path.basename(target)) throw new Error("Staged and target native core basenames must match.");
  assertNoSymlinkAncestors(root, staged);
  assertNoSymlinkAncestors(root, target);
  return { root, staged, target };
}

function pythonValidate(config, filename, expectedSha256) {
  const root = fs.realpathSync(path.resolve(config.__root));
  const python = workspacePath(root, config.marketData?.python, "marketData.python");
  const script = path.join(root, "scripts", "validate_native_core.py");
  assertNoSymlinkAncestors(root, python);
  assertNoSymlinkAncestors(root, script);
  const result = spawnSync(python, [script, "--extension", filename, "--expected-sha256", expectedSha256], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }
  });
  if (result.error) throw new Error(`Native-core validator could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Native-core validator rejected ${path.basename(filename)}: ${(result.stderr || result.stdout || "no details").trim()}`);
  }
  let validation;
  try {
    validation = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Native-core validator returned malformed output: ${error.message}`);
  }
  if (validation.status !== "ok" || validation.sha256 !== expectedSha256) {
    throw new Error("Native-core validator did not confirm the expected artifact hash.");
  }
  return validation;
}

function deploymentManifestPath(config) {
  const root = fs.realpathSync(path.resolve(config.__root));
  const stateDirectory = workspacePath(root, config.marketData?.stateDir ?? "data/ocean-wave-state", "marketData.stateDir");
  if (!isInside(path.join(root, "data"), stateDirectory)) {
    throw new Error("Native deployment state directory must remain below data/.");
  }
  assertNoSymlinkAncestors(root, stateDirectory, { requireFile: false });
  fs.mkdirSync(stateDirectory, { recursive: true });
  return path.join(stateDirectory, MANIFEST_NAME);
}

export function deployPendingNativeCore(config, runtime, {
  validateNativeCore = (filename, expected) => pythonValidate(config, filename, expected),
  isProcessAlive = processAlive,
  atomicWrite = atomicWriteFileSync,
  now = () => new Date()
} = {}) {
  runtime?.assertOwnership?.();
  if (!runtime?.ownsInstance?.()) throw new Error("Native deployment requires verified single-instance listener ownership.");
  assertNoLiveMarketWorker(runtime, isProcessAlive);
  const manifestPath = deploymentManifestPath(config);
  const manifest = readManifest(manifestPath);
  if (!manifest || manifest.status === "deployed") return { status: manifest ? "already_deployed" : "not_pending" };
  if (manifest.status !== "pending") throw new Error(`Native deployment status ${manifest.status ?? "missing"} is not deployable.`);
  const expected = String(manifest.staged_sha256 ?? "").toLowerCase();
  const previousExpected = String(manifest.previous_target_sha256 ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(expected) || !SHA256_PATTERN.test(previousExpected)) {
    throw new Error("Native deployment manifest contains an invalid SHA-256 digest.");
  }
  const paths = validateManifestPaths(config, manifest);
  const stagedHash = sha256File(paths.staged);
  if (stagedHash !== expected) throw new Error("Staged native core hash does not match the approved manifest.");
  const targetHash = sha256File(paths.target);
  const attemptedAt = now().toISOString();
  const persistFailure = (error, rollbackStatus = null) => {
    writeManifest(manifestPath, {
      ...manifest,
      status: "pending",
      last_attempt_at: attemptedAt,
      last_error: String(error.message ?? error).slice(0, 500),
      ...(rollbackStatus ? { rollback_status: rollbackStatus } : {})
    });
  };

  if (targetHash === expected) {
    try {
      const validation = validateNativeCore(paths.target, expected);
      writeManifest(manifestPath, {
        ...manifest,
        status: "deployed",
        deployed_at: attemptedAt,
        deployed_sha256: expected,
        validation
      });
      return { status: "recovered_after_replace", sha256: expected };
    } catch (error) {
      persistFailure(error);
      throw error;
    }
  }
  if (targetHash !== previousExpected) {
    throw new Error("Installed native core hash differs from both approved old and staged versions; refusing to overwrite it.");
  }

  let replaced = false;
  const backupDirectory = path.join(path.dirname(manifestPath), "native-core-backups");
  const backup = path.join(backupDirectory, `${targetHash}-${path.basename(paths.target)}`);
  try {
    const stagedValidation = validateNativeCore(paths.staged, expected);
    runtime.assertOwnership();
    assertNoLiveMarketWorker(runtime, isProcessAlive);

    fs.mkdirSync(backupDirectory, { recursive: true });
    assertNoSymlinkAncestors(paths.root, backupDirectory, { requireFile: false });
    if (fs.existsSync(backup)) {
      assertNoSymlinkAncestors(paths.root, backup);
      if (sha256File(backup) !== targetHash) throw new Error("Existing native-core backup hash is invalid.");
    } else {
      const backupWrite = atomicWrite(backup, fs.readFileSync(paths.target), { mode: 0o600, allowCopyFallback: false });
      if (backupWrite.atomic !== true || sha256File(backup) !== targetHash) throw new Error("Could not create a verified atomic native-core backup.");
    }

    runtime.assertOwnership();
    assertNoLiveMarketWorker(runtime, isProcessAlive);
    const replacement = atomicWrite(paths.target, fs.readFileSync(paths.staged), { mode: 0o600, allowCopyFallback: false });
    if (replacement.atomic !== true) throw new Error("Native core replacement was not atomic.");
    replaced = true;
    if (sha256File(paths.target) !== expected) throw new Error("Installed native core failed its post-write hash check.");
    const installedValidation = validateNativeCore(paths.target, expected);
    writeManifest(manifestPath, {
      ...manifest,
      status: "deployed",
      deployed_at: attemptedAt,
      deployed_sha256: expected,
      previous_target_backup: path.relative(paths.root, backup).replaceAll("\\", "/"),
      validation: installedValidation,
      staged_validation: stagedValidation
    });
    return { status: "deployed", sha256: expected, backup };
  } catch (error) {
    let rollbackStatus = replaced ? "required" : "not_required";
    if (replaced) {
      try {
        const rollback = atomicWrite(paths.target, fs.readFileSync(backup), { mode: 0o600, allowCopyFallback: false });
        if (rollback.atomic !== true || sha256File(paths.target) !== targetHash) {
          throw new Error("Rollback did not restore the approved previous hash.");
        }
        rollbackStatus = "restored_previous_hash";
      } catch (rollbackError) {
        rollbackStatus = `failed: ${String(rollbackError.message ?? rollbackError).slice(0, 300)}`;
      }
    }
    try { persistFailure(error, rollbackStatus); } catch { /* Preserve and report the original deployment failure. */ }
    throw new Error(`${error.message} (rollback: ${rollbackStatus})`);
  }
}

export { deploymentManifestPath, sha256File };
