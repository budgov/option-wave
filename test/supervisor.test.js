import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyOfficialSessionSchedule,
  createOceanWaveSupervisor,
  exchangeScheduleState,
  isValidDailyReportArtifact,
  readSupervisorStatus,
  requestSupervisorShutdown,
  spawnWindowlessNode
} from "../src/supervisor.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-supervisor-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, "{}\n");
  return {
    root,
    config: {
      __root: root,
      __path: configPath,
      keepAwake: false,
      data: { database: path.join(root, "data", "ocean-wave.sqlite") },
      intradayResearch: {
        enabled: true,
        marketTimeZone: "America/New_York",
        fallbackOpenLocalTime: "09:30",
        fallbackCloseLocalTime: "16:00"
      }
    }
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

function fakeScheduler() {
  return {
    setInterval() { return { unref() {} }; },
    clearInterval() {}
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function regularSessionResolver() {
  return {
    async resolve() {
      return {
        dateKey: "2026-08-31",
        isTradingDay: true,
        openAt: "2026-08-31T13:30:00.000Z",
        closeAt: "2026-08-31T20:00:00.000Z",
        earlyClose: false
      };
    }
  };
}

test("exchange schedule starts five minutes before the open and skips weekends", () => {
  const { config } = fixture();
  const preopen = exchangeScheduleState(config, new Date("2026-08-31T13:25:00.000Z"));
  assert.equal(preopen.dateKey, "2026-08-31");
  assert.equal(preopen.preOpenDue, true);
  assert.equal(preopen.recoveryDue, false);
  assert.equal(preopen.dailyDue, false);
  const closeReview = exchangeScheduleState(config, new Date("2026-08-31T20:30:00.000Z"));
  assert.equal(closeReview.dailyDue, true);
  const weekend = exchangeScheduleState(config, new Date("2026-08-30T14:00:00.000Z"));
  assert.equal(weekend.weekday, false);
  assert.equal(weekend.preOpenDue, false);
  assert.equal(weekend.recoveryDue, false);
  assert.equal(weekend.dailyDue, false);
});

test("official sessions suppress holidays and move early-close daily work", () => {
  const { config } = fixture();
  const at = new Date("2026-11-27T18:30:00.000Z");
  const fallback = exchangeScheduleState(config, at);
  const holiday = applyOfficialSessionSchedule(fallback, { dateKey: "2026-11-27", isTradingDay: false }, at);
  assert.equal(holiday.recoveryDue, false);
  assert.equal(holiday.dailyDue, false);
  const early = applyOfficialSessionSchedule(fallback, {
    dateKey: "2026-11-27",
    isTradingDay: true,
    openAt: "2026-11-27T14:30:00.000Z",
    closeAt: "2026-11-27T18:00:00.000Z",
    earlyClose: true
  }, at);
  assert.equal(early.earlyClose, true);
  assert.equal(early.dailyDue, true);
});

test("windowless launcher invokes node directly without a shell", async () => {
  const { root } = fixture();
  let invocation;
  const child = fakeChild(101);
  const launched = spawnWindowlessNode(root, ["worker.js"], {
    role: "test",
    spawnImpl(executable, args, options) {
      invocation = { executable, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });
  assert.equal(await launched, child);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, ["worker.js"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.detached, false);
});

test("daily artifact validator rejects truncated and wrong-date output", () => {
  const { root } = fixture();
  const output = path.join(root, "daily.json");
  fs.writeFileSync(output, "{truncated");
  assert.equal(isValidDailyReportArtifact(output, "2026-08-31"), false);
  fs.writeFileSync(output, JSON.stringify({ schema_version: "sol.v1", report_date: "2026-08-30" }));
  assert.equal(isValidDailyReportArtifact(output, "2026-08-31"), false);
  fs.writeFileSync(output, JSON.stringify({ schema_version: "sol.v1", report_date: "2026-08-31" }));
  assert.equal(isValidDailyReportArtifact(output, "2026-08-31"), true);
});

test("listener reconciliation precedes official-session network resolution", async () => {
  const { config } = fixture();
  const order = [];
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => {
      order.push("listener");
      return { status: "running", restart_recommended: false, pid: 150 };
    },
    sessionResolver: {
      async resolve() {
        order.push("official_session");
        return { dateKey: "2026-08-31", isTradingDay: false };
      }
    },
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  assert.deepEqual(order.slice(0, 2), ["listener", "official_session"]);
  await supervisor.close();
});

test("cached official-session failures emit one diagnostic per retry window", async () => {
  const { config } = fixture();
  let current = new Date("2026-08-31T12:00:00.000Z");
  let resolves = 0;
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => ({ status: "running", restart_recommended: false, pid: 151 }),
    sessionResolver: {
      async resolve() {
        resolves += 1;
        throw new Error("calendar temporarily unavailable");
      }
    },
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  assert.equal(resolves, 1);
  assert.equal(supervisor.status().state.background_error_count, 1);
  current = new Date(current.getTime() + 5_000);
  await supervisor.tick(current);
  assert.equal(resolves, 1);
  assert.equal(supervisor.status().state.background_error_count, 1);
  current = new Date(current.getTime() + 56_000);
  await supervisor.tick(current);
  assert.equal(resolves, 2);
  assert.equal(supervisor.status().state.background_error_count, 2);
  await supervisor.close();
});

test("supervisor claims and launches each runtime at most once", async () => {
  const { config } = fixture();
  let current = new Date("2026-08-31T13:25:00.000Z");
  let nextPid = 200;
  const launched = [];
  const settled = [];
  const children = new Map();
  let listenerChecks = 0;
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    sessionResolver: regularSessionResolver(),
    reconcileListener: () => (++listenerChecks === 1
      ? { status: "restart_due", restart_claimed: true, claim_id: "listener-claim", reason: "missing" }
      : { status: "running", restart_recommended: false, pid: 200 }),
    settleListener: (_config, claim, details) => settled.push([claim, details.confirmed]),
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    spawnNode: async (args, options) => {
      const child = fakeChild(nextPid++);
      launched.push({ args, role: options.role });
      children.set(options.role, child);
      return child;
    },
    stopListener: async () => {
      children.get("listener")?.emit("exit", 0, null);
      return { status: "stopped" };
    },
    stopIntraday: async () => {
      children.get("intraday")?.emit("exit", 0, null);
      return { status: "stopped" };
    }
  });
  await supervisor.start();
  await supervisor.tick(current);
  assert.deepEqual(launched.map((item) => item.role).sort(), ["intraday", "listener"]);
  assert.deepEqual(settled, [["listener-claim", true]]);
  assert.equal(supervisor.status().managed.listener.pid, 200);
  assert.equal(supervisor.status().managed.intraday.pid, 201);
  await supervisor.close();
});

test("listener failures use exponential backoff before another bounded claim", async () => {
  const { config } = fixture();
  let current = new Date("2026-08-30T18:00:00.000Z");
  let claimRestartSeen = [];
  let pid = 300;
  let child;
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: (_config, options) => {
      claimRestartSeen.push(options.claimRestart);
      return options.claimRestart
        ? { status: "restart_due", restart_claimed: true, claim_id: `claim-${claimRestartSeen.length}` }
        : { status: "restart_due", restart_claimed: false };
    },
    settleListener: () => {},
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    spawnNode: async () => {
      child = fakeChild(pid++);
      return child;
    },
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" }),
    childStopTimeoutMilliseconds: 10
  });
  await supervisor.start();
  child.emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 10_000);
  await supervisor.tick(current);
  assert.equal(claimRestartSeen.at(-1), false);
  current = new Date(current.getTime() + 21_000);
  await supervisor.tick(current);
  assert.equal(claimRestartSeen.at(-1), true);
  const replacement = child;
  replacement.emit("exit", 0, null);
  await nextTurn();
  await supervisor.close();
});

test("pre-init listener bootstrap retries are backoff-aware, persistent, and bounded", async () => {
  const { config } = fixture();
  let current = new Date("2026-08-30T18:00:00.000Z");
  let pid = 350;
  const children = [];
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => ({ status: "administratively_stopped", restart_recommended: false }),
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    spawnNode: async () => {
      const child = fakeChild(pid++);
      children.push(child);
      return child;
    },
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  assert.equal(children.length, 1);
  children[0].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 10_000);
  await supervisor.tick(current);
  assert.equal(children.length, 1);
  current = new Date(current.getTime() + 21_000);
  await supervisor.tick(current);
  assert.equal(children.length, 2);
  children[1].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 61_000);
  await supervisor.tick(current);
  assert.equal(children.length, 3);
  children[2].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 6 * 60_000);
  await supervisor.tick(current);
  assert.equal(children.length, 3);
  assert.equal(supervisor.status().state.listener_bootstrap_attempts, 3);
  const persisted = JSON.parse(fs.readFileSync(path.join(path.dirname(config.data.database), "supervisor-runtime.json"), "utf8"));
  assert.equal(persisted.listener_bootstrap_attempts, 3);
  await supervisor.close();
});

test("managed listener heartbeat resets bootstrap budget across repeated healthy cycles", async () => {
  const { config } = fixture();
  const current = new Date("2026-08-30T18:00:00.000Z");
  let checks = 0;
  let launches = 0;
  let child;
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => (++checks === 1
      ? { status: "administratively_stopped", restart_recommended: false }
      : { status: "running", restart_recommended: false, pid: 375 }),
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    spawnNode: async () => {
      launches += 1;
      child = fakeChild(375);
      return child;
    },
    stopListener: async () => {
      child.emit("exit", 0, null);
      return { status: "stopped" };
    },
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  for (let cycle = 0; cycle < 4; cycle += 1) await supervisor.tick(current);
  assert.equal(checks, 5);
  assert.equal(launches, 1);
  assert.equal(supervisor.status().state.listener_bootstrap_attempts, 0);
  await supervisor.close();
});

test("daily keeps exit-zero no-report work pending but caps three hard failures", async () => {
  const { config } = fixture();
  fs.mkdirSync(path.join(config.__root, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(config.__root, "outputs", "ocean-wave-daily-2026-08-31.json"), "{truncated");
  let current = new Date("2026-08-31T20:31:00.000Z");
  let pid = 400;
  const dailyChildren = [];
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    sessionResolver: regularSessionResolver(),
    reconcileListener: () => ({ status: "running", restart_recommended: false, pid: 77 }),
    reconcileIntraday: () => ({ status: "session_complete", restart_recommended: false }),
    spawnNode: async (_args, options) => {
      const child = fakeChild(pid++);
      if (options.role === "daily") dailyChildren.push(child);
      return child;
    },
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 1);
  dailyChildren[0].emit("exit", 0, null);
  await nextTurn();
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 1);
  assert.equal(supervisor.status().state.schedule.daily_attempts["2026-08-31"].status, "pending_no_report");
  current = new Date(current.getTime() + 15 * 60_000 + 1_000);
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 2);
  dailyChildren[1].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 61_000);
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 3);
  dailyChildren[2].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 121_000);
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 4);
  dailyChildren[3].emit("exit", 1, null);
  await nextTurn();
  current = new Date(current.getTime() + 901_000);
  await supervisor.tick(current);
  assert.equal(dailyChildren.length, 4);
  assert.equal(supervisor.status().state.schedule.daily_attempts["2026-08-31"].status, "exhausted_hard_failures");
  await supervisor.close();
});

test("targeted stop request drains children and leaves doctor-readable status", async () => {
  const { config } = fixture();
  const current = new Date("2026-08-30T18:00:00.000Z");
  let listener;
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => ({ status: "restart_due", restart_claimed: true, claim_id: "start" }),
    settleListener: () => {},
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    spawnNode: async () => {
      listener = fakeChild(500);
      return listener;
    },
    stopListener: async () => {
      listener.emit("exit", 0, null);
      return { status: "stopped" };
    },
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  const requested = requestSupervisorShutdown(config, {
    timeoutMilliseconds: 2_000,
    pollMilliseconds: 10,
    isProcessAlive: () => true,
    reason: "system_shutdown"
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await supervisor.tick(current);
  const result = await requested;
  assert.equal(result.status, "stopped");
  const status = readSupervisorStatus(config, { isProcessAlive: () => false });
  assert.equal(status.status, "stopped");
  assert.equal(status.running, false);
  assert.equal(status.state.stop_reason, "system_shutdown");
});

test("live owner with missing or malformed state is indeterminate and never targeted", async () => {
  const { config } = fixture();
  const dataRoot = path.dirname(config.data.database);
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "supervisor-owner.lock"), JSON.stringify({
    schema_version: "ocean-wave-supervisor-owner.v1",
    instance_id: "live-owner",
    pid: 901,
    acquired_at: new Date().toISOString()
  }));
  const inspected = [];
  const isProcessAlive = (pid) => {
    inspected.push(pid);
    return pid === 901;
  };
  let status = readSupervisorStatus(config, { isProcessAlive });
  assert.equal(status.status, "indeterminate_live_owner");
  assert.equal(status.running, true);
  assert.equal(status.indeterminate, true);
  await assert.rejects(
    requestSupervisorShutdown(config, { isProcessAlive, timeoutMilliseconds: 1_000 }),
    (error) => error.code === "SUPERVISOR_OWNERSHIP_INDETERMINATE"
  );
  assert.equal(fs.existsSync(path.join(dataRoot, "supervisor-stop-request.json")), false);
  fs.writeFileSync(path.join(dataRoot, "supervisor-runtime.json"), "{malformed");
  status = readSupervisorStatus(config, { isProcessAlive });
  assert.equal(status.status, "indeterminate_live_owner");
  assert.deepEqual(new Set(inspected), new Set([901]));
});

test("acknowledged shutdown persists child errors without requesting scheduler restart", async () => {
  const { config } = fixture();
  const current = new Date("2026-08-30T18:00:00.000Z");
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => current,
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => ({ status: "running", restart_recommended: false, pid: 902 }),
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => { throw new Error("listener stop evidence unavailable"); },
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  const outcome = await supervisor.close("user_safe_stop");
  assert.equal(outcome.status, "stopped_with_errors");
  assert.match(outcome.error.message, /listener stop evidence unavailable/);
  const status = readSupervisorStatus(config, { isProcessAlive: () => false });
  assert.equal(status.status, "stopped_with_errors");
  assert.equal(status.indeterminate, false);
  assert.equal(status.state.shutdown_errors.length, 1);
});

test("startup failure remains a failed terminal outcome", async () => {
  const { config } = fixture();
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => new Date("2026-08-30T18:00:00.000Z"),
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => { throw new Error("startup reconciliation failed"); },
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await assert.rejects(supervisor.start(), /startup reconciliation failed/);
  const status = readSupervisorStatus(config, { isProcessAlive: () => false });
  assert.equal(status.status, "failed");
  assert.equal(status.state.stop_reason, "startup_failed");
});

test("restored schedule memory is pruned to fixed bounds", async () => {
  const { config } = fixture();
  const dataRoot = path.dirname(config.data.database);
  fs.mkdirSync(dataRoot, { recursive: true });
  const daily = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`old-${index}`, { attempts: index }]));
  fs.writeFileSync(path.join(dataRoot, "supervisor-runtime.json"), JSON.stringify({
    schema_version: "ocean-wave-supervisor.v1",
    instance_id: "old",
    pid: 1,
    status: "stopped",
    schedule: {
      preopen_launch_dates: Array.from({ length: 20 }, (_, index) => `old-${index}`),
      daily_attempts: daily
    }
  }));
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => new Date("2026-08-30T18:00:00.000Z"),
    scheduler: fakeScheduler(),
    startKeepAwake: () => () => {},
    reconcileListener: () => ({ status: "running", restart_recommended: false, pid: 903 }),
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  const schedule = supervisor.status().state.schedule;
  assert.equal(schedule.preopen_launch_dates.length, 8);
  assert.equal(Object.keys(schedule.daily_attempts).length, 14);
  await supervisor.close();
});

test("background interval reconciliation errors are contained and audited", async () => {
  const { config } = fixture();
  let intervalCallback;
  let checks = 0;
  const scheduler = {
    setInterval(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearInterval() {}
  };
  const supervisor = createOceanWaveSupervisor(config, {
    now: () => new Date("2026-08-30T18:00:00.000Z"),
    scheduler,
    startKeepAwake: () => () => {},
    reconcileListener: () => {
      checks += 1;
      if (checks > 1) throw new Error("transient reconcile failure");
      return { status: "running", restart_recommended: false, pid: 904 };
    },
    reconcileIntraday: () => ({ status: "outside_recovery_window", restart_recommended: false }),
    stopListener: async () => ({ status: "already_stopped" }),
    stopIntraday: async () => ({ status: "already_stopped" })
  });
  await supervisor.start();
  assert.doesNotThrow(() => intervalCallback());
  await nextTurn();
  assert.equal(supervisor.status().state.last_background_error.kind, "interval_reconcile");
  assert.match(supervisor.status().state.last_background_error.error.message, /transient reconcile failure/);
  await supervisor.close();
});
