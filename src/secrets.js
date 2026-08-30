import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./atomic-file.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DPAPI_SCRIPT = path.resolve(MODULE_DIR, "../scripts/dpapi.ps1");
const SECRET_NAMES = new Set(["telegram", "schwab", "notifier"]);

function boundedSecretRecord(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => source?.[field] !== undefined)
    .map((field) => [field, source[field]]));
}

function requireSecretName(name) {
  if (!SECRET_NAMES.has(name)) throw new Error(`Unsupported secret record: ${name}`);
  return name;
}

function runDpapi(operation, input) {
  if (process.platform !== "win32") throw new Error("This secret store requires Windows DPAPI.");
  if (!fs.existsSync(DPAPI_SCRIPT)) throw new Error(`DPAPI helper is missing: ${DPAPI_SCRIPT}`);
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", DPAPI_SCRIPT, operation
  ], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || "unknown DPAPI error").replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`DPAPI operation failed: ${diagnostic}`);
  }
  return result.stdout;
}

function secretPath(root, name) {
  return path.join(root, ".secrets", `${requireSecretName(name)}.dpapi`);
}

function saveSecret(root, name, value) {
  const filename = secretPath(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const cipher = runDpapi("protect", JSON.stringify(value));
  // Secrets never use the non-atomic copy fallback.
  atomicWriteFileSync(filename, cipher, { encoding: "utf8", mode: 0o600 });
}

function loadSecret(root, name, missingLabel) {
  const filename = secretPath(root, name);
  if (!fs.existsSync(filename)) throw new Error(`Missing encrypted ${missingLabel}: ${filename}`);
  const plain = runDpapi("unprotect", fs.readFileSync(filename, "utf8"));
  return JSON.parse(plain);
}

export function saveTelegramSecrets(root, secrets) {
  saveSecret(root, "telegram", boundedSecretRecord(secrets, ["apiId", "apiHash", "session"]));
}

export function loadTelegramSecrets(root) {
  return loadSecret(root, "telegram", "Telegram session");
}

export function hasTelegramSecrets(root) {
  return fs.existsSync(secretPath(root, "telegram"));
}

export function saveSchwabSecrets(root, secrets) {
  if (!secrets?.appKey) throw new Error("Missing Schwab app key.");
  if (!secrets?.appSecret) throw new Error("Missing Schwab app secret.");
  if (!secrets?.callbackUrl) throw new Error("Missing Schwab callback URL.");
  saveSecret(root, "schwab", boundedSecretRecord(secrets, [
    "appKey", "appSecret", "callbackUrl", "accessToken", "refreshToken",
    "tokenType", "scope", "tokenScope", "tokenUpdatedAt", "refreshTokenIssuedAt",
    "accessTokenExpiresAt", "refreshTokenExpiresAt"
  ]));
}

export function loadSchwabSecrets(root) {
  return loadSecret(root, "schwab", "Schwab credentials");
}

export function hasSchwabSecrets(root) {
  return fs.existsSync(secretPath(root, "schwab"));
}

export function saveNotifierSecrets(root, secrets) {
  if (!secrets?.telegramBotToken) throw new Error("Missing Telegram bot token.");
  if (!secrets?.telegramChatId) throw new Error("Missing Telegram chat id.");
  saveSecret(root, "notifier", {
    telegramBotToken: secrets.telegramBotToken,
    telegramChatId: String(secrets.telegramChatId)
  });
}

export function loadNotifierSecrets(root) {
  return loadSecret(root, "notifier", "notifier credentials");
}

export function hasNotifierSecrets(root) {
  return fs.existsSync(secretPath(root, "notifier"));
}
