import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCachedSchwabAccessTokenProvider, isSchwabReauthorizationError, schwabOAuthDiagnosticStatus } from "../src/schwab-oauth.js";

test("Schwab access tokens are decrypted once per live process and concurrent refresh is single-flight", async () => {
  let loads = 0;
  let refreshes = 0;
  let now = Date.parse("2026-08-21T16:00:00.000Z");
  const validProvider = createCachedSchwabAccessTokenProvider({
    now: () => now,
    refreshLock: async (_root, action) => action(),
    loadSecrets: () => {
      loads += 1;
      return { accessToken: "cached-token", accessTokenExpiresAt: "2026-08-21T17:00:00.000Z" };
    }
  });
  assert.equal(await validProvider("root"), "cached-token");
  assert.equal(await validProvider("root"), "cached-token");
  assert.equal(loads, 1);

  let expiredLoads = 0;
  const expiredProvider = createCachedSchwabAccessTokenProvider({
    now: () => now,
    refreshLock: async (_root, action) => action(),
    loadSecrets: () => {
      expiredLoads += 1;
      return { refreshToken: "refresh", accessTokenExpiresAt: "2026-08-21T15:00:00.000Z" };
    },
    refreshToken: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { accessToken: "fresh-token", accessTokenExpiresAt: "2026-08-21T17:00:00.000Z" };
    }
  });
  const tokens = await Promise.all([expiredProvider("root"), expiredProvider("root"), expiredProvider("root")]);
  assert.deepEqual(tokens, ["fresh-token", "fresh-token", "fresh-token"]);
  assert.equal(expiredLoads, 1, "one refresh flight must decrypt the secret bundle only once");
  assert.equal(refreshes, 1);
  now += 1_000;
  assert.equal(await expiredProvider("root"), "fresh-token");
  assert.equal(refreshes, 1);
});

test("Schwab refresh is serialized across independent providers and re-reads rotated credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-schwab-refresh-lock-"));
  let secrets = { refreshToken: "old-refresh", accessTokenExpiresAt: "2026-08-21T15:00:00.000Z" };
  let refreshes = 0;
  const dependencies = {
    now: () => Date.parse("2026-08-21T16:00:00.000Z"),
    loadSecrets: () => ({ ...secrets }),
    refreshToken: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      secrets = { accessToken: "rotated-access", refreshToken: "rotated-refresh", accessTokenExpiresAt: "2026-08-21T17:00:00.000Z" };
      return { accessToken: secrets.accessToken, accessTokenExpiresAt: secrets.accessTokenExpiresAt };
    }
  };
  try {
    const first = createCachedSchwabAccessTokenProvider(dependencies);
    const second = createCachedSchwabAccessTokenProvider(dependencies);
    assert.deepEqual(await Promise.all([first(root), second(root)]), ["rotated-access", "rotated-access"]);
    assert.equal(refreshes, 1);
    assert.equal(fs.existsSync(path.join(root, ".secrets", "schwab-refresh.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Schwab invalid_grant is recognized as requiring user reauthorization", () => {
  assert.equal(isSchwabReauthorizationError({ code: "SCHWAB_REAUTH_REQUIRED" }), true);
  assert.equal(isSchwabReauthorizationError(new Error("invalid_grant: refresh token is expired")), true);
  assert.equal(isSchwabReauthorizationError(new Error("temporary network failure")), false);
});

test("Schwab doctor treats a recorded reauthorization requirement as authoritative", () => {
  const oauth = {
    app_credentials: "present",
    access_token: "present",
    refresh_token: "present",
    accessTokenExpiresAt: "2026-08-26T18:00:00.000Z"
  };
  assert.equal(schwabOAuthDiagnosticStatus(oauth, {
    status: "reauthorization_required",
    checked_at: "2026-08-26T13:55:06.649Z"
  }, { now: Date.parse("2026-08-26T14:00:00.000Z") }), "reauthorization_required");
});

test("Schwab doctor distinguishes ready access from an expired access token with refresh available", () => {
  const base = {
    app_credentials: "present",
    access_token: "present",
    refresh_token: "present",
    refreshTokenExpiresAt: null
  };
  const now = Date.parse("2026-08-26T14:00:00.000Z");
  assert.equal(schwabOAuthDiagnosticStatus({
    ...base,
    accessTokenExpiresAt: "2026-08-26T15:00:00.000Z"
  }, null, { now }), "ready");
  assert.equal(schwabOAuthDiagnosticStatus({
    ...base,
    accessTokenExpiresAt: "2026-08-26T13:00:00.000Z"
  }, null, { now }), "access_expired_refresh_available");
});

test("Schwab doctor reports expired refresh authorization and unknown token timing accurately", () => {
  const now = Date.parse("2026-08-26T14:00:00.000Z");
  assert.equal(schwabOAuthDiagnosticStatus({
    app_credentials: "present",
    access_token: "present",
    refresh_token: "present",
    accessTokenExpiresAt: "2026-08-26T15:00:00.000Z",
    refreshTokenExpiresAt: "2026-08-26T13:00:00.000Z"
  }, null, { now }), "reauthorization_required");
  assert.equal(schwabOAuthDiagnosticStatus({
    app_credentials: "present",
    access_token: "present",
    refresh_token: "missing",
    accessTokenExpiresAt: null
  }, null, { now }), "access_expiry_unknown");
  assert.equal(schwabOAuthDiagnosticStatus({
    app_credentials: "present",
    access_token: "missing",
    refresh_token: "present"
  }, null, { now }), "refresh_available");
});

test("Schwab doctor never calls an unverified environment token ready", () => {
  assert.equal(schwabOAuthDiagnosticStatus({
    app_credentials: "missing",
    access_token: "missing",
    refresh_token: "missing"
  }, null, {
    now: Date.parse("2026-08-26T14:00:00.000Z"),
    environmentAccessTokenPresent: true
  }), "environment_access_token_present_unverified");
});
