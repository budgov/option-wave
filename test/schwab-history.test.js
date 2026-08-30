import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCausalIntradayFeatures,
  fetchSchwabIntradayFeatures,
  fetchSchwabMinuteClose,
  selectMinuteCandle
} from "../src/schwab-history.js";

test("selects the minute candle containing the target timestamp", () => {
  const start = Date.parse("2026-08-24T15:36:00.000Z");
  const candle = selectMinuteCandle([
    { datetime: start - 60_000, close: 706 },
    { datetime: start, close: 707.28 }
  ], "2026-08-24T15:36:44.113Z");
  assert.equal(candle.close, 707.28);
});

test("normalizes Schwab historical minute evidence without exposing OAuth", async () => {
  const start = Date.parse("2026-08-24T15:36:00.000Z");
  const result = await fetchSchwabMinuteClose("C:/ignored", "qqq", "2026-08-24T15:36:44.113Z", {
    getAccessToken: async () => "secret-token",
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      return {
        ok: true,
        json: async () => ({ candles: [{ datetime: start, open: 707.09, high: 707.31, low: 707.08, close: 707.28, volume: 88447 }] })
      };
    }
  });
  assert.equal(result.provider, "schwab");
  assert.equal(result.data_tier, "historical_1m");
  assert.equal(result.price, 707.28);
  assert.equal(result.observed_at, "2026-08-24T15:37:00.000Z");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("derives causal intraday features from completed regular-session candles only", () => {
  const candles = [];
  for (const date of ["2026-08-20", "2026-08-21", "2026-08-24"]) {
    const start = Date.parse(`${date}T13:30:00.000Z`);
    for (let minute = 0; minute < 6; minute += 1) {
      candles.push({
        datetime: start + minute * 60_000,
        open: 90 + minute,
        high: 90 + minute,
        low: 90 + minute,
        close: 90 + minute,
        volume: 50
      });
    }
  }
  const currentStart = Date.parse("2026-08-25T13:30:00.000Z");
  for (let minute = 0; minute < 6; minute += 1) {
    candles.push({
      datetime: currentStart + minute * 60_000,
      open: 100 + minute,
      high: 100 + minute,
      low: 100 + minute,
      close: 100 + minute,
      volume: 100
    });
  }
  // This candle had started but had not completed at the signal timestamp.
  candles.push({
    datetime: currentStart + 6 * 60_000,
    open: 999, high: 999, low: 999, close: 999, volume: 1_000_000
  });

  const result = deriveCausalIntradayFeatures(candles, "2026-08-25T13:36:30.000Z");
  assert.equal(result.provenance.market_phase, "regular");
  assert.equal(result.features.minutes_from_open, 6.5);
  assert.equal(result.features.minutes_to_close_total, 383.5);
  assert.equal(result.provenance.current_session_candles, 6);
  assert.equal(result.provenance.latest_completed_candle_end_at, "2026-08-25T13:36:00.000Z");
  assert.equal(result.features.vwap, 102.5);
  assert.ok(Math.abs(result.features.return_5m - 0.05) < 1e-12);
  assert.equal(result.features.return_15m, undefined);
  assert.equal(result.features.rvol, 2);
  assert.ok(result.features.realized_vol > 0);
  assert.ok(result.features.vwap < 200, "the incomplete future candle leaked into VWAP");
});

test("labels non-regular phases without clamping them into fake session minutes", () => {
  const premarket = deriveCausalIntradayFeatures([], "2026-08-25T12:00:00.000Z");
  assert.equal(premarket.provenance.market_phase, "premarket");
  assert.equal("minutes_from_open" in premarket.features, false);
  const afterHours = deriveCausalIntradayFeatures([], "2026-08-25T21:00:00.000Z");
  assert.equal(afterHours.provenance.market_phase, "after_hours");
  assert.equal("minutes_from_open" in afterHours.features, false);
});

test("fetches a bounded minute-history prefix without exposing OAuth", async () => {
  let requestedUrl;
  const result = await fetchSchwabIntradayFeatures(
    "C:/ignored",
    "coin",
    "2026-08-25T13:36:30.000Z",
    {
      accessToken: "secret-token",
      fetch: async (url, options) => {
        requestedUrl = url;
        assert.equal(options.headers.Authorization, "Bearer secret-token");
        return { ok: true, json: async () => ({ candles: [] }) };
      }
    }
  );
  assert.equal(requestedUrl.searchParams.get("symbol"), "COIN");
  assert.equal(requestedUrl.searchParams.get("frequencyType"), "minute");
  assert.equal(Number(requestedUrl.searchParams.get("endDate")), Date.parse("2026-08-25T13:36:30.000Z"));
  assert.equal(result.provenance.market_phase, "regular");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});
