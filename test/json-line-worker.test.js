import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineWorker, safeDiagnostic } from "../src/json-line-worker.js";

const ECHO_WORKER = `
const readline = require("node:readline");
process.stdout.write(JSON.stringify({event:"ready",native_core:true}) + "\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const value = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:value.id,ok:true,result:{pid:process.pid,value:value.value},recycle_requested:true}) + "\\n");
});
`;

test("JSON-line worker stays hidden, validates readiness, and recycles cleanly", async () => {
  const worker = new JsonLineWorker({
    file: process.execPath,
    args: ["-e", ECHO_WORKER],
    cwd: process.cwd(),
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    validateReady: (message) => message.native_core === true
  });
  const first = await worker.request({ value: 1 });
  const second = await worker.request({ value: 2 });
  assert.equal(first.value, 1);
  assert.equal(second.value, 2);
  assert.notEqual(first.pid, second.pid);
  await worker.close();
});

test("worker diagnostics redact OAuth material", () => {
  assert.doesNotMatch(safeDiagnostic("Bearer secret-value access_token=also-secret"), /secret-value|also-secret/);
});
