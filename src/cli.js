import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadConfig, ensurePrivateDirectories } from "./config.js";
import { checkpointAndCloseDatabase, getOperationalState, openDatabase, setOperationalState } from "./db.js";
import { buildDailyReport, readyUnreportedDates, scheduledDailyDates, validateSolReport } from "./daily.js";
import { backfillLifecycleReviews } from "./lifecycle.js";
import { connectTelegram, interactiveLogin, resolveTargetChannels, subscribeMessages } from "./telegram-client.js";
import { hasNotifierSecrets, hasSchwabSecrets, hasTelegramSecrets, loadSchwabSecrets, saveNotifierSecrets, saveSchwabSecrets } from "./secrets.js";
import { exchangeSchwabCode, isSchwabReauthorizationError, refreshSchwabToken, schwabAuthorizeUrl, schwabOAuthDiagnosticStatus, schwabOAuthStatus } from "./schwab-oauth.js";
import { openClawInvocation } from "./openclaw.js";
import { startKeepAwake } from "./keep-awake.js";
import { createNotifier, exceptionNotification, formatLocalTime } from "./notifier.js";
import { createMessageCoordinator, initializeCursorBaselines, pollChannelsOnce } from "./listener.js";
import { localDateKey } from "./time.js";
import { createListenerRuntime, requestListenerShutdown } from "./shutdown.js";
import { AI_CIRCUIT_KEY, classifyAiAvailabilityError, isAiCircuitOpen } from "./ai-circuit.js";
import { createMarketDataRuntime } from "./market-data.js";
import { createPositionWorkflowManager } from "./position-workflows.js";
import { deployPendingNativeCore } from "./native-core-deployment.js";
import { requestIntradayShutdown } from "./intraday-runtime.js";
import { resolveAwaitingHumanChoice } from "./position-workflow-resolution.js";
import { readSupervisorStatus, requestSupervisorShutdown } from "./supervisor.js";
import { atomicWriteFileSync } from "./atomic-file.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function getConfig() {
  const config = loadConfig(argValue("--config") ?? undefined);
  ensurePrivateDirectories(config);
  return config;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function init() {
  const config = getConfig();
  const db = openDatabase(config.data.database);
  db.close();
  console.log(`Initialized append-only database: ${config.data.database}`);
  console.log("Run npm run telegram:login, then npm run doctor.");
}

async function doctor() {
  const config = getConfig();
  const result = {
    config: "ok",
    database: null,
    openclaw: null,
    ai_analysis: null,
    keep_awake: null,
    market_data: null,
    market_data_worker: null,
    market_data_sources: null,
    listener_mode: "new_only_with_cursor_recovery",
    media_vision: null,
    notifier: null,
    supervisor: null,
    telegram_events: null,
    telegram_session: hasTelegramSecrets(config.__root) ? "present" : "missing",
    channels: []
  };
  const db = openDatabase(config.data.database);
  const aiCircuit = getOperationalState(db, AI_CIRCUIT_KEY);
  const schwabPrimaryState = getOperationalState(db, "market_data:schwab_primary:v1");
  db.close();
  result.database = "ok";
  result.supervisor = readSupervisorStatus(config);
  result.ai_analysis = isAiCircuitOpen(aiCircuit)
    ? { status: "paused", reason: aiCircuit.summary, retry_after: aiCircuit.retry_after }
    : { status: "ready" };
  if (config.keepAwake === false || process.platform !== "win32") {
    result.keep_awake = "disabled";
  } else {
    const keepAwakeScript = path.resolve(config.__root, "scripts/keep-awake.ps1");
    try {
      execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
        "-File", keepAwakeScript, "-SelfTest"
      ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      result.keep_awake = "ready";
    } catch (error) {
      result.keep_awake = `error: ${error.message}`;
    }
  }
  const primaryProvider = config.marketData?.primary ?? "none";
  if (primaryProvider === "fidelity_web") {
    result.market_data = "fidelity_underlying_ready";
  } else if (primaryProvider === "schwab") {
    const python = path.resolve(config.__root, config.marketData.python);
    const workerScript = path.resolve(config.__root, config.marketData.workerScript ?? "scripts/realtime_worker.py");
    const oauth = schwabOAuthStatus(config.__root);
    const oauthStatus = schwabOAuthDiagnosticStatus(oauth, schwabPrimaryState, {
      environmentAccessTokenPresent: Boolean(process.env.SCHWAB_ACCESS_TOKEN)
    });
    result.market_data = !fs.existsSync(python) || !fs.existsSync(workerScript)
      ? "schwab_runtime_missing"
      : `schwab_${oauthStatus}`;
    result.schwab_oauth = {
      ...oauth,
      status: oauthStatus,
      primary_runtime_status: schwabPrimaryState?.status ?? "unknown",
      primary_runtime_checked_at: schwabPrimaryState?.checked_at ?? null
    };
    if (fs.existsSync(python) && fs.existsSync(workerScript)) {
      try {
        const check = JSON.parse(execFileSync(python, [
          workerScript,
          "--state-dir", path.resolve(config.__root, config.marketData.stateDir ?? "data/ocean-wave-state"),
          "--self-test"
        ], { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
        result.market_data_worker = check.status === "ok" && check.native_core === true
          ? "ready_cpp" : "native_core_missing";
      } catch (error) {
        result.market_data_worker = `error: ${error.message}`;
      }
    } else {
      result.market_data_worker = "runtime_missing";
    }
  } else {
    result.market_data = "text_only";
  }
  result.market_data_sources = {
    primary: primaryProvider,
    cross_check: config.marketData?.crossCheck ?? [],
    fallback: config.marketData?.fallback ?? [],
    fidelity_scope: (config.marketData?.crossCheck ?? []).includes("fidelity_web")
      || (config.marketData?.fallback ?? []).includes("fidelity_web")
      ? "underlying_quote_only" : "disabled"
  };
  if (config.media?.enabled === true) {
    try {
      const sharp = (await import("sharp")).default;
      result.media_vision = sharp.versions?.vips ? `ready_native_libvips_${sharp.versions.vips}` : "native_runtime_missing";
    } catch {
      result.media_vision = "native_runtime_missing";
    }
  } else {
    result.media_vision = "disabled";
  }
  result.notifier = config.notifications?.telegram?.enabled === true
    ? (hasNotifierSecrets(config.__root) ? "ready" : "secrets_missing")
    : "disabled";
  try {
    const invocation = openClawInvocation(config.openclaw.binary);
    result.openclaw = JSON.parse(execFileSync(invocation.file, [...invocation.prefixArgs, "health", "--json", "--timeout", "5000"], {
      encoding: "utf8", windowsHide: true
    })).ok ? "ok" : "unhealthy";
  } catch (error) {
    result.openclaw = `error: ${error.message}`;
  }
  if (hasTelegramSecrets(config.__root)) {
    const client = await connectTelegram(config.__root);
    try {
      const channels = await resolveTargetChannels(client, config.channels);
      result.channels = channels.map(({ key, displayName, chatId }) => ({ key, displayName, chatId }));
      const unsubscribe = await subscribeMessages(client, channels, () => {});
      unsubscribe();
      result.telegram_events = "ready";
    } finally {
      await client.disconnect();
    }
  }
  printJson(result);
}

async function listen() {
  const config = getConfig();
  const notifier = createNotifier(config);
  let db;
  let client;
  let unsubscribe = () => {};
  let coordinator;
  let stopping = false;
  let keepAwakeFailure = null;
  let runtime;
  let stopReason = null;
  let drained = false;
  let fatalError = null;
  let marketDataRuntime;
  let primaryAuthCheck = null;
  let positionWorkflows;
  let heartbeatTimer;
  let wakeLoop;
  const stopped = new Promise((resolve) => { wakeLoop = resolve; });
  const requestStop = (reason = "signal") => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    coordinator?.stopAccepting();
    unsubscribe();
    unsubscribe = () => {};
    runtime?.update("draining", { stop_reason: reason, queued_messages: coordinator?.queuedCount() ?? 0 });
    wakeLoop();
  };
  const keepAwakeManagedByLauncher = process.env.OCEAN_WAVE_EXTERNAL_KEEP_AWAKE === "1";
  const stopKeepAwake = startKeepAwake(config.keepAwake !== false && !keepAwakeManagedByLauncher, (error) => {
    keepAwakeFailure = error;
    console.error(error.message);
    void Promise.resolve().then(() => notifier.send("error", exceptionNotification("keep_awake", error)))
      .catch((notificationError) => console.error(`Keep-awake notification error: ${notificationError.message}`));
    requestStop();
  });
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    const handler = () => requestStop(signal);
    try {
      process.once(signal, handler);
      signalHandlers.set(signal, handler);
    } catch {
      // Some signals are unavailable on some operating systems.
    }
  }

  try {
    runtime = createListenerRuntime(config, requestStop);
    const nativeDeployment = deployPendingNativeCore(config, runtime);
    if (["deployed", "recovered_after_replace"].includes(nativeDeployment.status)) {
      console.log(`Verified Ocean-Wave native core ${nativeDeployment.status}: ${nativeDeployment.sha256}`);
    }
    db = openDatabase(config.data.database);
    const primaryStateKey = "market_data:schwab_primary:v1";
    const recordPrimaryStatus = async ({ status, error = null }) => {
      const now = new Date().toISOString();
      const previous = getOperationalState(db, primaryStateKey);
      if (status === "ready") {
        setOperationalState(db, primaryStateKey, { status: "ready", checked_at: now });
        if (["unavailable", "reauthorization_required"].includes(previous?.status)) {
          await notifier.send("recovery", "Ocean-Wave Schwab 主行情授权已恢复。")
            .catch((notificationError) => console.error(`Schwab recovery notification error: ${notificationError.message}`));
        }
        return;
      }
      const required = isSchwabReauthorizationError(error);
      const nextStatus = required ? "reauthorization_required" : "unavailable";
      const summary = String(error?.message ?? error ?? "Schwab primary unavailable").replace(/\s+/g, " ").slice(0, 500);
      const signature = `${error?.code ?? error?.name ?? "Error"}:${summary}`;
      setOperationalState(db, primaryStateKey, {
        status: nextStatus,
        signature,
        summary,
        checked_at: now,
        fidelity_fallback_enabled: (config.marketData?.fallback ?? []).includes("fidelity_web")
      });
      if (previous?.signature !== signature) {
        const message = required
          ? "Ocean-Wave Schwab 授权已失效，需要重新登录授权。Telegram 监听继续运行；行情将严格降级，过期 Fidelity 报价不会进入训练。"
          : exceptionNotification("schwab_primary", error);
        await notifier.send("error", message)
          .catch((notificationError) => console.error(`Schwab failure notification error: ${notificationError.message}`));
      }
    };
    marketDataRuntime = createMarketDataRuntime(config, { onPrimaryStatus: recordPrimaryStatus });
    await marketDataRuntime.start();
    positionWorkflows = createPositionWorkflowManager(config, db, { marketDataRuntime, notifier });
    const restoredWorkflows = await positionWorkflows.restore();
    if (restoredWorkflows.length) console.log(`Restored ${restoredWorkflows.length} open position workflows.`);
    client = await connectTelegram(config.__root);
    const channels = await resolveTargetChannels(client, config.channels);
    console.log(`Resolved read-only targets: ${channels.map((c) => c.displayName).join(", ")}`);

    // An empty database starts at the current Telegram tip. Later restarts use
    // the saved high-water marks and recover only messages newer than them.
    const baselines = await initializeCursorBaselines(db, client, channels);
    if (baselines.length) console.log(`Initialized live-only baselines: ${JSON.stringify(baselines)}`);
    coordinator = createMessageCoordinator({
      config,
      db,
      client,
      notifier,
      positionWorkflows,
      marketCapture: marketDataRuntime.capture
    });
    const eventError = async (error) => {
      console.error(`Telegram event error: ${error.stack ?? error.message}`);
      await notifier.send("error", exceptionNotification("telegram_event", error));
    };
    unsubscribe = await subscribeMessages(client, channels, coordinator.schedule, eventError);
    if (stopping) {
      coordinator.stopAccepting();
      unsubscribe();
      unsubscribe = () => {};
    }
    await pollChannelsOnce(db, client, channels, coordinator.schedule, config.listener?.batchSize);
    await coordinator.retryPending(channels, config.listener?.retryBatchSize);

    console.log("Listening for new messages. Cursor recovery is active.");
    runtime.update("ready", {
      channels: channels.map((channel) => channel.key),
      market_data_worker: marketDataRuntime.status(),
      position_workflows: positionWorkflows.status()
    });
    const analysisStatus = coordinator.analysisStatus();
    await notifier.send("startup", [
      "Ocean-Wave listener ready",
      `channels: ${channels.map((c) => c.displayName).join(", ")}`,
      "mode: new messages + cursor gap recovery",
      analysisStatus.status === "paused"
        ? `AI: paused until ${formatLocalTime(config, analysisStatus.retry_after)}; capture remains active`
        : "AI: ready",
      `time: ${formatLocalTime(config)}`
    ].join("\n"));
    primaryAuthCheck = marketDataRuntime.checkPrimary?.()
      .then(() => recordPrimaryStatus({ status: "ready" }))
      .catch((error) => recordPrimaryStatus({ status: "unavailable", error }));

    const pollIntervalMs = Number(config.listener?.pollIntervalSeconds ?? 10) * 1000;
    const retryIntervalMs = Number(config.listener?.retryIntervalSeconds ?? 60) * 1000;
    const heartbeatIntervalMs = Math.max(2_000, Number(config.listener?.heartbeatSeconds ?? 10) * 1000);
    const maxErrors = Number(config.listener?.maxConsecutivePollErrors ?? 3);
    let consecutiveErrors = 0;
    let nextRetryAt = Date.now() + retryIntervalMs;
    let lastPollOkAt = new Date().toISOString();
    let lastPollErrorAt = null;
    let lastPollError = null;
    const writeHeartbeat = () => {
      if (stopping) return;
      const memory = process.memoryUsage();
      runtime.heartbeat({
        heartbeat_at: new Date().toISOString(),
        last_poll_ok_at: lastPollOkAt,
        last_poll_error_at: lastPollErrorAt,
        last_poll_error: lastPollError,
        queued_messages: coordinator.queuedCount(),
        analysis: coordinator.analysisStatus(),
        market_data_worker: marketDataRuntime.status(),
        position_workflows: positionWorkflows.status(),
        process_memory: {
          rss_bytes: memory.rss,
          heap_used_bytes: memory.heapUsed,
          external_bytes: memory.external
        },
        consecutive_poll_errors: consecutiveErrors
      });
    };
    writeHeartbeat();
    heartbeatTimer = setInterval(() => {
      try {
        writeHeartbeat();
      } catch (error) {
        console.error(`Listener heartbeat collection error: ${error.message}`);
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    while (!stopping) {
      try {
        await pollChannelsOnce(db, client, channels, coordinator.schedule, config.listener?.batchSize);
        if (Date.now() >= nextRetryAt) {
          await coordinator.retryPending(channels, config.listener?.retryBatchSize);
          nextRetryAt = Date.now() + retryIntervalMs;
        }
        consecutiveErrors = 0;
        lastPollOkAt = new Date().toISOString();
        lastPollErrorAt = null;
        lastPollError = null;
      } catch (error) {
        consecutiveErrors += 1;
        lastPollErrorAt = new Date().toISOString();
        lastPollError = String(error.message ?? error).slice(0, 300);
        console.error(`Listener health error ${consecutiveErrors}/${maxErrors}: ${error.stack ?? error.message}`);
        await notifier.send("error", exceptionNotification("listener_health", error));
        writeHeartbeat();
        if (consecutiveErrors >= maxErrors) throw error;
      }
      let pollTimer;
      try {
        await Promise.race([
          new Promise((resolve) => { pollTimer = setTimeout(resolve, Math.max(1000, pollIntervalMs)); }),
          stopped
        ]);
      } finally {
        clearTimeout(pollTimer);
      }
    }
    coordinator.stopAccepting();
    unsubscribe();
    unsubscribe = () => {};
    runtime.update("draining", { stop_reason: stopReason ?? "requested", queued_messages: coordinator.queuedCount() });
    await coordinator.drain();
    drained = true;
    if (keepAwakeFailure) throw keepAwakeFailure;
    await notifier.send("shutdown", `Ocean-Wave listener stopping\n${formatLocalTime(config)}`);
  } catch (error) {
    fatalError = error;
    await notifier.send("fatal", exceptionNotification("listener_fatal", error));
    throw error;
  } finally {
    let databaseCloseError = null;
    let marketDataCloseError = null;
    clearInterval(heartbeatTimer);
    unsubscribe();
    coordinator?.stopAccepting();
    if (coordinator && !drained) {
      runtime?.update("draining", { stop_reason: stopReason ?? "fatal_cleanup", queued_messages: coordinator.queuedCount() });
      await coordinator.drain().catch((error) => console.error(`Shutdown drain error: ${error.message}`));
    }
    if (positionWorkflows) {
      try {
        await positionWorkflows.closeAll(stopReason ?? "listener_shutdown");
      } catch (error) {
        console.error(`Position workflow shutdown error: ${error.message}`);
      }
    }
    if (marketDataRuntime) {
      await primaryAuthCheck?.catch(() => {});
      try {
        await marketDataRuntime.close();
      } catch (error) {
        marketDataCloseError = error;
        console.error(`Market-data worker shutdown error: ${error.message}`);
      }
    }
    stopKeepAwake();
    if (client) await client.disconnect().catch(() => {});
    if (db) {
      runtime?.update("flushing_database");
      try {
        checkpointAndCloseDatabase(db);
      } catch (error) {
        databaseCloseError = error;
        try { db.close(); } catch { /* Already closed or unable to close. */ }
      }
    }
    const exitError = fatalError ?? marketDataCloseError ?? databaseCloseError;
    runtime?.close(exitError ? "failed" : "stopped", {
      stop_reason: stopReason ?? (exitError ? "listener_fatal" : "listener_exit"),
      market_data_worker: marketDataRuntime?.status?.() ?? { running: false, pid: null },
      position_workflows: positionWorkflows?.status?.() ?? {
        enabled: config.positionWorkflow?.enabled !== false,
        active: 0,
        worker_process_count: 0
      },
      ...(exitError ? { error: String(exitError.message ?? exitError).slice(0, 300) } : {})
    });
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (marketDataCloseError) throw marketDataCloseError;
    if (databaseCloseError) throw databaseCloseError;
  }
}

async function stopAll() {
  const config = getConfig();
  // A Terra call may legitimately run for ten minutes. Allow the default
  // stop command to wait for several queued calls without ever force-killing
  // the listener or risking a partial checkpoint.
  const timeoutSeconds = Number(argValue("--timeout-seconds") ?? 3600);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error("--timeout-seconds must be from 1 to 3600.");
  }
  const supervisorStatus = readSupervisorStatus(config);
  if (supervisorStatus.indeterminate) {
    const error = new Error(`Supervisor ownership is ${supervisorStatus.status}; refusing direct-child shutdown fallback.`);
    error.code = "SUPERVISOR_OWNERSHIP_INDETERMINATE";
    throw error;
  }
  if (supervisorStatus.running) {
    const supervisor = await requestSupervisorShutdown(config, {
      timeoutMilliseconds: timeoutSeconds * 1000,
      reason: "user_safe_stop"
    });
    printJson({ supervisor });
    return;
  }
  const [listener, intraday] = await Promise.allSettled([
    requestListenerShutdown(config, { timeoutMilliseconds: timeoutSeconds * 1000 }),
    requestIntradayShutdown(config, { timeoutMilliseconds: timeoutSeconds * 1000 })
  ]);
  const result = {
    listener: listener.status === "fulfilled" ? listener.value : { status: "error", error: listener.reason?.message ?? String(listener.reason) },
    intraday: intraday.status === "fulfilled" ? intraday.value : { status: "error", error: intraday.reason?.message ?? String(intraday.reason) }
  };
  printJson(result);
  const failures = [listener, intraday].filter((item) => item.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((item) => item.reason), "One or more Ocean Wave runtimes did not stop cleanly.");
}

async function notifierSetup() {
  const config = getConfig();
  const token = argValue("--token") ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = argValue("--chat-id") ?? process.env.TELEGRAM_BOT_CHAT_ID;
  saveNotifierSecrets(config.__root, { telegramBotToken: token, telegramChatId: chatId });
  console.log("Saved encrypted Telegram bot notifier credentials.");
}

async function notifierTest() {
  const config = getConfig();
  const notifier = createNotifier({ ...config, notifications: { ...config.notifications, telegram: { ...(config.notifications?.telegram ?? {}), enabled: true } } });
  const ok = await notifier.send("test", `Ocean-Wave notifier test\n${formatLocalTime(config)}`);
  if (!ok) throw new Error("Notifier test message failed.");
  console.log("Notifier test message sent.");
}

async function schwabSetup() {
  const config = getConfig();
  const appKey = argValue("--app-key") ?? process.env.SCHWAB_APP_KEY;
  const appSecret = argValue("--app-secret") ?? process.env.SCHWAB_APP_SECRET;
  const callbackUrl = argValue("--callback-url") ?? process.env.SCHWAB_CALLBACK_URL ?? "https://127.0.0.1:8182";
  saveSchwabSecrets(config.__root, { appKey, appSecret, callbackUrl, scope: "readonly" });
  console.log("Saved encrypted Schwab app credentials.");
}

async function schwabAuthUrlCommand() {
  const config = getConfig();
  if (!hasSchwabSecrets(config.__root)) throw new Error("Run schwab-setup first.");
  const status = schwabOAuthStatus(config.__root);
  const secrets = loadSchwabSecrets(config.__root);
  printJson({ ...status, authorize_url: schwabAuthorizeUrl(secrets) });
}

async function schwabExchangeCode() {
  const config = getConfig();
  const codeFile = argValue("--code-file");
  let code = argValue("--code") ?? process.env.SCHWAB_AUTH_CODE;
  if (codeFile) {
    const secretsRoot = path.resolve(config.__root, ".secrets");
    const resolvedCodeFile = path.resolve(codeFile);
    const relative = path.relative(secretsRoot, resolvedCodeFile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Schwab authorization-code file must be inside the private .secrets directory.");
    }
    const stat = fs.lstatSync(resolvedCodeFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Schwab authorization-code input must be a regular, non-symlink file.");
    }
    try {
      code = fs.readFileSync(resolvedCodeFile, "utf8").trim();
    } finally {
      fs.rmSync(resolvedCodeFile, { force: true });
    }
  }
  if (!code) throw new Error("Missing --code-file, --code, or SCHWAB_AUTH_CODE.");
  printJson(await exchangeSchwabCode(config.__root, code));
  code = null;
}

async function schwabRefresh() {
  const config = getConfig();
  const refreshed = await refreshSchwabToken(config.__root);
  printJson({ accessTokenExpiresAt: refreshed.accessTokenExpiresAt });
}

export function recoverDailyReportArtifact(db, root, reportDate) {
  const row = db.prepare(`
    SELECT report_json
    FROM daily_reports
    WHERE report_date = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(reportDate);
  if (!row) return null;
  const report = JSON.parse(row.report_json);
  const validation = validateSolReport(report, reportDate);
  if (validation !== true) throw new Error(`Stored Sol report is invalid: ${validation}`);
  const outputDir = path.join(root, "outputs");
  const filename = path.join(outputDir, `ocean-wave-daily-${reportDate}.json`);
  let fileValid = false;
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      fileValid = validateSolReport(JSON.parse(fs.readFileSync(filename, "utf8")), reportDate) === true;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!fileValid) {
    fs.mkdirSync(outputDir, { recursive: true });
    atomicWriteFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      allowCopyFallback: true
    });
  }
  return { filename, recovered: !fileValid };
}

async function daily() {
  const config = getConfig();
  const db = openDatabase(config.data.database);
  const notifier = createNotifier(config);
  try {
    const requestedDate = argValue("--date");
    const today = localDateKey(new Date(), config.timezone);
    const todayOnly = process.argv.includes("--today-only");
    if (todayOnly && !requestedDate) {
      const existing = recoverDailyReportArtifact(db, config.__root, today);
      if (existing) {
        printJson({
          status: existing.recovered ? "recovered_report_artifact" : "already_reported",
          written: [existing.filename]
        });
        return;
      }
    }
    const existingCircuit = getOperationalState(db, AI_CIRCUIT_KEY);
    if (isAiCircuitOpen(existingCircuit)) {
      printJson({
        status: "deferred_ai_paused",
        retry_after: existingCircuit.retry_after,
        reason: existingCircuit.summary
      });
      return;
    }
    const dates = requestedDate
      ? [requestedDate]
      : todayOnly
        ? scheduledDailyDates(db, config.timezone, today)
        : readyUnreportedDates(db, config.timezone, today);
    if (dates.length === 0) {
      printJson({ status: "nothing_ready", detail: "No unreported day has a complete AI analysis set." });
      return;
    }
    const outputDir = path.join(config.__root, "outputs");
    fs.mkdirSync(outputDir, { recursive: true });
    const written = [];
    for (const date of dates) {
      const failureKey = `daily:failure:v1:${date}`;
      try {
        const report = await buildDailyReport(config, db, date);
        const filename = path.join(outputDir, `ocean-wave-daily-${date}.json`);
        atomicWriteFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          allowCopyFallback: true
        });
        written.push(filename);
        const previousFailure = getOperationalState(db, failureKey);
        if (previousFailure?.status === "failed") {
          setOperationalState(db, failureKey, {
            ...previousFailure,
            status: "recovered",
            recovered_at: new Date().toISOString()
          });
          await notifier.send("recovery", `Ocean-Wave Sol 日报已恢复\ndate: ${date}`)
            .catch((notificationError) => console.error(`Daily recovery notification error: ${notificationError.message}`));
        }
      } catch (error) {
        const availability = classifyAiAvailabilityError(error);
        if (!availability) {
          const now = new Date().toISOString();
          const summary = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 500);
          const signature = `${error?.code ?? error?.name ?? "Error"}:${summary}`;
          const previousFailure = getOperationalState(db, failureKey);
          setOperationalState(db, failureKey, {
            status: "failed",
            date,
            signature,
            summary,
            failed_at: previousFailure?.failed_at ?? now,
            updated_at: now
          });
          if (previousFailure?.signature !== signature) {
            await notifier.send("error", exceptionNotification(`daily_sol ${date}`, error))
              .catch((notificationError) => console.error(`Daily failure notification error: ${notificationError.message}`));
          }
          throw error;
        }
        const now = new Date().toISOString();
        setOperationalState(db, AI_CIRCUIT_KEY, {
          status: "open",
          ...availability,
          opened_at: now,
          updated_at: now
        });
        await notifier.send("error", [
          "Ocean-Wave Sol 日报已延后",
          availability.summary,
          `自动重试时间: ${availability.retry_after}`,
          "未生成的日期会在 AI 恢复且逐条分析完成后自动补做。"
        ].join("\n"));
        printJson({ status: "deferred_ai_paused", retry_after: availability.retry_after, written });
        return;
      }
    }
    printJson({ status: "ok", reports: written });
  } finally {
    db.close();
  }
}

async function lifecycleAudit() {
  const config = getConfig();
  const db = openDatabase(config.data.database);
  try {
    printJson(backfillLifecycleReviews(db));
  } finally {
    db.close();
  }
}

async function resolvePositionWorkflow() {
  const config = getConfig();
  const db = openDatabase(config.data.database);
  try {
    printJson(resolveAwaitingHumanChoice(db, {
      workflowId: argValue("--workflow-id"),
      exitPrice: argValue("--exit-price"),
      exitAt: argValue("--exit-at"),
      disposition: argValue("--disposition")
    }));
  } finally {
    db.close();
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "init") return init();
  if (command === "doctor") return doctor();
  if (command === "telegram-login") {
    const config = getConfig();
    return interactiveLogin(config.__root);
  }
  if (command === "listen") return listen();
  if (command === "stop") return stopAll();
  if (command === "notifier-setup") return notifierSetup();
  if (command === "notifier-test") return notifierTest();
  if (command === "schwab-setup") return schwabSetup();
  if (command === "schwab-auth-url") return schwabAuthUrlCommand();
  if (command === "schwab-exchange-code") return schwabExchangeCode();
  if (command === "schwab-refresh") return schwabRefresh();
  if (command === "daily") return daily();
  if (command === "lifecycle-audit") return lifecycleAudit();
  if (command === "position-resolve") return resolvePositionWorkflow();
  throw new Error("Usage: node src/cli.js <init|doctor|telegram-login|listen|stop|notifier-setup|notifier-test|schwab-setup|schwab-auth-url|schwab-exchange-code|schwab-refresh|daily|lifecycle-audit|position-resolve>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
