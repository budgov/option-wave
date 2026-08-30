import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTelegramSecrets, saveTelegramSecrets } from "../src/secrets.js";

test("Windows DPAPI secret store round-trips Telegram credentials", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-wave-secret-"));
  const value = { apiId: 123, apiHash: "not-a-real-secret", session: "test-session" };
  saveTelegramSecrets(root, { ...value, ordinaryRuntimeState: { queue: 42 }, rawMessages: ["must-not-enter-secret-store"] });
  assert.deepEqual(loadTelegramSecrets(root), value);
  const ciphertext = fs.readFileSync(path.join(root, ".secrets", "telegram.dpapi"), "utf8");
  assert.equal(ciphertext.includes(value.apiHash), false);
  fs.rmSync(root, { recursive: true, force: true });
});
