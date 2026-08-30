import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deployPendingNativeCore } from "../src/native-core-deployment.js";

function digest(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-native-deploy-"));
  const stagedRelative = "work/refactor-build/lib/option_wave/_core.cp312-win_amd64.pyd";
  const targetRelative = "option_wave/_core.cp312-win_amd64.pyd";
  const manifest = path.join(root, "data", "ocean-wave-state", "native-core-deployment.json");
  const staged = path.join(root, ...stagedRelative.split("/"));
  const target = path.join(root, ...targetRelative.split("/"));
  const oldCore = Buffer.from("approved old native core");
  const newCore = Buffer.from("verified staged native core");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(staged, newCore);
  fs.writeFileSync(target, oldCore);
  fs.writeFileSync(manifest, JSON.stringify({
    schema_version: "native-core-deployment.v1",
    status: "pending",
    staged_path: stagedRelative,
    target_path: targetRelative,
    staged_sha256: digest(newCore),
    previous_target_sha256: digest(oldCore)
  }));
  const runtime = {
    previousState: { status: "stopped", market_data_worker: { pid: 41 } },
    assertOwnership() { return true; },
    ownsInstance() { return true; }
  };
  return {
    root, staged, target, manifest, oldCore, newCore, runtime,
    config: { __root: root, marketData: { stateDir: "data/ocean-wave-state" } }
  };
}

function validation(_filename, expected) {
  return { status: "ok", sha256: expected, parity: "bit_exact" };
}

test("native deployment requires ownership and no live prior market worker", () => {
  const item = fixture();
  const noOwner = { ...item.runtime, ownsInstance: () => false };
  assert.throws(
    () => deployPendingNativeCore(item.config, noOwner, { validateNativeCore: validation }),
    /requires verified single-instance/
  );
  assert.deepEqual(fs.readFileSync(item.target), item.oldCore);

  assert.throws(
    () => deployPendingNativeCore(item.config, item.runtime, {
      validateNativeCore: validation,
      isProcessAlive: (pid) => pid === 41
    }),
    /market-data worker PID 41 is still alive/
  );
  assert.deepEqual(fs.readFileSync(item.target), item.oldCore);
});

test("approved staged core deploys atomically with verified backup and hashes", () => {
  const item = fixture();
  const result = deployPendingNativeCore(item.config, item.runtime, {
    validateNativeCore: validation,
    isProcessAlive: () => false,
    now: () => new Date("2026-08-21T22:00:00.000Z")
  });
  assert.equal(result.status, "deployed");
  assert.deepEqual(fs.readFileSync(item.target), item.newCore);
  assert.deepEqual(fs.readFileSync(result.backup), item.oldCore);
  const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8"));
  assert.equal(manifest.status, "deployed");
  assert.equal(manifest.deployed_sha256, digest(item.newCore));
  assert.equal(manifest.validation.parity, "bit_exact");
});

test("post-install validation failure rolls back and leaves artifact pending", () => {
  const item = fixture();
  assert.throws(
    () => deployPendingNativeCore(item.config, item.runtime, {
      validateNativeCore: (filename, expected) => {
        if (path.resolve(filename) === path.resolve(item.target)) throw new Error("post-install ABI failure");
        return validation(filename, expected);
      },
      isProcessAlive: () => false
    }),
    /post-install ABI failure.*restored_previous_hash/
  );
  assert.deepEqual(fs.readFileSync(item.target), item.oldCore);
  const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8"));
  assert.equal(manifest.status, "pending");
  assert.equal(manifest.rollback_status, "restored_previous_hash");
});

test("hash mismatch refuses replacement before validation", () => {
  const item = fixture();
  fs.appendFileSync(item.staged, "tampered");
  let validations = 0;
  assert.throws(
    () => deployPendingNativeCore(item.config, item.runtime, {
      validateNativeCore: () => { validations += 1; },
      isProcessAlive: () => false
    }),
    /hash does not match/
  );
  assert.equal(validations, 0);
  assert.deepEqual(fs.readFileSync(item.target), item.oldCore);
});

test("a completed atomic replace is recovered by validation if the manifest write was interrupted", () => {
  const item = fixture();
  fs.writeFileSync(item.target, item.newCore);
  const result = deployPendingNativeCore(item.config, item.runtime, {
    validateNativeCore: validation,
    isProcessAlive: () => false
  });
  assert.equal(result.status, "recovered_after_replace");
  assert.equal(JSON.parse(fs.readFileSync(item.manifest, "utf8")).status, "deployed");
  assert.deepEqual(fs.readFileSync(item.target), item.newCore);
});
