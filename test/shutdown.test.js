import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createListenerRuntime, requestListenerShutdown } from "../src/shutdown.js";

function temporaryConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-shutdown-"));
  return { data: { database: path.join(root, "listener.sqlite") } };
}

test("safe stop targets the active listener instance and waits for closure", async () => {
  const config = temporaryConfig();
  let runtime;
  let reason = null;
  runtime = createListenerRuntime(config, (nextReason) => {
    reason = nextReason;
    runtime.close("stopped", { stop_reason: nextReason });
  }, { pollMilliseconds: 20 });

  const result = await requestListenerShutdown(config, {
    timeoutMilliseconds: 2_000,
    pollMilliseconds: 20
  });
  assert.equal(result.status, "stopped");
  assert.equal(reason, "user_safe_stop");
  const state = JSON.parse(fs.readFileSync(path.join(path.dirname(config.data.database), "listener-runtime.json"), "utf8"));
  assert.equal(state.status, "stopped");
  assert.equal(fs.existsSync(path.join(path.dirname(config.data.database), "listener-stop-request.json")), false);
});

test("safe stop is idempotent when no listener is active", async () => {
  const result = await requestListenerShutdown(temporaryConfig(), { timeoutMilliseconds: 1_000 });
  assert.equal(result.status, "already_stopped");
});

test("heartbeat preserves draining state instead of restoring ready", () => {
  const config = temporaryConfig();
  const runtime = createListenerRuntime(config, () => {}, { pollMilliseconds: 10_000 });
  runtime.update("draining", { stop_reason: "test" });
  runtime.heartbeat({ heartbeat_at: "2026-08-21T20:00:00.000Z" });
  const state = JSON.parse(fs.readFileSync(path.join(path.dirname(config.data.database), "listener-runtime.json"), "utf8"));
  assert.equal(state.status, "draining");
  assert.equal(state.stop_reason, "test");
  assert.equal(state.heartbeat_at, "2026-08-21T20:00:00.000Z");
  runtime.close();
});

test("single-instance ownership refuses a second listener and releases on close", () => {
  const config = temporaryConfig();
  const directory = path.dirname(config.data.database);
  const stateFile = path.join(directory, "listener-runtime.json");
  const lockFile = path.join(directory, "listener-owner.lock");
  const first = createListenerRuntime(config, () => {}, { pollMilliseconds: 10_000 });
  assert.equal(first.ownsInstance(), true);
  assert.equal(fs.existsSync(lockFile), true);
  assert.throws(
    () => createListenerRuntime(config, () => {}, { pollMilliseconds: 10_000 }),
    /already running/
  );
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).instance_id, first.instanceId);

  first.close("stopped");
  assert.equal(fs.existsSync(lockFile), false);
  const second = createListenerRuntime(config, () => {}, { pollMilliseconds: 10_000 });
  assert.equal(second.previousState.status, "stopped");
  second.close("stopped");
});

test("a dead owner's valid stale lock is recovered but malformed evidence fails closed", () => {
  const config = temporaryConfig();
  const lockFile = path.join(path.dirname(config.data.database), "listener-owner.lock");
  fs.writeFileSync(lockFile, JSON.stringify({
    schema_version: "listener-owner.v1",
    instance_id: "dead-instance",
    pid: 12345
  }), "utf8");
  const runtime = createListenerRuntime(config, () => {}, {
    pollMilliseconds: 10_000,
    isProcessAlive: () => false
  });
  assert.equal(runtime.ownsInstance(), true);
  runtime.close();

  fs.writeFileSync(lockFile, "not-json", "utf8");
  assert.throws(
    () => createListenerRuntime(config, () => {}, { pollMilliseconds: 10_000 }),
    /unreadable or malformed/
  );
});

test("a live legacy listener without an ownership file is still refused", () => {
  const config = temporaryConfig();
  const directory = path.dirname(config.data.database);
  fs.writeFileSync(path.join(directory, "listener-runtime.json"), JSON.stringify({
    schema_version: "listener-runtime.v1",
    instance_id: "legacy-live",
    status: "ready",
    pid: 7312
  }));
  assert.throws(
    () => createListenerRuntime(config, () => {}, {
      pollMilliseconds: 10_000,
      isProcessAlive: (pid) => pid === 7312
    }),
    /legacy listener is already running/
  );
  assert.equal(fs.existsSync(path.join(directory, "listener-owner.lock")), false);
});
