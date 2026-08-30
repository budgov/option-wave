import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { reconcileIntradayRuntimeState, settleIntradayWatchdogClaim } from "../src/intraday-runtime.js";

function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)[_-]?token["'=:\s]+[^\s"&]+/gi, "token=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 2_000);
}

export function main(argv = process.argv.slice(2)) {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : process.env.OCEAN_WAVE_CONFIG ?? "config.json";
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a filename");
  const config = loadConfig(configPath);
  for (const [flag, confirmed] of [["--confirm-claim", true], ["--release-claim", false]]) {
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const claimId = argv[index + 1];
    if (!claimId) throw new Error(`${flag} requires a claim id`);
    const result = settleIntradayWatchdogClaim(config, claimId, { confirmed });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const claimRestart = argv.includes("--claim-restart");
  const result = reconcileIntradayRuntimeState(config, { claimRestart });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Intraday watchdog failed: ${safeMessage(error)}`);
    process.exitCode = 1;
  }
}
