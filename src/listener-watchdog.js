import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import { isSchwabReauthorizationError } from "./schwab-oauth.js";

const CONTROL_FILES = Object.freeze({
  state: "listener-runtime.json",
  request: "listener-stop-request.json",
  owner: "listener-owner.lock",
  watchdog: "listener-watchdog.json",
  pause: "listener-watchdog.pause"
});
const ACTIVE_STATUSES = new Set(["initializing", "ready"]);
const QUIESCING_STATUSES = new Set(["draining", "stop_requested", "flushing_database"]);
const ADMINISTRATIVE_STOP_REASONS = new Set(["user_safe_stop", "maintenance", "maintenance_stop"]);

function controlPaths(config) {
  const directory = path.dirname(config.data.database);
  return Object.fromEntries(Object.entries(CONTROL_FILES).map(([key, filename]) => [key, path.join(directory, filename)]));
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

function readControl(filename, label) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file.`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or malformed: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return { value, stat };
}

function writeControl(filename, value) {
  return atomicWriteFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: true
  });
}

function pauseGate(files) {
  let stat;
  try {
    stat = fs.lstatSync(files.pause);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe_pause_gate";
  return "watchdog_paused";
}

function heartbeatAge(state, now) {
  const timestamp = Date.parse(state?.heartbeat_at ?? state?.updated_at ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

function compactAttempts(watchdog, now, windowMilliseconds) {
  const minimum = now.getTime() - windowMilliseconds;
  return (Array.isArray(watchdog?.restart_attempts) ? watchdog.restart_attempts : [])
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()) && value.getTime() >= minimum && value.getTime() <= now.getTime())
    .map((value) => value.toISOString());
}

function restartDecision(files, base, {
  now,
  claimRestart,
  maximumRestartsPerWindow,
  restartWindowMilliseconds,
  restartCooldownMilliseconds,
  claimTtlMilliseconds
}) {
  let watchdog;
  try {
    watchdog = readControl(files.watchdog, "Listener watchdog state")?.value ?? null;
  } catch (error) {
    return { status: "unsafe_watchdog_state", restart_recommended: false, reason: error.message };
  }
  const windowMilliseconds = Math.max(60_000, Number(restartWindowMilliseconds) || 15 * 60_000);
  const attempts = compactAttempts(watchdog, now, windowMilliseconds);
  const maximum = Math.max(1, Math.trunc(Number(maximumRestartsPerWindow) || 3));
  const pendingExpiry = Date.parse(watchdog?.pending_claim?.expires_at ?? "");
  const pendingActive = Number.isFinite(pendingExpiry) && pendingExpiry > now.getTime();
  const lastAttempt = attempts.length ? Date.parse(attempts.at(-1)) : Number.NaN;
  const cooldownActive = pendingActive || (Number.isFinite(lastAttempt)
    && now.getTime() - lastAttempt < Math.max(1_000, Number(restartCooldownMilliseconds) || 60_000));
  const restartRecommended = attempts.length < maximum && !cooldownActive;
  let claimId = null;
  if (restartRecommended && claimRestart) {
    claimId = crypto.randomUUID();
    writeControl(files.watchdog, {
      schema_version: "listener-watchdog.v1",
      restart_attempts: attempts,
      pending_claim: {
        id: claimId,
        reason: base.reason,
        claimed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + Math.max(10_000, Number(claimTtlMilliseconds) || 120_000)).toISOString()
      },
      last_healthy_at: watchdog?.last_healthy_at ?? null,
      updated_at: now.toISOString()
    });
  }
  return {
    ...base,
    status: restartRecommended ? "restart_due" : cooldownActive ? "restart_cooldown" : "restart_rate_limited",
    restart_recommended: restartRecommended,
    restart_claimed: restartRecommended && claimRestart,
    claim_id: claimId,
    restart_attempts_in_window: attempts.length,
    maximum_restarts_in_window: maximum,
    restart_window_seconds: Math.round(windowMilliseconds / 1_000)
  };
}

/**
 * Inspects listener ownership and heartbeat evidence without signalling or
 * terminating a process. A restart is recommended only when no managed
 * listener PID is alive and no graceful-stop or maintenance gate is active.
 */
export function reconcileListenerRuntimeState(config, {
  at = new Date(),
  isProcessAlive = processExists,
  claimRestart = false,
  heartbeatStaleMilliseconds = 120_000,
  maximumRestartsPerWindow = 3,
  restartWindowMilliseconds = 15 * 60_000,
  restartCooldownMilliseconds = 60_000,
  claimTtlMilliseconds = 120_000
} = {}) {
  const now = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid listener watchdog timestamp: ${at}`);
  const files = controlPaths(config);
  const paused = pauseGate(files);
  if (paused) return { status: paused, restart_recommended: false };

  let stateRecord;
  let ownerRecord;
  let requestRecord;
  try {
    stateRecord = readControl(files.state, "Listener runtime state");
    ownerRecord = readControl(files.owner, "Listener ownership lock");
    requestRecord = readControl(files.request, "Listener stop request");
  } catch (error) {
    return { status: "unsafe_control_state", restart_recommended: false, reason: error.message };
  }
  const state = stateRecord?.value ?? null;
  const owner = ownerRecord?.value ?? null;
  const statePid = Number(state?.pid);
  const ownerPid = Number(owner?.pid);
  const stateAlive = isProcessAlive(statePid);
  const ownerAlive = isProcessAlive(ownerPid);
  const ownerMatchesState = owner && state
    ? owner.instance_id === state.instance_id && ownerPid === statePid
    : false;

  if (ownerAlive && !ownerMatchesState) {
    return { status: "owner_alive", restart_recommended: false, pid: ownerPid };
  }
  if (stateAlive || ownerAlive) {
    if (!ACTIVE_STATUSES.has(String(state?.status))) {
      return { status: "live_process_not_ready", restart_recommended: false, pid: stateAlive ? statePid : ownerPid };
    }
    const ageMilliseconds = heartbeatAge(state, now);
    const stale = ageMilliseconds > Math.max(30_000, Number(heartbeatStaleMilliseconds) || 120_000);
    if (!stale) {
      try {
        const watchdog = readControl(files.watchdog, "Listener watchdog state")?.value;
        if (watchdog?.pending_claim) {
          writeControl(files.watchdog, {
            ...watchdog,
            pending_claim: null,
            last_healthy_at: now.toISOString(),
            updated_at: now.toISOString()
          });
        }
      } catch {
        // Health reporting must not disturb a live listener over advisory state.
      }
    }
    return {
      status: stale ? "heartbeat_stale_live_process" : "running",
      restart_recommended: false,
      pid: stateAlive ? statePid : ownerPid,
      heartbeat_age_seconds: Number.isFinite(ageMilliseconds) ? Math.round(ageMilliseconds / 1_000) : null
    };
  }

  if (owner && state && !ownerMatchesState) {
    return { status: "unsafe_owner_mismatch", restart_recommended: false };
  }
  if (requestRecord && (!state || requestRecord.value.target_instance_id === state.instance_id)) {
    return { status: "safe_stop_pending", restart_recommended: false };
  }
  if (QUIESCING_STATUSES.has(String(state?.status))) {
    return { status: "graceful_shutdown_incomplete", restart_recommended: false };
  }
  if (state?.status === "stopped" && ADMINISTRATIVE_STOP_REASONS.has(String(state.stop_reason))) {
    return { status: "administratively_stopped", restart_recommended: false, stop_reason: state.stop_reason };
  }
  if (state?.status === "failed" && isSchwabReauthorizationError(state.error)) {
    return {
      status: "schwab_reauthorization_required",
      restart_recommended: false,
      reason: "Schwab authorization must be renewed before restarting the listener"
    };
  }

  let reason;
  if (!state && !owner) reason = "runtime_missing";
  else if (ACTIVE_STATUSES.has(String(state?.status))) reason = "listener_process_exited";
  else if (["failed", "stopped"].includes(String(state?.status))) reason = `listener_${state.status}`;
  else return { status: "unknown_runtime_state", restart_recommended: false };

  return restartDecision(files, { reason }, {
    now,
    claimRestart,
    maximumRestartsPerWindow,
    restartWindowMilliseconds,
    restartCooldownMilliseconds,
    claimTtlMilliseconds
  });
}

export function settleListenerWatchdogClaim(config, claimId, {
  confirmed,
  at = new Date()
} = {}) {
  if (!claimId) throw new Error("Listener watchdog claim id is required");
  const now = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(now.getTime())) throw new Error(`Invalid listener watchdog settlement timestamp: ${at}`);
  const files = controlPaths(config);
  const watchdog = readControl(files.watchdog, "Listener watchdog state")?.value;
  if (!watchdog || watchdog.pending_claim?.id !== claimId) return { settled: false, reason: "claim_mismatch" };
  const attempts = Array.isArray(watchdog.restart_attempts) ? [...watchdog.restart_attempts] : [];
  if (confirmed) attempts.push(now.toISOString());
  writeControl(files.watchdog, {
    ...watchdog,
    restart_attempts: attempts,
    pending_claim: null,
    last_claim_id: claimId,
    last_claim_status: confirmed ? "confirmed" : "released",
    last_claim_settled_at: now.toISOString(),
    updated_at: now.toISOString()
  });
  return { settled: true, confirmed: Boolean(confirmed), restart_attempts: attempts.length };
}
