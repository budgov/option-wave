import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteFileSync } from "./atomic-file.js";
import { startKeepAwake } from "./keep-awake.js";
import { reconcileListenerRuntimeState, settleListenerWatchdogClaim } from "./listener-watchdog.js";
import {
  reconcileIntradayRuntimeState,
  createOfficialSessionResolver,
  requestIntradayShutdown,
  settleIntradayWatchdogClaim
} from "./intraday-runtime.js";
import { requestListenerShutdown } from "./shutdown.js";

const CONTROL_FILES = Object.freeze({
  owner: "supervisor-owner.lock",
  request: "supervisor-stop-request.json",
  state: "supervisor-runtime.json"
});
const ROLE_ARGS = Object.freeze({
  listener: ["src/cli.js", "listen"],
  intraday: ["scripts/intraday-session.js"],
  daily: ["src/cli.js", "daily", "--today-only"]
});
const TERMINAL = new Set(["stopped", "stopped_with_errors", "failed"]);

function controlPaths(config) {
  const directory = path.dirname(config.data.database);
  return Object.fromEntries(Object.entries(CONTROL_FILES).map(([key, filename]) => [key, path.join(directory, filename)]));
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

function readControl(filename, label, { strict = true } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file.`);
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return { value, stat };
  } catch (error) {
    if (!strict) return null;
    throw new Error(`${label} is unreadable or malformed: ${error.message}`);
  }
}

function writeControl(filename, value) {
  atomicWriteFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: true
  });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireOwner(files, isProcessAlive) {
  fs.mkdirSync(path.dirname(files.owner), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(files.owner, "wx", 0o600);
      const record = {
        schema_version: "ocean-wave-supervisor-owner.v1",
        instance_id: crypto.randomUUID(),
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return { descriptor, record };
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch { /* Original error is more useful. */ }
        try { fs.rmSync(files.owner, { force: true }); } catch { /* Preserve original error. */ }
      }
      if (error.code !== "EEXIST") throw error;
      const existing = readControl(files.owner, "Supervisor ownership lock");
      const pid = Number(existing?.value?.pid);
      if (!existing?.value?.instance_id || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Supervisor ownership lock is malformed; refusing unsafe recovery.");
      }
      if (isProcessAlive(pid)) throw new Error(`Ocean-Wave supervisor is already running (PID ${pid}).`);
      const current = fs.lstatSync(files.owner);
      if (!sameFile(existing.stat, current)) throw new Error("Supervisor ownership changed during stale-lock recovery.");
      fs.unlinkSync(files.owner);
    }
  }
  throw new Error("Could not acquire Ocean-Wave supervisor ownership.");
}

function clockMinute(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? fallback));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return clockMinute(fallback, "09:30");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function exchangeScheduleState(config, value = new Date(), {
  preOpenMinutes = 5,
  recoveryAfterCloseMinutes = 30,
  dailyDelayMinutes = 30
} = {}) {
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) throw new Error(`Invalid supervisor schedule timestamp: ${value}`);
  const timeZone = config.intradayResearch?.marketTimeZone ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const minuteOfDay = Number(get("hour")) * 60 + Number(get("minute"));
  const openMinute = clockMinute(config.intradayResearch?.fallbackOpenLocalTime, "09:30");
  const closeMinute = clockMinute(config.intradayResearch?.fallbackCloseLocalTime, "16:00");
  const weekday = !["Sat", "Sun"].includes(get("weekday"));
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    weekday,
    minuteOfDay,
    preOpenDue: weekday && minuteOfDay >= openMinute - preOpenMinutes && minuteOfDay < openMinute,
    recoveryDue: weekday && minuteOfDay >= openMinute && minuteOfDay <= closeMinute + recoveryAfterCloseMinutes,
    dailyDue: weekday && minuteOfDay >= closeMinute + dailyDelayMinutes
  };
}

export function applyOfficialSessionSchedule(fallback, session, value = new Date(), {
  preOpenMinutes = 5,
  recoveryAfterCloseMinutes = 30,
  dailyDelayMinutes = 30
} = {}) {
  const at = value instanceof Date ? value : new Date(value);
  if (!session || !Number.isFinite(at.getTime())) return fallback;
  if (session.isTradingDay !== true) {
    return { ...fallback, official: true, preOpenDue: false, recoveryDue: false, dailyDue: false };
  }
  const openAt = Date.parse(session.openAt ?? "");
  const closeAt = Date.parse(session.closeAt ?? "");
  if (!Number.isFinite(openAt) || !Number.isFinite(closeAt) || closeAt <= openAt) return fallback;
  const milliseconds = at.getTime();
  return {
    ...fallback,
    dateKey: session.dateKey ?? fallback.dateKey,
    official: true,
    earlyClose: session.earlyClose === true,
    openAt: new Date(openAt).toISOString(),
    closeAt: new Date(closeAt).toISOString(),
    preOpenDue: milliseconds >= openAt - preOpenMinutes * 60_000 && milliseconds < openAt,
    recoveryDue: milliseconds >= openAt && milliseconds <= closeAt + recoveryAfterCloseMinutes * 60_000,
    dailyDue: milliseconds >= closeAt + dailyDelayMinutes * 60_000
  };
}

function rotateRoleLog(root, role, maximumBytes = 5 * 1024 * 1024) {
  const directory = path.join(root, "logs", "supervisor");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${role}.log`);
  try {
    if (fs.statSync(filename).size >= maximumBytes) {
      fs.rmSync(`${filename}.1`, { force: true });
      fs.renameSync(filename, `${filename}.1`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return filename;
}

export async function spawnWindowlessNode(root, args, {
  role = "worker",
  env = process.env,
  spawnImpl = spawn
} = {}) {
  const log = rotateRoleLog(root, role);
  const descriptor = fs.openSync(log, "a", 0o600);
  let child;
  try {
    child = spawnImpl(process.execPath, args, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", descriptor, descriptor]
    });
  } finally {
    fs.closeSync(descriptor);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error").slice(0, 100),
    code: error?.code == null ? null : String(error.code).slice(0, 100),
    message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 1_000)
  };
}

function backoffDelay(failures, baseMilliseconds, maximumMilliseconds) {
  return Math.min(maximumMilliseconds, baseMilliseconds * (2 ** Math.max(0, failures - 1)));
}

export function isValidDailyReportArtifact(filename, reportDate, { maximumBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) return false;
    const report = JSON.parse(fs.readFileSync(filename, "utf8"));
    return report && typeof report === "object" && !Array.isArray(report)
      && report.schema_version === "sol.v1"
      && report.report_date === reportDate;
  } catch {
    return false;
  }
}

export function createOceanWaveSupervisor(config, dependencies = {}) {
  const files = controlPaths(config);
  const now = dependencies.now ?? (() => new Date());
  const scheduler = dependencies.scheduler ?? { setInterval, clearInterval };
  const isProcessAlive = dependencies.isProcessAlive ?? processAlive;
  const reconcileListener = dependencies.reconcileListener ?? reconcileListenerRuntimeState;
  const settleListener = dependencies.settleListener ?? settleListenerWatchdogClaim;
  const reconcileIntraday = dependencies.reconcileIntraday ?? reconcileIntradayRuntimeState;
  const settleIntraday = dependencies.settleIntraday ?? settleIntradayWatchdogClaim;
  const stopListener = dependencies.stopListener ?? requestListenerShutdown;
  const stopIntraday = dependencies.stopIntraday ?? requestIntradayShutdown;
  const keepAwake = dependencies.startKeepAwake ?? startKeepAwake;
  const sessionResolver = dependencies.sessionResolver ?? createOfficialSessionResolver(config);
  const logger = dependencies.logger ?? console;
  const launchNode = dependencies.spawnNode ?? ((args, options) => spawnWindowlessNode(config.__root, args, options));
  const pollMilliseconds = Math.max(1_000, Number(dependencies.pollMilliseconds) || 5_000);
  const childStopTimeoutMilliseconds = Math.max(1_000, Number(dependencies.childStopTimeoutMilliseconds) || 60 * 60_000);
  const managed = new Map();
  const restart = new Map(["listener", "intraday", "daily"].map((role) => [role, { failures: 0, next_at: null }]));
  const preOpenLaunchDates = new Set();
  const dailyAttempts = new Map();
  let owner = null;
  let state = null;
  let timer = null;
  let started = false;
  let closing = false;
  let closed = false;
  let tickFlight = null;
  let closeFlight = null;
  let officialSessionRetryAt = 0;
  let stopKeepAwake = () => {};
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  const pruneOldest = (collection, maximum) => {
    while (collection.size > maximum) collection.delete(collection.keys().next().value);
  };
  const pruneScheduleMemory = () => {
    pruneOldest(preOpenLaunchDates, 8);
    pruneOldest(dailyAttempts, 14);
  };

  const ownsLock = () => {
    if (!owner || closed) return false;
    try {
      const current = readControl(files.owner, "Supervisor ownership lock")?.value;
      return current?.instance_id === owner.record.instance_id && Number(current.pid) === process.pid;
    } catch {
      return false;
    }
  };

  const stateChildren = (baseState = state) => Object.fromEntries(["listener", "intraday", "daily"].map((role) => {
    const record = managed.get(role);
    const prior = baseState?.children?.[role] ?? {};
    return [role, record ? {
      ...prior,
      status: "running",
      ownership: "managed",
      pid: Number(record.child.pid),
      started_at: record.startedAt,
      context: record.context ?? null
    } : prior];
  }));

  const persist = (status = state?.status ?? "ready", details = {}, force = false) => {
    if (!ownsLock()) return false;
    pruneScheduleMemory();
    const at = now().toISOString();
    const merged = { ...state, ...details };
    const next = {
      ...merged,
      schema_version: "ocean-wave-supervisor.v1",
      instance_id: owner.record.instance_id,
      pid: process.pid,
      status,
      children: stateChildren(merged),
      restart_backoff: Object.fromEntries(restart),
      schedule: {
        ...(state?.schedule ?? {}),
        preopen_launch_dates: [...preOpenLaunchDates].slice(-8),
        daily_attempts: Object.fromEntries([...dailyAttempts].slice(-14))
      },
      updated_at: at,
      ...(force || !state?.heartbeat_at ? { heartbeat_at: at } : {})
    };
    writeControl(files.state, next);
    state = next;
    return true;
  };

  const persistDiagnostic = (kind, error) => {
    const diagnostic = {
      kind: String(kind).slice(0, 100),
      error: safeError(error),
      at: now().toISOString()
    };
    if (state) {
      state.last_background_error = diagnostic;
      state.background_error_count = Math.max(0, Number(state.background_error_count) || 0) + 1;
    }
    try {
      persist(state?.status ?? "ready", {}, true);
    } catch (persistError) {
      try {
        logger.error?.(`Ocean-Wave supervisor ${diagnostic.kind}: ${diagnostic.error.message}; state: ${safeError(persistError).message}`);
      } catch { /* Diagnostics must never terminate supervision. */ }
    }
    return diagnostic;
  };

  const runBackground = (operation, kind) => {
    Promise.resolve(operation).catch((error) => { persistDiagnostic(kind, error); });
  };

  const persistBestEffort = (kind, status = state?.status ?? "ready", details = {}, force = false) => {
    try {
      return persist(status, details, force);
    } catch (error) {
      persistDiagnostic(kind, error);
      return false;
    }
  };

  const recordFailure = (role, error = null) => {
    const current = restart.get(role);
    const failures = current.failures + 1;
    const base = role === "listener" ? 30_000 : role === "intraday" ? 5 * 60_000 : 60_000;
    const maximum = role === "listener" ? 5 * 60_000 : role === "intraday" ? 30 * 60_000 : 15 * 60_000;
    restart.set(role, {
      failures,
      next_at: new Date(now().getTime() + backoffDelay(failures, base, maximum)).toISOString(),
      last_error: error == null ? null : safeError(error)
    });
  };

  const clearFailure = (role) => restart.set(role, { failures: 0, next_at: null });
  const backoffActive = (role, at) => {
    const nextAt = Date.parse(restart.get(role)?.next_at ?? "");
    return Number.isFinite(nextAt) && at.getTime() < nextAt;
  };

  async function launch(role, { claimId = null, settleClaim = null, context = null } = {}) {
    if (closing || managed.has(role) || backoffActive(role, now())) {
      if (settleClaim && claimId) {
        try { settleClaim(config, claimId, { confirmed: false, at: now() }); } catch { /* Advisory claim release. */ }
      }
      return null;
    }
    const args = [...ROLE_ARGS[role]];
    if (role === "intraday") args.push("--config", config.__path);
    let child;
    try {
      child = await launchNode(args, {
        role,
        env: {
          ...process.env,
          OCEAN_WAVE_CONFIG: config.__path,
          OCEAN_WAVE_EXTERNAL_KEEP_AWAKE: "1"
        }
      });
      const record = {
        child,
        startedAt: now().toISOString(),
        context,
        done: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
      };
      managed.set(role, record);
      child.once("exit", (code, signal) => {
        try {
          if (managed.get(role) !== record) return;
          managed.delete(role);
          const expected = closing || (role === "intraday" && Number(code) === 0);
          if (role === "daily") {
            const dateKey = record.context?.dateKey;
            const output = dateKey ? path.join(config.__root, "outputs", `ocean-wave-daily-${dateKey}.json`) : null;
            const attempt = dailyAttempts.get(dateKey) ?? { attempts: 1, hard_failures: 0, soft_attempts: 0 };
            if (Number(code) === 0 && output && isValidDailyReportArtifact(output, dateKey)) {
              dailyAttempts.set(dateKey, { ...attempt, status: "complete", completed_at: now().toISOString(), next_at: null });
              clearFailure(role);
            } else if (Number(code) === 0) {
              const softAttempts = Math.max(0, Number(attempt.soft_attempts) || 0) + 1;
              const delay = Math.min(60 * 60_000, 15 * 60_000 * (2 ** Math.min(2, softAttempts - 1)));
              dailyAttempts.set(dateKey, {
                ...attempt,
                status: "pending_no_report",
                soft_attempts: softAttempts,
                last_exit_code: 0,
                next_at: new Date(now().getTime() + delay).toISOString()
              });
              clearFailure(role);
            } else {
              const hardFailures = Math.max(0, Number(attempt.hard_failures) || 0) + 1;
              recordFailure(role, new Error(`Daily child exited code=${code}, signal=${signal ?? "none"}`));
              dailyAttempts.set(dateKey, {
                ...attempt,
                status: hardFailures >= 3 ? "exhausted_hard_failures" : "retry_wait",
                hard_failures: hardFailures,
                last_exit_code: code,
                next_at: restart.get(role).next_at
              });
            }
          } else if (!expected) {
            recordFailure(role, new Error(`${role} child exited code=${code}, signal=${signal ?? "none"}`));
          } else if (!closing) {
            clearFailure(role);
          }
          if (!closed) persistBestEffort("child_exit_state", state?.status, {
            children: {
              ...(state?.children ?? {}),
              [role]: {
                status: expected ? "stopped" : "exited",
                ownership: "managed",
                pid: Number(child.pid),
                exited_at: now().toISOString(),
                exit_code: code,
                signal: signal ?? null,
                context
              }
            }
          }, true);
          if (!closing) queueMicrotask(() => { runBackground(tick(), "child_exit_reconcile"); });
        } catch (error) {
          persistDiagnostic("child_exit_callback", error);
        }
      });
      if (settleClaim && claimId) {
        try {
          settleClaim(config, claimId, { confirmed: true, at: now() });
        } catch (error) {
          state.last_claim_error = safeError(error);
          state.last_claim_error_at = now().toISOString();
        }
      }
      persistBestEffort("child_start_state", state?.status ?? "starting", {}, true);
      return record;
    } catch (error) {
      if (settleClaim && claimId) {
        try { settleClaim(config, claimId, { confirmed: false, at: now() }); } catch { /* Original launch error wins. */ }
      }
      recordFailure(role, error);
      persistBestEffort("child_launch_failure_state", state?.status ?? "starting", {
        last_error: safeError(error),
        last_error_at: now().toISOString()
      }, true);
      return null;
    }
  }

  async function ensureListener(at) {
    const listenerManaged = managed.has("listener");
    const result = reconcileListener(config, {
      at,
      claimRestart: !listenerManaged && !backoffActive("listener", at)
    });
    if (result.status === "running" && Number(state.listener_bootstrap_attempts) !== 0) {
      state.listener_bootstrap_attempts = 0;
      state.listener_bootstrap_last_attempt_at = null;
    }
    state.children.listener = {
      status: result.status,
      ownership: result.pid ? "external" : null,
      pid: result.pid ?? null,
      heartbeat_age_seconds: result.heartbeat_age_seconds ?? null,
      checked_at: at.toISOString()
    };
    if (listenerManaged) return;
    if (result.restart_claimed && result.claim_id) {
      await launch("listener", { claimId: result.claim_id, settleClaim: settleListener, context: { reason: result.reason } });
    } else if (Number(state.listener_bootstrap_attempts ?? 0) < 3
        && !backoffActive("listener", at)
        && ["administratively_stopped", "unknown_runtime_state"].includes(result.status)) {
      state.listener_bootstrap_attempts = Number(state.listener_bootstrap_attempts ?? 0) + 1;
      state.listener_bootstrap_last_attempt_at = at.toISOString();
      await launch("listener", {
        context: {
          reason: "supervisor_bootstrap",
          attempt: state.listener_bootstrap_attempts
        }
      });
    }
  }

  async function ensureIntraday(at, schedule) {
    if (config.intradayResearch?.enabled !== true || managed.has("intraday")) return;
    const result = reconcileIntraday(config, {
      at,
      claimRestart: schedule.recoveryDue && !backoffActive("intraday", at)
    });
    state.children.intraday = {
      status: result.status,
      ownership: result.pid ? "external" : null,
      pid: result.pid ?? null,
      heartbeat_age_seconds: result.heartbeat_age_seconds ?? null,
      session_date: result.session_date ?? schedule.dateKey,
      invalid_training_day: result.invalid_training_day === true,
      checked_at: at.toISOString()
    };
    if (schedule.preOpenDue
        && !preOpenLaunchDates.has(schedule.dateKey)
        && ["outside_recovery_window", "failed_detected"].includes(result.status)) {
      preOpenLaunchDates.add(schedule.dateKey);
      await launch("intraday", { context: { dateKey: schedule.dateKey, reason: "preopen" } });
    } else if (result.restart_claimed && result.claim_id) {
      await launch("intraday", {
        claimId: result.claim_id,
        settleClaim: settleIntraday,
        context: { dateKey: schedule.dateKey, reason: result.status }
      });
    }
  }

  async function ensureDaily(at, schedule) {
    if (!schedule.dailyDue || managed.has("daily")) return;
    const output = path.join(config.__root, "outputs", `ocean-wave-daily-${schedule.dateKey}.json`);
    if (isValidDailyReportArtifact(output, schedule.dateKey)) {
      dailyAttempts.set(schedule.dateKey, {
        status: "complete",
        attempts: 0,
        hard_failures: 0,
        soft_attempts: 0,
        completed_at: null,
        next_at: null
      });
      return;
    }
    const attempt = dailyAttempts.get(schedule.dateKey) ?? {
      status: "pending",
      attempts: 0,
      hard_failures: 0,
      soft_attempts: 0,
      next_at: null
    };
    if (attempt.status === "complete" || Number(attempt.hard_failures) >= 3) return;
    if (Number.isFinite(Date.parse(attempt.next_at ?? "")) && at.getTime() < Date.parse(attempt.next_at)) return;
    if (backoffActive("daily", at)) return;
    const next = { ...attempt, status: "running", attempts: attempt.attempts + 1, started_at: at.toISOString() };
    dailyAttempts.set(schedule.dateKey, next);
    const launched = await launch("daily", { context: { dateKey: schedule.dateKey } });
    if (!launched) {
      const hardFailures = Math.max(0, Number(next.hard_failures) || 0) + 1;
      dailyAttempts.set(schedule.dateKey, {
        ...next,
        status: hardFailures >= 3 ? "exhausted_hard_failures" : "retry_wait",
        hard_failures: hardFailures,
        next_at: restart.get("daily").next_at
      });
    }
  }

  async function performTick(at = now()) {
    if (!started || closing || closed) return status();
    const request = readControl(files.request, "Supervisor stop request", { strict: false })?.value;
    if (request?.target_instance_id === owner.record.instance_id) {
      fs.rmSync(files.request, { force: true });
      queueMicrotask(() => { runBackground(close(request.reason ?? "safe_stop"), "requested_safe_stop"); });
      return status();
    }
    let schedule = exchangeScheduleState(config, at);
    await ensureListener(at);
    if (schedule.weekday && at.getTime() >= officialSessionRetryAt) {
      try {
        const officialSession = await sessionResolver.resolve(at);
        schedule = applyOfficialSessionSchedule(schedule, officialSession, at);
        officialSessionRetryAt = 0;
      } catch (error) {
        officialSessionRetryAt = at.getTime() + 60_000;
        persistDiagnostic("official_session_fallback", error);
      }
    }
    await ensureIntraday(at, schedule);
    await ensureDaily(at, schedule);
    const heartbeatMs = Date.parse(state?.heartbeat_at ?? "");
    persist("ready", { current_exchange_date: schedule.dateKey }, !Number.isFinite(heartbeatMs) || at.getTime() - heartbeatMs >= 30_000);
    return status();
  }

  function tick(at = now()) {
    if (tickFlight) return tickFlight;
    tickFlight = performTick(at).finally(() => { tickFlight = null; });
    return tickFlight;
  }

  const signalHandlers = new Map();
  function installSignalHandlers() {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => { runBackground(close(`signal:${signal}`), "signal_safe_stop"); };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  async function start() {
    if (started) return status();
    owner = acquireOwner(files, isProcessAlive);
    const prior = readControl(files.state, "Supervisor runtime state", { strict: false })?.value;
    for (const dateKey of prior?.schedule?.preopen_launch_dates ?? []) preOpenLaunchDates.add(dateKey);
    for (const [dateKey, attempt] of Object.entries(prior?.schedule?.daily_attempts ?? {})) dailyAttempts.set(dateKey, attempt);
    fs.rmSync(files.request, { force: true });
    started = true;
    state = {
      schema_version: "ocean-wave-supervisor.v1",
      instance_id: owner.record.instance_id,
      pid: process.pid,
      status: "starting",
      started_at: now().toISOString(),
      listener_bootstrap_attempts: Math.max(0, Math.min(3, Number(prior?.listener_bootstrap_attempts) || 0)),
      listener_bootstrap_last_attempt_at: prior?.listener_bootstrap_last_attempt_at ?? null,
      children: { listener: {}, intraday: {}, daily: {} },
      schedule: {}
    };
    writeControl(files.state, state);
    try {
      const keepAwakeManagedByHost = process.env.OCEAN_WAVE_EXTERNAL_KEEP_AWAKE === "1";
      stopKeepAwake = keepAwake(config.keepAwake !== false && !keepAwakeManagedByHost, (error) => {
        if (!closed) persistBestEffort("keep_awake_callback", state?.status, { keep_awake_error: safeError(error) }, true);
      });
      installSignalHandlers();
      await tick();
      if (!closing) {
        timer = scheduler.setInterval(() => { runBackground(tick(), "interval_reconcile"); }, pollMilliseconds);
        timer.unref?.();
        persist("ready", {}, true);
      }
      return status();
    } catch (error) {
      await close("startup_failed", { error });
      throw error;
    }
  }

  async function close(reason = "safe_stop", { error = null } = {}) {
    if (closed) return { status: state?.status ?? "stopped", reason };
    if (closeFlight) return closeFlight;
    closing = true;
    const initiatingError = error;
    closeFlight = (async () => {
      if (timer != null) {
        scheduler.clearInterval(timer);
        timer = null;
      }
      if (tickFlight) {
        try { await tickFlight; } catch (caught) { error ??= caught; }
      }
      const shutdownErrors = [];
      if (error) shutdownErrors.push(error);
      persistBestEffort("shutdown_draining_state", "draining", { stop_reason: reason }, true);
      const outcomes = await Promise.allSettled([
        stopListener(config, { timeoutMilliseconds: childStopTimeoutMilliseconds }),
        stopIntraday(config, { timeoutMilliseconds: childStopTimeoutMilliseconds })
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") shutdownErrors.push(outcome.reason);
      }
      const waitForExit = async (record, maximumMilliseconds, role) => {
        let timeout;
        try {
          await Promise.race([
            record.done,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`${role} did not exit after completing its safe-stop protocol`)),
                maximumMilliseconds
              );
            })
          ]);
        } finally {
          if (timeout != null) clearTimeout(timeout);
        }
      };
      for (const [index, role] of ["listener", "intraday"].entries()) {
        const record = managed.get(role);
        if (record && outcomes[index].status === "fulfilled") {
          try { await waitForExit(record, Math.min(childStopTimeoutMilliseconds, 30_000), role); }
          catch (caught) { shutdownErrors.push(caught); }
        }
      }
      const daily = managed.get("daily");
      if (daily) {
        try { await waitForExit(daily, childStopTimeoutMilliseconds, "daily"); }
        catch (caught) { shutdownErrors.push(caught); }
      }
      const acknowledgedStop = initiatingError == null && reason !== "startup_failed";
      const finalStatus = shutdownErrors.length > 0
        ? acknowledgedStop ? "stopped_with_errors" : "failed"
        : "stopped";
      const diagnostics = shutdownErrors.map(safeError);
      persistBestEffort("shutdown_final_state", finalStatus, {
        stop_reason: reason,
        stopped_at: now().toISOString(),
        error: diagnostics[0] ?? null,
        shutdown_errors: diagnostics
      }, true);
      try { fs.rmSync(files.request, { force: true }); } catch { /* Advisory cleanup. */ }
      try { stopKeepAwake(); } catch { /* Ownership still must be released. */ }
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      signalHandlers.clear();
      const held = owner;
      owner = null;
      try { fs.closeSync(held.descriptor); } catch { /* Path identity remains authoritative. */ }
      try {
        const current = readControl(files.owner, "Supervisor ownership lock")?.value;
        if (current?.instance_id === held.record.instance_id && Number(current.pid) === process.pid) fs.rmSync(files.owner, { force: true });
      } catch { /* Final state remains available to doctor. */ }
      closed = true;
      const result = { status: finalStatus, reason, error: diagnostics[0] ?? null, errors: diagnostics, children: outcomes };
      resolveClosed(result);
      return result;
    })();
    return closeFlight;
  }

  function status() {
    return {
      started,
      closing,
      closed,
      instanceId: owner?.record?.instance_id ?? state?.instance_id ?? null,
      state: state ? structuredClone(state) : null,
      managed: Object.fromEntries([...managed].map(([role, record]) => [role, { pid: Number(record.child.pid), context: record.context }]))
    };
  }

  return { start, tick, close, status, waitUntilClosed: () => closedPromise };
}

function supervisorEvidence(config, isProcessAlive) {
  const files = controlPaths(config);
  let ownerRecord = null;
  let ownerError = null;
  let stateRecord = null;
  let stateError = null;
  try { ownerRecord = readControl(files.owner, "Supervisor ownership lock"); }
  catch (error) { ownerError = safeError(error); }
  try { stateRecord = readControl(files.state, "Supervisor runtime state"); }
  catch (error) { stateError = safeError(error); }
  const owner = ownerRecord?.value ?? null;
  const ownerPid = Number(owner?.pid);
  const ownerValid = Boolean(owner?.instance_id) && Number.isSafeInteger(ownerPid) && ownerPid > 0;
  const ownerLive = ownerValid && isProcessAlive(ownerPid);
  const record = stateRecord?.value ?? null;
  const statePid = Number(record?.pid);
  const stateValid = Boolean(record?.instance_id)
    && typeof record?.status === "string"
    && Number.isSafeInteger(statePid)
    && statePid > 0;

  if (ownerError) {
    return { status: "unsafe_owner_state", running: false, indeterminate: true, pid: null, state: record, error: ownerError };
  }
  if (ownerLive && (!stateValid || stateError
      || record.instance_id !== owner.instance_id || statePid !== ownerPid)) {
    return {
      status: "indeterminate_live_owner",
      running: true,
      indeterminate: true,
      pid: ownerPid,
      heartbeat_at: null,
      owner: { instance_id: owner.instance_id, pid: ownerPid },
      state: record,
      error: stateError
    };
  }
  if (ownerLive) {
    return {
      status: record.status,
      running: !TERMINAL.has(String(record.status)),
      indeterminate: false,
      pid: ownerPid,
      heartbeat_at: record.heartbeat_at ?? record.updated_at ?? null,
      owner: { instance_id: owner.instance_id, pid: ownerPid },
      state: record
    };
  }
  if (stateError) {
    return { status: "unsafe_runtime_state", running: false, indeterminate: true, pid: null, state: null, error: stateError };
  }
  if (!record && !owner) return { status: "not_installed", running: false, indeterminate: false, pid: null, state: null };
  if (stateValid && TERMINAL.has(String(record.status))) {
    return {
      status: record.status,
      running: false,
      indeterminate: false,
      pid: statePid,
      heartbeat_at: record.heartbeat_at ?? record.updated_at ?? null,
      state: record
    };
  }
  return {
    status: "indeterminate_runtime_ownership",
    running: false,
    indeterminate: true,
    pid: stateValid ? statePid : null,
    heartbeat_at: record?.heartbeat_at ?? record?.updated_at ?? null,
    state: record
  };
}

export function readSupervisorStatus(config, { isProcessAlive = processAlive } = {}) {
  return supervisorEvidence(config, isProcessAlive);
}

function indeterminateStopError(status) {
  const error = new Error(`Supervisor ownership is ${status}; refusing to target a process or bypass managed shutdown.`);
  error.code = "SUPERVISOR_OWNERSHIP_INDETERMINATE";
  return error;
}

export async function requestSupervisorShutdown(config, {
  timeoutMilliseconds = 60 * 60_000,
  pollMilliseconds = 250,
  isProcessAlive = processAlive,
  reason = "user_safe_stop"
} = {}) {
  const files = controlPaths(config);
  const evidence = supervisorEvidence(config, isProcessAlive);
  if (evidence.indeterminate) throw indeterminateStopError(evidence.status);
  if (!evidence.running) {
    fs.rmSync(files.request, { force: true });
    return { status: "already_stopped", previous: evidence.status === "not_installed" ? null : evidence.status };
  }
  const state = evidence.state;
  if (!state || state.instance_id !== evidence.owner?.instance_id || Number(state.pid) !== Number(evidence.owner?.pid)) {
    throw indeterminateStopError("unverified_runtime_owner");
  }
  const requestedAt = new Date().toISOString();
  writeControl(files.request, {
    schema_version: "ocean-wave-supervisor-stop-request.v1",
    target_instance_id: state.instance_id,
    requested_at: requestedAt,
    requested_by_pid: process.pid,
    reason: String(reason || "user_safe_stop").replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 128)
  });
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMilliseconds) || 60 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(pollMilliseconds) || 250)));
    const current = supervisorEvidence(config, isProcessAlive);
    if (!current.indeterminate && (!current.state
        || current.state.instance_id !== state.instance_id || TERMINAL.has(String(current.status)))) {
      fs.rmSync(files.request, { force: true });
      return { status: current.status === "not_installed" ? "stopped" : current.status, requested_at: requestedAt, stopped_at: current.state?.stopped_at ?? null };
    }
    if (current.indeterminate && current.status === "indeterminate_live_owner") continue;
    if (!current.running && current.status === "indeterminate_runtime_ownership") {
      fs.rmSync(files.request, { force: true });
      return { status: "process_exited", requested_at: requestedAt };
    }
  }
  throw new Error("Supervisor safe stop timed out; managed runtimes were left intact.");
}
