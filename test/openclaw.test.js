import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractAssistantText, parseJsonDocument, runOpenClawAgent } from "../src/openclaw.js";

test("extracts JSON assistant payload from OpenClaw envelope", () => {
  const text = extractAssistantText({ result: { payloads: [{ text: "{\"schema_version\":\"luna.v1\"}" }] } });
  assert.equal(parseJsonDocument(text).schema_version, "luna.v1");
});

test("parses fenced JSON", () => {
  assert.deepEqual(parseJsonDocument("```json\n{\"ok\":true}\n```"), { ok: true });
});

test("parses the first complete JSON object when commentary follows", () => {
  assert.deepEqual(
    parseJsonDocument('{"ok":true,"nested":{"text":"a } brace"}} trailing explanation {not json}'),
    { ok: true, nested: { text: "a } brace" } }
  );
});

test("balanced malformed JSON is classified for transport retry", () => {
  for (const text of [
    '{"schema_version":"sol.v1","mean_return":0.471691010389...}',
    '```json\n{"schema_version":"sol.v1","mean_return":0.471691010389...}\n```'
  ]) {
    assert.throws(
      () => parseJsonDocument(text),
      (error) => error?.code === "OPENCLAW_INVALID_JSON" && /not valid JSON/.test(error.message)
    );
  }
});

test("repairs only a missing closing quote on complete ISO timestamps", () => {
  assert.deepEqual(
    parseJsonDocument('{"quote":{"quote_timestamp":"2026-08-25T13:44:33.045000+00:00},"captured_at":"2026-08-25T13:44:34Z}'),
    {
      quote: { quote_timestamp: "2026-08-25T13:44:33.045000+00:00" },
      captured_at: "2026-08-25T13:44:34Z"
    }
  );
  assert.throws(
    () => parseJsonDocument('{"reason":"ordinary unterminated text}'),
    /not valid JSON/
  );
});

test("assistant extraction prefers a parseable JSON payload", () => {
  const text = extractAssistantText({ result: { payloads: [
    { text: "{\"schema_version\":\"terra.v1\"}" },
    { text: "{unfinished" }
  ] } });
  assert.equal(parseJsonDocument(text).schema_version, "terra.v1");
});

test("agent prompts travel through a temporary file that is deleted after use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-openclaw-test-"));
  const fake = path.join(root, "fake-openclaw.js");
  fs.writeFileSync(fake, `
    const fs = require("node:fs");
    const index = process.argv.indexOf("--message-file");
    const filename = index >= 0 ? process.argv[index + 1] : null;
    const payload = {
      schema_version: "luna.v1",
      prompt: filename ? fs.readFileSync(filename, "utf8") : null,
      message_file: filename,
      exposed_on_command_line: process.argv.includes("--message")
    };
    console.log(JSON.stringify({ result: { payloads: [{ text: JSON.stringify(payload) }] } }));
  `, "utf8");
  try {
    const result = await runOpenClawAgent({
      openclaw: {
        binary: fake,
        timeoutSeconds: 5,
        maxOutputBytes: 1024 * 1024,
        agents: { luna: { id: "test", model: "test", thinking: "low" } }
      }
    }, "luna", "private Telegram evidence", "test-session");
    assert.equal(result.output.prompt, "private Telegram evidence");
    assert.equal(result.output.exposed_on_command_line, false);
    assert.equal(fs.existsSync(result.output.message_file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent retries a transient malformed assistant response internally", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-openclaw-retry-"));
  const fake = path.join(root, "fake-openclaw.js");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(fake, `
    const fs = require("node:fs");
    const counter = ${JSON.stringify(counter)};
    const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
    fs.writeFileSync(counter, String(attempt));
    const text = attempt === 1
      ? '{"schema_version":"terra.v1","mean_return":0.471691010389...}'
      : JSON.stringify({ schema_version: "terra.v1", status: "scored" });
    console.log(JSON.stringify({ result: { payloads: [{ text }] } }));
  `, "utf8");
  try {
    const result = await runOpenClawAgent({
      openclaw: {
        binary: fake,
        timeoutSeconds: 5,
        maxOutputBytes: 1024 * 1024,
        transientAttempts: 2,
        transientRetryDelayMs: 1,
        agents: { terra: { id: "test", model: "test", thinking: "low" } }
      }
    }, "terra", "return JSON", "retry-session");
    assert.equal(result.output.schema_version, "terra.v1");
    assert.equal(result.attempts, 2);
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent retries a parseable response that fails caller schema validation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-openclaw-schema-retry-"));
  const fake = path.join(root, "fake-openclaw.js");
  const counter = path.join(root, "counter.txt");
  fs.writeFileSync(fake, `
    const fs = require("node:fs");
    const counter = ${JSON.stringify(counter)};
    const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
    fs.writeFileSync(counter, String(attempt));
    const output = attempt === 1
      ? { schema_version: "wrong.v1", decision: "collect_more_data" }
      : { schema_version: "sol.v1", decision: "collect_more_data" };
    console.log(JSON.stringify({ result: { payloads: [{ text: JSON.stringify(output) }] } }));
  `, "utf8");
  try {
    const result = await runOpenClawAgent({
      openclaw: {
        binary: fake,
        timeoutSeconds: 5,
        maxOutputBytes: 1024 * 1024,
        transientAttempts: 2,
        transientRetryDelayMs: 1,
        agents: { sol: { id: "test", model: "test", thinking: "high" } }
      }
    }, "sol", "return JSON", "schema-retry-session", {
      validateOutput: (output) => output?.schema_version === "sol.v1" || "Expected sol.v1 output."
    });
    assert.equal(result.output.schema_version, "sol.v1");
    assert.equal(result.attempts, 2);
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
