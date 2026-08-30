import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_AGENTS = ["main", "ocean-luna", "ocean-terra", "ocean-sol"];

function resolveOpenClawDist() {
  if (process.env.OPENCLAW_DIST_DIR?.trim()) {
    return path.resolve(process.env.OPENCLAW_DIST_DIR.trim());
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "npm", "node_modules", "openclaw", "dist");
  }
  return path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "openclaw", "dist");
}

function resolveStateDir() {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".openclaw");
}

function isOpenAiCredential(profileId, credential) {
  const provider = String(credential?.provider ?? "").toLowerCase();
  return provider === "openai" || provider === "openai-codex" || profileId.startsWith("openai:");
}

function sameIdentity(existing, credential) {
  if (!existing || existing.type !== "oauth") return false;
  if (existing.accountId && credential.accountId) return existing.accountId === credential.accountId;
  return Boolean(existing.email && credential.email
    && existing.email.toLowerCase() === credential.email.toLowerCase());
}

function replaceOpenAiProfile(store, profileId, credential, result) {
  const openAiProfiles = Object.entries(store.profiles ?? {})
    .filter(([existingId, existing]) => isOpenAiCredential(existingId, existing));
  const matching = openAiProfiles.length === 1
    && openAiProfiles[0][0] === profileId
    && sameIdentity(openAiProfiles[0][1], credential);
  if (matching) {
    store.profiles[profileId] = credential;
    store.order = { ...(store.order ?? {}), openai: [profileId] };
    result.accountChanged = false;
    return true;
  }

  result.accountChanged = openAiProfiles.some(([, existing]) => !sameIdentity(existing, credential));
  for (const [existingId, existing] of Object.entries(store.profiles ?? {})) {
    if (!isOpenAiCredential(existingId, existing)) continue;
    delete store.profiles[existingId];
    if (store.usageStats) delete store.usageStats[existingId];
  }

  store.profiles[profileId] = credential;
  store.order = { ...(store.order ?? {}), openai: [profileId] };
  delete store.order["openai-codex"];

  if (store.lastGood) {
    delete store.lastGood.openai;
    delete store.lastGood["openai-codex"];
    if (Object.keys(store.lastGood).length === 0) delete store.lastGood;
  }
  if (store.usageStats && Object.keys(store.usageStats).length === 0) {
    delete store.usageStats;
  }
  return true;
}

async function main() {
  const dist = resolveOpenClawDist();
  const sdkPath = path.join(dist, "plugin-sdk", "provider-auth.js");
  await access(sdkPath);
  const sdk = await import(pathToFileURL(sdkPath).href);

  const source = sdk.readCodexCliCredentialsCached({
    ttlMs: 0,
    allowKeychainPrompt: false,
  });
  if (!source || source.type !== "oauth" || source.provider !== "openai") {
    throw new Error("Current Codex login is not a usable OpenAI OAuth credential.");
  }
  if (!source.access || !source.refresh || !Number.isFinite(source.expires)) {
    throw new Error("Current Codex OAuth credential is incomplete.");
  }
  if (source.expires <= Date.now() + 60_000) {
    throw new Error("Current Codex OAuth credential is expired or about to expire.");
  }

  const identity = sdk.resolveOpenAICodexAuthIdentity({
    access: source.access,
    accountId: source.accountId,
  });
  if (!identity.email || !identity.accountId) {
    throw new Error("Current Codex OAuth credential has no stable account identity.");
  }

  const profileName = identity.email;
  const profileId = `openai:${profileName}`;
  const credential = {
    ...source,
    type: "oauth",
    provider: "openai",
    email: identity.email,
    accountId: identity.accountId,
    ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
    displayName: "Codex import",
  };

  const stateDir = resolveStateDir();
  const agentIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_AGENTS;
  const results = [];
  for (const agentId of agentIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
      throw new Error(`Invalid agent id: ${agentId}`);
    }
    const agentDir = path.join(stateDir, "agents", agentId, "agent");
    await access(agentDir);
    const result = { agentId, profileId, accountChanged: false };
    const updated = await sdk.updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions: {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
      updater: (store) => replaceOpenAiProfile(store, profileId, credential, result),
    });
    if (!updated) throw new Error(`Failed to update auth store for ${agentId}.`);
    results.push(result);
  }

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    account: identity.email,
    accountId: identity.accountId,
    expires: new Date(source.expires).toISOString(),
    gatewayRestartRequired: true,
    agents: results,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`OpenClaw account sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
