import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSchwabSecrets, saveSchwabSecrets } from "./secrets.js";

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_STALE_MS = 120_000;

function nowIso() {
  return new Date().toISOString();
}

function expiresAt(seconds, safetySeconds = 60) {
  const ttl = Math.max(0, Number(seconds ?? 0) - safetySeconds);
  return new Date(Date.now() + ttl * 1000).toISOString();
}

function basicAuth(appKey, appSecret) {
  return `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`;
}

function redact(value) {
  return String(value ?? "")
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/refresh_token=[^&\s]+/gi, "refresh_token=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Basic\s+\S+/gi, "Basic [redacted]");
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function withSchwabRefreshLock(root, action) {
  const directory = path.join(path.resolve(root), ".secrets");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "schwab-refresh.lock");
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(filename, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ owner_id: ownerId, pid: process.pid, created_at: nowIso() }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let removedStale = false;
      try {
        const stat = fs.statSync(filename);
        if (Date.now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
          const owner = JSON.parse(fs.readFileSync(filename, "utf8"));
          if (!processAlive(owner.pid)) {
            fs.unlinkSync(filename);
            removedStale = true;
          }
        }
      } catch (caught) {
        if (caught.code === "ENOENT") removedStale = true;
      }
      if (removedStale) continue;
      if (Date.now() >= deadline) {
        const timeout = new Error("Timed out waiting for the shared Schwab refresh lock.");
        timeout.code = "SCHWAB_REFRESH_LOCK_TIMEOUT";
        throw timeout;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (owner.owner_id === ownerId) fs.unlinkSync(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function schwabAuthorizeUrl(secrets, state = "ocean-wave") {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", secrets.appKey);
  url.searchParams.set("redirect_uri", secrets.callbackUrl);
  url.searchParams.set("response_type", "code");
  // Schwab's Market Data Production product requires the read-only scope.
  // Keep this explicit so the consent screen and token scope match the
  // application's read-only safety contract.
  // This project is strictly read-only.  Schwab may report the token's
  // aggregate scope as `api` even when the App only has Market Data enabled;
  // never widen a future authorization request based on that response.
  url.searchParams.set("scope", "readonly");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(secrets, form) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": basicAuth(secrets.appKey, secrets.appSecret),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = redact(JSON.stringify(payload).slice(0, 600));
    const error = new Error(`Schwab OAuth HTTP ${response.status}: ${detail}`);
    if (/invalid_grant|refresh token[^\n]*(?:invalid|expired|revoked)/i.test(detail)) {
      error.code = "SCHWAB_REAUTH_REQUIRED";
    } else {
      error.code = "SCHWAB_OAUTH_FAILED";
    }
    throw error;
  }
  return payload;
}

export function isSchwabReauthorizationError(error) {
  if (error?.code === "SCHWAB_REAUTH_REQUIRED") return true;
  const message = typeof error === "object" && error != null
    ? `${error.code ?? ""} ${error.message ?? ""} ${error.error_description ?? ""}`
    : String(error ?? "");
  return /invalid_grant|refresh token[^\n]*(?:invalid|expired|revoked)|SCHWAB_REAUTH_REQUIRED/i.test(message);
}

async function refreshSchwabTokenFrom(root, current) {
  if (!current.refreshToken) throw new Error("Missing Schwab refresh token; run the initial OAuth authorization first.");
  const token = await tokenRequest(current, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken
  });
  const updatedAt = nowIso();
  const receivedRefreshToken = typeof token.refresh_token === "string" && token.refresh_token.length > 0;
  const next = {
    ...current,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? current.refreshToken,
    tokenType: token.token_type,
    scope: "readonly",
    tokenScope: token.scope ?? current.tokenScope ?? null,
    tokenUpdatedAt: updatedAt,
    refreshTokenIssuedAt: receivedRefreshToken
      ? updatedAt
      : current.refreshTokenIssuedAt ?? current.tokenUpdatedAt ?? null,
    accessTokenExpiresAt: expiresAt(token.expires_in, 90),
    refreshTokenExpiresAt: token.refresh_token_expires_in ? expiresAt(token.refresh_token_expires_in, 300) : current.refreshTokenExpiresAt
  };
  saveSchwabSecrets(root, next);
  return { accessToken: next.accessToken, accessTokenExpiresAt: next.accessTokenExpiresAt };
}

export async function exchangeSchwabCode(root, code) {
  const current = loadSchwabSecrets(root);
  const token = await tokenRequest(current, {
    grant_type: "authorization_code",
    code,
    redirect_uri: current.callbackUrl
  });
  const updatedAt = nowIso();
  const receivedRefreshToken = typeof token.refresh_token === "string" && token.refresh_token.length > 0;
  const next = {
    ...current,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? current.refreshToken,
    tokenType: token.token_type,
    scope: "readonly",
    tokenScope: token.scope ?? null,
    tokenUpdatedAt: updatedAt,
    refreshTokenIssuedAt: receivedRefreshToken
      ? updatedAt
      : current.refreshTokenIssuedAt ?? current.tokenUpdatedAt ?? null,
    accessTokenExpiresAt: expiresAt(token.expires_in, 90),
    refreshTokenExpiresAt: token.refresh_token_expires_in ? expiresAt(token.refresh_token_expires_in, 300) : current.refreshTokenExpiresAt
  };
  saveSchwabSecrets(root, next);
  return { accessTokenExpiresAt: next.accessTokenExpiresAt, refreshTokenExpiresAt: next.refreshTokenExpiresAt ?? null };
}

export async function refreshSchwabToken(root) {
  const current = loadSchwabSecrets(root);
  return refreshSchwabTokenFrom(root, current);
}

export function createCachedSchwabAccessTokenProvider({
  loadSecrets = loadSchwabSecrets,
  refreshToken = refreshSchwabTokenFrom,
  refreshLock = withSchwabRefreshLock,
  now = () => Date.now()
} = {}) {
  const cache = new Map();
  const refreshFlights = new Map();
  const valid = (entry) => entry?.accessToken
    && Number.isFinite(Date.parse(entry.accessTokenExpiresAt))
    && Date.parse(entry.accessTokenExpiresAt) > now() + 60_000;
  return async function cachedAccessToken(root) {
    const key = String(root);
    const cached = cache.get(key);
    if (valid(cached)) return cached.accessToken;
    if (refreshFlights.has(key)) return refreshFlights.get(key);

    // DPAPI decryption launches PowerShell on Windows. Serialize the cold
    // read before decrypting so a refresh needs one decrypt, not one before
    // and another after the inter-process lock. The lock also guarantees the
    // encrypted file cannot rotate between the read and refresh decision.
    const flight = Promise.resolve(refreshLock(root, async () => {
      const lockedCurrent = loadSecrets(root);
      if (valid(lockedCurrent)) {
        return {
          accessToken: lockedCurrent.accessToken,
          accessTokenExpiresAt: lockedCurrent.accessTokenExpiresAt
        };
      }
      return refreshToken(root, lockedCurrent);
    })).then((refreshed) => {
      cache.set(key, refreshed);
      return refreshed.accessToken;
    }).finally(() => refreshFlights.delete(key));
    refreshFlights.set(key, flight);
    return flight;
  };
}

export const getSchwabAccessToken = createCachedSchwabAccessTokenProvider();

function parsedTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Classify the locally observable Schwab authorization state without making a
 * network request. A runtime invalid_grant is authoritative even when an old
 * refresh-token value is still present on disk.
 */
export function schwabOAuthDiagnosticStatus(oauth, primaryState = null, {
  now = Date.now(),
  environmentAccessTokenPresent = false
} = {}) {
  if (primaryState?.status === "reauthorization_required") return "reauthorization_required";
  if (environmentAccessTokenPresent) return "environment_access_token_present_unverified";
  if (oauth?.app_credentials !== "present") return "app_credentials_missing";

  const accessPresent = oauth?.access_token === "present";
  const refreshPresent = oauth?.refresh_token === "present";
  const accessExpiresAt = parsedTimestamp(oauth?.accessTokenExpiresAt);
  const refreshExpiresAt = parsedTimestamp(oauth?.refreshTokenExpiresAt);
  const accessValid = accessPresent && accessExpiresAt != null && accessExpiresAt > now;
  const refreshExpired = refreshPresent && refreshExpiresAt != null && refreshExpiresAt <= now;

  if (accessValid && !refreshExpired) {
    return primaryState?.status === "unavailable" ? "primary_unavailable" : "ready";
  }
  if (refreshExpired) return "reauthorization_required";
  if (accessPresent && accessExpiresAt == null) return "access_expiry_unknown";
  if (refreshPresent) {
    return accessPresent ? "access_expired_refresh_available" : "refresh_available";
  }
  return "reauthorization_required";
}

export function schwabOAuthStatus(root) {
  try {
    const secrets = loadSchwabSecrets(root);
    return {
      app_credentials: secrets.appKey && secrets.appSecret && secrets.callbackUrl ? "present" : "missing",
      access_token: secrets.accessToken ? "present" : "missing",
      refresh_token: secrets.refreshToken ? "present" : "missing",
      accessTokenExpiresAt: secrets.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: secrets.refreshTokenExpiresAt ?? null,
      refreshTokenIssuedAt: secrets.refreshTokenIssuedAt ?? secrets.tokenUpdatedAt ?? null
    };
  } catch {
    return {
      app_credentials: "missing",
      access_token: "missing",
      refresh_token: "missing",
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      refreshTokenIssuedAt: null
    };
  }
}
