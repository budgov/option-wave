import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcileListenerRuntimeState, settleListenerWatchdogClaim } from "../src/listener-watchdog.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-listener-watchdog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config: { data: { database: path.join(root, "ocean-wave.sqlite") } },
    write(name, value) { fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`, "utf8"); }
  };
}

test("listener watchdog never restarts a live process, including a stale heartbeat", (t) => {
  const { config, write } = fixture(t);
  const runtime = {
    schema_version: "listener-runtime.v1",
    instance_id: "live-instance",
    pid: 4312,
    status: "ready",
    heartbeat_at: "2026-08-26T13:29:50.000Z",
    updated_at: "2026-08-26T13:29:50.000Z"
  };
  write("listener-runtime.json", runtime);
  write("listener-owner.lock", {
    schema_version: "listener-owner.v1", instance_id: runtime.instance_id, pid: runtime.pid
  });
  const alive = (pid) => pid === runtime.pid;
  const healthy = reconcileListenerRuntimeState(config, {
    at: new Date("2026-08-26T13:30:00.000Z"), isProcessAlive: alive
  });
  assert.equal(healthy.status, "running");
  assert.equal(healthy.restart_recommended, false);

  const stale = reconcileListenerRuntimeState(config, {
    at: new Date("2026-08-26T13:33:00.000Z"), isProcessAlive: alive
  });
  assert.equal(stale.status, "heartbeat_stale_live_process");
  assert.equal(stale.restart_recommended, false);
});

test("listener watchdog claims a bounded restart only after the managed PID is dead", (t) => {
  const { config, write } = fixture(t);
  const runtime = {
    schema_version: "listener-runtime.v1",
    instance_id: "dead-instance",
    pid: 987654,
    status: "ready",
    heartbeat_at: "2026-08-26T13:20:00.000Z",
    updated_at: "2026-08-26T13:20:00.000Z"
  };
  write("listener-runtime.json", runtime);
  write("listener-owner.lock", {
    schema_version: "listener-owner.v1", instance_id: runtime.instance_id, pid: runtime.pid
  });
  const due = reconcileListenerRuntimeState(config, {
    at: new Date("2026-08-26T13:30:00.000Z"),
    isProcessAlive: () => false,
    claimRestart: true
  });
  assert.equal(due.status, "restart_due");
  assert.equal(due.reason, "listener_process_exited");
  assert.equal(due.restart_claimed, true);
  assert.ok(due.claim_id);

  const confirmed = settleListenerWatchdogClaim(config, due.claim_id, {
    confirmed: true,
    at: new Date("2026-08-26T13:30:01.000Z")
  });
  assert.equal(confirmed.restart_attempts, 1);
  const cooldown = reconcileListenerRuntimeState(config, {
    at: new Date("2026-08-26T13:30:30.000Z"), isProcessAlive: () => false, claimRestart: true
  });
  assert.equal(cooldown.status, "restart_cooldown");
  assert.equal(cooldown.restart_recommended, false);
});

test("graceful stops, stop requests, and pause gates suppress listener recovery", (t) => {
  const { root, config, write } = fixture(t);
  write("listener-runtime.json", {
    schema_version: "listener-runtime.v1",
    instance_id: "stopped-instance",
    pid: 10,
    status: "stopped",
    stop_reason: "user_safe_stop",
    updated_at: "2026-08-26T13:20:00.000Z"
  });
  const stopped = reconcileListenerRuntimeState(config, { isProcessAlive: () => false });
  assert.equal(stopped.status, "administratively_stopped");
  assert.equal(stopped.restart_recommended, false);

  write("listener-runtime.json", {
    schema_version: "listener-runtime.v1",
    instance_id: "stopping-instance",
    pid: 11,
    status: "ready",
    updated_at: "2026-08-26T13:20:00.000Z"
  });
  write("listener-stop-request.json", {
    schema_version: "listener-stop-request.v1", target_instance_id: "stopping-instance"
  });
  const stopping = reconcileListenerRuntimeState(config, { isProcessAlive: () => false });
  assert.equal(stopping.status, "safe_stop_pending");
  assert.equal(stopping.restart_recommended, false);

  fs.rmSync(path.join(root, "listener-stop-request.json"));
  fs.writeFileSync(path.join(root, "listener-watchdog.pause"), "maintenance\n", "utf8");
  const paused = reconcileListenerRuntimeState(config, { isProcessAlive: () => false });
  assert.equal(paused.status, "watchdog_paused");
  assert.equal(paused.restart_recommended, false);
});

test("Schwab reauthorization failures are not retried and missing state is recoverable", (t) => {
  const { root, config, write } = fixture(t);
  write("listener-runtime.json", {
    schema_version: "listener-runtime.v1",
    instance_id: "failed-instance",
    pid: 12,
    status: "failed",
    error: "Schwab OAuth invalid_grant: refresh token is invalid, expired or revoked",
    updated_at: "2026-08-26T13:20:00.000Z"
  });
  const auth = reconcileListenerRuntimeState(config, { isProcessAlive: () => false, claimRestart: true });
  assert.equal(auth.status, "schwab_reauthorization_required");
  assert.equal(auth.restart_recommended, false);
  assert.equal(fs.existsSync(path.join(root, "listener-watchdog.json")), false);

  fs.rmSync(path.join(root, "listener-runtime.json"));
  const missing = reconcileListenerRuntimeState(config, {
    at: new Date("2026-08-26T13:30:00.000Z"), isProcessAlive: () => false, claimRestart: true
  });
  assert.equal(missing.status, "restart_due");
  assert.equal(missing.reason, "runtime_missing");
  assert.equal(missing.restart_claimed, true);
});

test("malformed ownership evidence fails closed", (t) => {
  const { root, config } = fixture(t);
  fs.writeFileSync(path.join(root, "listener-owner.lock"), "not-json", "utf8");
  const result = reconcileListenerRuntimeState(config, { isProcessAlive: () => false, claimRestart: true });
  assert.equal(result.status, "unsafe_control_state");
  assert.equal(result.restart_recommended, false);
});
