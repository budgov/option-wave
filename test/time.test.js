import assert from "node:assert/strict";
import test from "node:test";
import { localDateKey, utcRangeForLocalDate } from "../src/time.js";

test("late Pacific messages stay in the same local Sol day", () => {
  assert.equal(localDateKey("2026-08-18T06:30:00.000Z", "America/Los_Angeles"), "2026-08-17");
  assert.deepEqual(utcRangeForLocalDate("2026-08-17", "America/Los_Angeles"), {
    start: "2026-08-17T07:00:00.000Z",
    end: "2026-08-18T07:00:00.000Z"
  });
});

test("Pacific DST transition produces the correct 25-hour local day", () => {
  assert.deepEqual(utcRangeForLocalDate("2026-11-01", "America/Los_Angeles"), {
    start: "2026-11-01T07:00:00.000Z",
    end: "2026-11-02T08:00:00.000Z"
  });
});
