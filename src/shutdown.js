import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";

const STATE_FILE = "listener-runtime.json";
const REQUEST_FILE = "listener-stop-request.json";
const OWNERSHIP_FILE = "listener-owner.lock";

function controlPaths(config) {
  const directory = path.dirname(config.data.database);
  return {
    state: path.join(directory, STATE_FILE),
    request: path.join(directory, REQUEST_FILE),
    ownership: path.join(directory, OWNERSHIP_FILE)
  };
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function atomicWriteJson(filename, value) {
  return atomicWriteFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: true
  });
}

function removeFile(filename) {
  fs.rmSync(filename, { force: true });
}

function processExists(pid) {
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

function readControlJsonStrict(filename, label) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular control file.`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or malformed: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return { value, stat };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireOwnership(files, instanceId, isProcessAlive) {
  fs.mkdirSync(path.dirname(files.ownership), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(files.ownership, "wx", 0o600);
      const ownership = {
        schema_version: "listener-owner.v1",
        instance_id: instanceId,
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(ownership)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return { descriptor, ownership };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Best-effort cleanup after a failed exclusive create. */ }
        try { fs.rmSync(files.ownership, { force: true }); } catch { /* The original failure is more useful. */ }
      }
      if (error.code !== "EEXIST") throw error;
      const existing = readControlJsonStrict(files.ownership, "Listener ownership lock");
      if (!existing) continue;
      const pid = Number(existing.value.pid);
      if (!existing.value.instance_id || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Listener ownership lock is malformed; refusing to guess whether another listener is active.");
      }
      if (isProcessAlive(pid)) {
        throw new Error(`Listener is already running (PID ${pid}, instance ${existing.value.instance_id}).`);
      }
      const current = fs.lstatSync(files.ownership);
      if (!sameFile(existing.stat, current)) {
        throw new Error("Listener ownership changed while checking a stale lock; retry the normal start.");
      }
      fs.unlinkSync(files.ownership);
    }
  }
  throw new Error("Could not acquire listener ownership after bounded stale-lock recovery.");
}

export function createListenerRuntime(config, onStop, {
  pollMilliseconds = 250,
  isProcessAlive = processExists
} = {}) {
  const files = controlPaths(config);
  const instanceId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let closed = false;
  let ownershipHandle = acquireOwnership(files, instanceId, isProcessAlive);
  let previousState;
  let state = {
    schema_version: "listener-runtime.v1",
    instance_id: instanceId,
    pid: process.pid,
    started_at: startedAt,
    updated_at: startedAt,
    status: "initializing"
  };

  const ownershipMatches = () => {
    if (closed || !ownershipHandle) return false;
    try {
      const lock = readControlJsonStrict(files.ownership, "Listener ownership lock")?.value;
      const currentState = readControlJsonStrict(files.state, "Listener runtime state")?.value;
      return lock?.instance_id === instanceId && Number(lock.pid) === process.pid
        && currentState?.instance_id === instanceId;
    } catch {
      return false;
    }
  };

  const releaseOwnership = () => {
    if (!ownershipHandle) return;
    const handle = ownershipHandle;
    ownershipHandle = null;
    try { fs.closeSync(handle.descriptor); } catch { /* The lock path check below remains fail-closed. */ }
    try {
      const current = readControlJsonStrict(files.ownership, "Listener ownership lock")?.value;
      if (current?.instance_id === instanceId && Number(current.pid) === process.pid) removeFile(files.ownership);
    } catch (error) {
      console.error(`Listener ownership cleanup failed: ${error.message}`);
    }
  };

  try {
    const prior = readControlJsonStrict(files.state, "Listener runtime state");
    previousState = prior?.value ?? null;
    const priorPid = Number(previousState?.pid);
    if (previousState && !["stopped", "failed"].includes(previousState.status)
        && Number.isSafeInteger(priorPid) && priorPid > 0 && isProcessAlive(priorPid)) {
      throw new Error(`A legacy listener is already running (PID ${priorPid}, instance ${previousState.instance_id ?? "unknown"}).`);
    }
    // A request is valid only for the listener instance ID it names. Removing
    // an older request prevents a previous crash from stopping a fresh process.
    removeFile(files.request);
    atomicWriteJson(files.state, state);
  } catch (error) {
    releaseOwnership();
    throw error;
  }

  const persistOwnedState = (nextState) => {
    if (!ownershipMatches()) return false;
    atomicWriteJson(files.state, nextState);
    state = nextState;
    return true;
  };

  const update = (status, details = {}) => {
    if (closed) return;
    const nextState = { ...state, ...details, status, updated_at: new Date().toISOString() };
    try {
      persistOwnedState(nextState);
    } catch (error) {
      console.error(`Listener runtime state update failed after bounded retries: ${error.message}`);
    }
  };

  const heartbeat = (details = {}) => {
    if (closed) return;
    const nextState = { ...state, ...details, updated_at: new Date().toISOString() };
    try {
      persistOwnedState(nextState);
    } catch (error) {
      console.error(`Listener heartbeat state update failed after bounded retries: ${error.message}`);
    }
  };

  const removeOwnRequest = () => {
    const request = readJson(files.request);
    if (!request || request.target_instance_id === instanceId) removeFile(files.request);
  };

  const timer = setInterval(() => {
    try {
      const request = readJson(files.request);
      if (!request || request.target_instance_id !== instanceId) return;
      removeFile(files.request);
      update("stop_requested", { stop_reason: request.reason ?? "safe_stop" });
      onStop(request.reason ?? "safe_stop");
    } catch (error) {
      // A temporarily locked control file is retried on the next interval.
      console.error(`Safe-stop control error: ${error.message}`);
    }
  }, Math.max(100, Number(pollMilliseconds) || 250));
  timer.unref();

  return {
    instanceId,
    previousState,
    ownsInstance: ownershipMatches,
    assertOwnership() {
      if (!ownershipMatches()) throw new Error("Listener no longer owns the single-instance runtime lock.");
      return true;
    },
    update,
    heartbeat,
    close(status = "stopped", details = {}) {
      if (closed) return;
      clearInterval(timer);
      const nextState = {
        ...state,
        ...details,
        status,
        stopped_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      try {
        persistOwnedState(nextState);
      } catch (error) {
        // Database/workers may already be closed cleanly. A locked advisory
        // status file must not turn that completed shutdown into a crash.
        console.error(`Listener final runtime state write failed after bounded retries: ${error.message}`);
      }
      try {
        removeOwnRequest();
      } catch (error) {
        console.error(`Listener stop-request cleanup failed: ${error.message}`);
      }
      closed = true;
      releaseOwnership();
    }
  };
}

export async function requestListenerShutdown(config, {
  timeoutMilliseconds = 60 * 60_000,
  pollMilliseconds = 250
} = {}) {
  const files = controlPaths(config);
  const state = readJson(files.state);
  if (!state || ["stopped", "failed"].includes(state.status) || !processExists(Number(state.pid))) {
    removeFile(files.request);
    return { status: "already_stopped", previous: state?.status ?? null };
  }

  const requestedAt = new Date().toISOString();
  atomicWriteJson(files.request, {
    schema_version: "listener-stop-request.v1",
    target_instance_id: state.instance_id,
    requested_at: requestedAt,
    requested_by_pid: process.pid,
    reason: "user_safe_stop"
  });

  const deadline = Date.now() + Math.max(1_000, Number(timeoutMilliseconds) || 10 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(pollMilliseconds) || 250)));
    const current = readJson(files.state);
    if (!current || current.instance_id !== state.instance_id || ["stopped", "failed"].includes(current.status)) {
      removeFile(files.request);
      return {
        status: current?.status === "failed" ? "failed" : "stopped",
        requested_at: requestedAt,
        stopped_at: current?.stopped_at ?? null
      };
    }
    if (!processExists(Number(current.pid))) {
      removeFile(files.request);
      return { status: "process_exited", requested_at: requestedAt };
    }
  }

  throw new Error("Safe stop timed out. The listener was left running so active database work was not interrupted.");
}
