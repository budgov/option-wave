import assert from "node:assert/strict";
import test from "node:test";
import { fetchEquityMarketHours, normalizeEquityMarketHours } from "../src/schwab-market-hours.js";

const openPayload = {
  equity: {
    EQ: {
      date: "2026-08-24",
      marketType: "EQUITY",
      isOpen: true,
      sessionHours: {
        regularMarket: [{ start: "2026-08-24T09:30:00-04:00", end: "2026-08-24T16:00:00-04:00" }]
      }
    }
  }
};

test("normalizes authoritative regular equity hours", () => {
  assert.deepEqual(normalizeEquityMarketHours(openPayload, "2026-08-24"), {
    date: "2026-08-24",
    is_open: true,
    regular_open: "2026-08-24T13:30:00.000Z",
    regular_close: "2026-08-24T20:00:00.000Z",
    source: "schwab"
  });
});

test("market holidays fail closed", () => {
  const result = normalizeEquityMarketHours({ equity: { EQ: { date: "2026-12-25", marketType: "EQUITY", isOpen: false } } }, "2026-12-25");
  assert.equal(result.is_open, false);
  assert.equal(result.regular_open, null);
});

test("fetches the market date in New York without leaking the token", async () => {
  const result = await fetchEquityMarketHours("C:/ignored", {
    at: new Date("2026-08-24T12:00:00.000Z"),
    getAccessToken: async () => "secret",
    fetchImpl: async (url, options) => {
      assert.equal(url.searchParams.get("date"), "2026-08-24");
      assert.equal(options.headers.Authorization, "Bearer secret");
      return { ok: true, json: async () => openPayload };
    }
  });
  assert.equal(result.is_open, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
