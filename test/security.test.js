import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.js";

const root = process.cwd();

function sourceText(directory) {
  const files = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
  return files.flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? [sourceText(relative)] : [fs.readFileSync(path.join(root, relative), "utf8")];
  }).join("\n");
}

test("runtime avoids common malware-like shell patterns", () => {
  const javascript = sourceText("src");
  const scripts = sourceText("scripts");
  const launcher = fs.readFileSync(path.join(root, "stop-ocean-wave.cmd"), "utf8");
  assert.doesNotMatch(javascript, /["']-Command["']/i);
  assert.doesNotMatch(javascript, /shell\s*:\s*true/i);
  assert.doesNotMatch(scripts, /ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(`${javascript}\n${scripts}\n${launcher}`, /Invoke-Expression|EncodedCommand|DownloadString|schwab-code\.pending/i);
  assert.doesNotMatch(launcher, /powershell|curl|bitsadmin|certutil|reg\s+add/i);
});

test("model prompts use a file instead of appearing on the process command line", () => {
  const source = fs.readFileSync(path.join(root, "src", "openclaw.js"), "utf8");
  assert.match(source, /"--message-file"/);
  assert.doesNotMatch(source, /"--message",\s*prompt/);
});

test("production configuration preserves the read-only safety contract", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.deepEqual(config.safety, {
    readOnly: true,
    allowOutboundTelegram: false,
    allowTrading: false
  });
  assert.equal(config.marketData.primary, "schwab");
  assert.deepEqual(config.marketData.crossCheck, ["fidelity_web"]);
  assert.deepEqual(config.marketData.fallback, ["fidelity_web"]);
  assert.equal(config.listener.heartbeatSeconds, 10);
  assert.equal(config.marketData.crossCheckWaitMilliseconds, 1000);
  assert.equal(config.marketData.validation.maxCrossCheckTimeSkewSeconds, 15);
  assert.deepEqual(config.intradayResearch.symbols, ["QQQ", "SPY"]);
  assert.deepEqual(config.intradayResearch.contextSymbols, ["IWM", "DIA", "TLT", "GLD"]);
  assert.equal(config.intradayResearch.sampleIntervalSeconds, 60);
  assert.equal(config.intradayResearch.forecastIntervalMinutes, 30);
  assert.equal(config.intradayResearch.forecastHorizonMinutes, 30);
  assert.equal(config.intradayResearch.maximumQuoteSkewMilliseconds, 3000);
  assert.equal(config.intradayResearch.maximumCatchupSlotsPerAdvance, 2);
  assert.equal(config.openclaw.agents.sol.thinking, "high");
});

test("intraday cadence and model-promotion gates are fail-closed", () => {
  const cadence = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  cadence.intradayResearch.sampleIntervalSeconds = 30;
  assert.throws(() => validateConfig(cadence), /sampleIntervalSeconds must be 60/);

  const gate = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  gate.intradayResearch.minimumPromotionTradingDays = 5;
  assert.throws(() => validateConfig(gate), /minimumPromotionTradingDays must be an integer from 20/);
});

test("cross-check timestamp skew configuration is bounded", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  config.marketData.validation.maxCrossCheckTimeSkewSeconds = 0;
  assert.throws(
    () => validateConfig(config),
    /marketData\.validation\.maxCrossCheckTimeSkewSeconds must be from 1 to 3600/
  );
});

test("heartbeat and cross-check grace configuration are bounded", () => {
  const heartbeat = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  heartbeat.listener.heartbeatSeconds = 1;
  assert.throws(() => validateConfig(heartbeat), /listener\.heartbeatSeconds must be from 2 to 300/);

  const grace = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  grace.marketData.crossCheckWaitMilliseconds = 10_001;
  assert.throws(
    () => validateConfig(grace),
    /marketData\.crossCheckWaitMilliseconds must be from 0 to 10000/
  );
});
