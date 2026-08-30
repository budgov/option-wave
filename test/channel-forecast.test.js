import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectChannelForecastCandidate, recordVerifiedChannelForecasts } from "../src/channel-forecast.js";
import { listIntradayEvents, openDatabase } from "../src/db.js";

test("detects explicit QQQ and SPY forecasts but not ordinary commentary", () => {
  const forecast = detectChannelForecastCandidate({ rawText: "预计接下来30分钟 QQQ 会突破上涨" });
  assert.equal(forecast.eligible, true);
  assert.deepEqual(forecast.symbols, ["QQQ"]);
  assert.equal(forecast.direction, "up");
  assert.equal(forecast.horizon_minutes, 30);
  assert.equal(detectChannelForecastCandidate({ rawText: "QQQ currently 700" }).eligible, false);
  assert.equal(detectChannelForecastCandidate({ rawText: "AAPL 看涨" }).eligible, false);
});

test("records only Luna-verified channel forecasts on a separate data plane", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-channel-forecast-"));
  const db = openDatabase(path.join(root, "test.sqlite"));
  const config = { intradayResearch: { marketTimeZone: "America/New_York" } };
  const record = {
    channelKey: "go_finance", messageId: "100", publishedAt: "2026-08-24T14:00:00.000Z",
    rawText: "预计接下来30分钟 QQQ 上涨"
  };
  const ignored = recordVerifiedChannelForecasts(config, db, record, 1, { market_forecast: { eligible: false } });
  assert.equal(ignored.length, 0);
  recordVerifiedChannelForecasts(config, db, record, 1, {
    market_forecast: {
      eligible: true, symbols: ["QQQ"], direction: "up", horizon_minutes: 30,
      maturity_policy: "fixed_minutes", target_price: 701, confidence: 0.8, evidence: "QQQ 上涨"
    }
  });
  const events = listIntradayEvents(db, { eventType: "channel_forecast" });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "telegram:go_finance");
  assert.equal(events[0].payload.excluded_from_option_statistics, true);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
