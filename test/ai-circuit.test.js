import assert from "node:assert/strict";
import test from "node:test";
import { classifyAiAvailabilityError, isAiCircuitOpen } from "../src/ai-circuit.js";

test("subscription quota errors preserve the provider reset timestamp", () => {
  const now = new Date("2026-08-19T13:00:00.000Z");
  const result = classifyAiAvailabilityError(
    new Error("You've reached your Codex subscription usage limit. Next reset in 4 days, Aug 23 at 6:18 AM PDT."),
    now
  );
  assert.equal(result.kind, "subscription_quota");
  assert.equal(result.retry_after, "2026-08-23T13:18:00.000Z");
  assert.equal(isAiCircuitOpen({ status: "open", retry_after: result.retry_after }, now.getTime()), true);
});

test("ordinary pipeline errors do not open the AI availability circuit", () => {
  assert.equal(classifyAiAvailabilityError(new Error("invalid JSON response")), null);
  assert.equal(isAiCircuitOpen({ status: "closed", retry_after: "2099-01-01T00:00:00.000Z" }), false);
});
