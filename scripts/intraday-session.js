import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { createIntradayRuntime } from "../src/intraday-runtime.js";

function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

export async function main(argv = process.argv.slice(2), {
  loadConfigImpl = loadConfig,
  createRuntime = createIntradayRuntime
} = {}) {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : process.env.OCEAN_WAVE_CONFIG ?? "config.json";
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a filename");
  const config = loadConfigImpl(configPath);
  const runtime = createRuntime(config);
  let fatalFlight = null;
  const failRuntime = (kind, value) => {
    process.exitCode = 1;
    if (fatalFlight) return fatalFlight;
    const error = value instanceof Error ? value : new Error(safeMessage(value));
    console.error(`Intraday ${kind}: ${safeMessage(error)}`);
    fatalFlight = Promise.resolve(runtime.close(kind, { failed: true, error })).catch((closeError) => {
      console.error(`Intraday fatal cleanup failed: ${safeMessage(closeError)}`);
    });
    return fatalFlight;
  };
  const onUncaughtException = (error) => { void failRuntime("uncaught_exception", error); };
  const onUnhandledRejection = (reason) => { void failRuntime("unhandled_rejection", reason); };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await runtime.start();
    const outcome = await runtime.waitUntilClosed();
    if (outcome?.status === "failed") {
      throw new Error(`Intraday runtime failed (${outcome.reason ?? "unknown"}): ${outcome.error?.message ?? "see audit log"}`);
    }
    return outcome;
  } finally {
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Intraday session failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
