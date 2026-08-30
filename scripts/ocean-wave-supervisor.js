import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { createOceanWaveSupervisor, readSupervisorStatus, requestSupervisorShutdown } from "../src/supervisor.js";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : process.env.OCEAN_WAVE_CONFIG ?? "config.json";
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a filename");
  const config = (dependencies.loadConfig ?? loadConfig)(configPath);
  if (argv.includes("--status")) {
    const result = (dependencies.readStatus ?? readSupervisorStatus)(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (argv.includes("--request-stop")) {
    const timeoutSeconds = Number(argValue(argv, "--timeout-seconds") ?? 3600);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      throw new Error("--timeout-seconds must be from 1 to 3600");
    }
    const result = await (dependencies.requestStop ?? requestSupervisorShutdown)(config, {
      timeoutMilliseconds: timeoutSeconds * 1_000,
      reason: argValue(argv, "--reason") ?? "user_safe_stop"
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const supervisor = (dependencies.createSupervisor ?? createOceanWaveSupervisor)(config);
  await supervisor.start();
  const outcome = await supervisor.waitUntilClosed();
  if (outcome.status === "failed") throw new Error(`Supervisor stopped with an error: ${outcome.error?.message ?? "unknown"}`);
  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Ocean-Wave supervisor failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
