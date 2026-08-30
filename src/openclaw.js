import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

function codedError(message, code, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function retryableResponseError(error) {
  if (["OPENCLAW_INVALID_JSON", "OPENCLAW_MISSING_JSON", "OPENCLAW_INVALID_ENVELOPE", "OPENCLAW_INVALID_SCHEMA"].includes(error?.code)) return true;
  return /gateway closed|1006 abnormal closure|ECONNRESET|socket hang up/i.test(String(error?.message ?? error));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

function safeDiagnostic(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Basic\s+\S+/gi, "Basic [redacted]")
    .replace(/(?:access|refresh|bot)[_-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

async function withPromptFile(prompt, callback) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("OpenClaw prompt must be non-empty text.");
  if (Buffer.byteLength(prompt, "utf8") > 2 * 1024 * 1024) throw new Error("OpenClaw prompt exceeds the 2 MiB safety limit.");
  const filename = path.join(os.tmpdir(), `ocean-wave-prompt-${process.pid}-${crypto.randomUUID()}.txt`);
  await fs.promises.writeFile(filename, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    return await callback(filename);
  } finally {
    await fs.promises.unlink(filename).catch(() => {});
  }
}

export function openClawInvocation(configured) {
  if (process.platform === "win32" && configured === "openclaw") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA is unavailable; cannot locate OpenClaw.");
    const entry = path.join(appData, "npm", "node_modules", "openclaw", "dist", "index.js");
    if (!fs.existsSync(entry)) throw new Error(`OpenClaw entrypoint not found: ${entry}`);
    return { file: process.execPath, prefixArgs: [entry] };
  }
  if (configured.endsWith(".js")) return { file: process.execPath, prefixArgs: [configured] };
  return { file: configured, prefixArgs: [] };
}

export async function runOpenClawAgent(config, stage, prompt, sessionKey, options = {}) {
  const agent = config.openclaw.agents[stage];
  const invocation = openClawInvocation(config.openclaw.binary);
  const maxAttempts = Math.max(1, Number(config.openclaw.transientAttempts ?? 2));
  const retryDelayMs = Math.max(0, Number(config.openclaw.transientRetryDelayMs ?? 2_000));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const recoveryInstruction = attempt === 1 ? "" : [
      "",
      "The previous response could not be parsed or did not match the requested schema.",
      "Return exactly one complete JSON object matching the requested schema, with no Markdown or commentary."
    ].join("\n");
    try {
      const { stdout, stderr } = await withPromptFile(`${prompt}${recoveryInstruction}`, async (messageFile) => {
        const args = [
          "agent",
          "--agent", agent.id,
          "--model", agent.model,
          "--thinking", agent.thinking,
          "--session-key", sessionKey,
          "--message-file", messageFile,
          "--json",
          "--timeout", String(config.openclaw.timeoutSeconds)
        ];
        return await execFileAsync(invocation.file, [...invocation.prefixArgs, ...args], {
          timeout: (config.openclaw.timeoutSeconds + 30) * 1000,
          windowsHide: true,
          maxBuffer: Number(config.openclaw.maxOutputBytes ?? 8 * 1024 * 1024)
        });
      });
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (error) {
        throw codedError("OpenClaw command envelope is not valid JSON.", "OPENCLAW_INVALID_ENVELOPE", error);
      }
      const text = extractAssistantText(envelope);
      const output = parseJsonDocument(text);
      if (typeof options.validateOutput === "function") {
        const validation = options.validateOutput(output);
        if (validation !== true) {
          const detail = typeof validation === "string" && validation.trim()
            ? validation.trim()
            : `OpenClaw ${stage} output failed schema validation.`;
          throw codedError(detail, "OPENCLAW_INVALID_SCHEMA");
        }
      }
      if (stderr?.trim()) {
        const diagnostic = safeDiagnostic(stderr);
        const summary = /EMBEDDED FALLBACK/i.test(diagnostic)
          ? "OpenClaw gateway transport recovered through its embedded fallback."
          : `OpenClaw ${stage} diagnostic: ${diagnostic.slice(0, 500)}`;
        console.log(summary);
      }
      return { envelope, output, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!retryableResponseError(error) || attempt >= maxAttempts) throw error;
      console.log(`OpenClaw ${stage} returned a transient malformed response; retrying internally (${attempt + 1}/${maxAttempts}).`);
      await wait(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

export async function runOpenClawImageDescription(config, imagePath, prompt) {
  const invocation = openClawInvocation(config.openclaw.binary);
  const model = config.media?.visionModel ?? config.openclaw.agents.luna.model;
  const args = [
    "infer", "image", "describe",
    "--file", imagePath,
    "--model", model,
    "--prompt", prompt,
    "--json",
    "--timeout-ms", String((config.media?.timeoutSeconds ?? 180) * 1000)
  ];
  const { stdout, stderr } = await execFileAsync(invocation.file, [...invocation.prefixArgs, ...args], {
    timeout: ((config.media?.timeoutSeconds ?? 180) + 30) * 1000,
    windowsHide: true,
    maxBuffer: Number(config.openclaw.maxOutputBytes ?? 8 * 1024 * 1024)
  });
  if (stderr?.trim()) console.error(safeDiagnostic(stderr));
  const envelope = JSON.parse(stdout);
  const text = envelope?.outputs?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("OpenClaw image description returned no text.");
  return {
    envelope: {
      ok: envelope.ok,
      capability: envelope.capability,
      provider: envelope.provider,
      model: envelope.model
    },
    output: parseJsonDocument(text)
  };
}

export function extractAssistantText(value) {
  const candidates = [];
  const visit = (node, key = "") => {
    if (typeof node === "string" && ["text", "content", "message", "output"].includes(key)) candidates.push(node);
    else if (Array.isArray(node)) node.forEach((item) => visit(item, key));
    else if (node && typeof node === "object") Object.entries(node).forEach(([k, v]) => visit(v, k));
  };
  visit(value);
  const jsonCandidate = candidates.findLast((candidate) => {
    if (!candidate.trim().startsWith("{") && !candidate.includes("```json")) return false;
    try { parseJsonDocument(candidate); return true; } catch { return false; }
  }) ?? candidates.findLast((candidate) => candidate.trim().startsWith("{") || candidate.includes("```json"));
  if (!jsonCandidate) throw codedError("OpenClaw response did not contain assistant JSON text.", "OPENCLAW_MISSING_JSON");
  return jsonCandidate;
}

function repairMissingIsoTimestampQuotes(text) {
  // Models occasionally omit only the closing quote of a fully formed ISO-8601
  // timestamp (for example: `"quote_timestamp":"...+00:00}`). Repair that
  // narrowly defined transport defect; downstream schema validation still owns
  // all semantic decisions. Never attempt broad JSON rewriting here.
  return text.replace(
    /("(?:as_of|[A-Za-z][A-Za-z0-9_]*(?:_at|_timestamp|_time))"\s*:\s*")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=[},])/g,
    '$1$2"'
  );
}

export function parseJsonDocument(text) {
  const trimmed = repairMissingIsoTimestampQuotes(text.trim());
  let lastParseError = null;
  try { return JSON.parse(trimmed); } catch (error) { lastParseError = error; }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (error) {
      throw codedError("Assistant output is not valid JSON.", "OPENCLAW_INVALID_JSON", error);
    }
  }
  const first = trimmed.indexOf("{");
  if (first >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = first; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try { return JSON.parse(trimmed.slice(first, index + 1)); } catch (error) {
          throw codedError("Assistant output is not valid JSON.", "OPENCLAW_INVALID_JSON", error);
        }
      }
    }
  }
  throw codedError("Assistant output is not valid JSON.", "OPENCLAW_INVALID_JSON", lastParseError);
}
