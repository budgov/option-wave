import assert from "node:assert/strict";
import test from "node:test";
import { applySourceSemantics, applyTerraSourceSemantics, sourceExitFraction } from "../src/source-semantics.js";

const config = { channelSemantics: { source: { entryAction: "buy_to_open", exitAction: "sell_to_close", rule: "test" } } };
const configured = { channelSemantics: { source: {
  entryAction: "buy_to_open", exitAction: "sell_to_close",
  entryAtPriceMeaning: "source_reported_fill",
  missingExpiryPolicy: "nearest_listed_expiry",
  profitControlPolicy: "half_remaining_each_signal",
  rule: "test"
} } };

test("source policy makes opening signals buy to open", () => {
  const output = applySourceSemantics(config, { channelKey: "source", rawText: "买 SPY call" }, {
    classification: "options_signal", contract: { symbol: "SPY", side: null }
  });
  assert.equal(output.contract.side, "buy");
  assert.equal(output.contract.open_action, "buy_to_open");
  assert.deepEqual(output.source_semantics.applied_fields, ["contract.side=buy", "contract.open_action=buy_to_open"]);
});

test("exit percentages and 盈利自控 close a fraction of the currently remaining position", () => {
  assert.equal(sourceExitFraction({ rawText: "止盈50% @3.28" }, { lifecycle_action: "sell_to_close" }), 0.5);
  assert.equal(sourceExitFraction({ rawText: "止盈25% @3.28" }, { lifecycle_action: "sell_to_close" }), 0.25);
  assert.equal(sourceExitFraction({ rawText: "盈利自控" }, { lifecycle_action: "sell_to_close" }), 0.5);
  assert.equal(sourceExitFraction({ rawText: "卖出50%仓位 @3.28" }, { lifecycle_action: "sell_to_close" }), 0.5);
  assert.equal(sourceExitFraction({ rawText: "止盈50%仓位 @3.28" }, { lifecycle_action: "sell_to_close" }), 0.5);
  assert.equal(sourceExitFraction({ rawText: "出掉一半" }, { lifecycle_action: "sell_to_close" }), 0.5);
  assert.equal(sourceExitFraction({ rawText: "清掉@3.20" }, { lifecycle_action: "sell_to_close" }), null);
  assert.equal(sourceExitFraction({ rawText: "止盈50%" }, { classification: "non_signal" }), null);
});

test("source policy marks stop, target, and double language as sell to close", () => {
  for (const rawText of ["止损离场", "止盈", "翻倍兑现", "take profit", "清掉@0.94", "全部走掉了"]) {
    const output = applySourceSemantics(config, { channelKey: "source", rawText }, { classification: "update", contract: {} });
    assert.equal(output.lifecycle_action, "sell_to_close");
  }
});

test("source policy is idempotent for an already normalized record", () => {
  const first = applySourceSemantics(config, { channelKey: "source", rawText: "买 SPY call" }, {
    classification: "options_signal", contract: { symbol: "SPY", side: null }
  });
  assert.equal(applySourceSemantics(config, { channelKey: "source", rawText: "买 SPY call" }, first), first);
});

test("source policy does not turn long commentary into a close action", () => {
  const output = applySourceSemantics(config, { channelKey: "source", rawText: `如果行情回落，需要严格止损，但这是一段市场风险教育说明。${"风险 ".repeat(20)}` }, {
    classification: "non_signal", contract: {}
  });
  assert.equal(output.lifecycle_action, undefined);
});

test("source policy treats @price as a claimed fill and resolves undated contracts downstream", () => {
  const output = applySourceSemantics(configured, { channelKey: "source", rawText: "GOOGL CALL 345 @1.22" }, {
    classification: "options_signal",
    contract: { symbol: "GOOGL", expiry: null, strike: 345, option_type: "call", entry_price: { value: 1.22, kind: "reference_limit", raw: "1.22" } }
  });
  assert.equal(output.contract.entry_price.kind, "source_reported_fill");
  assert.equal(output.contract.entry_execution_state, "claimed_fill");
  assert.equal(output.contract.expiry_resolution.policy, "nearest_listed_expiry");
});

test("source policy normalizes 盈利自控 as a half-of-remaining sell-to-close point", () => {
  const output = applySourceSemantics(configured, { channelKey: "source", rawText: "盈利自控", replyToMessageId: "10" }, {
    classification: "update", contract: {}, lifecycle: {}
  });
  assert.equal(output.classification, "outcome");
  assert.equal(output.lifecycle_action, "sell_to_close");
  assert.equal(output.lifecycle.kind, "profit_control");
  assert.equal(output.lifecycle.execution_state, "partial_exit");
  assert.equal(output.lifecycle.exit_fraction_of_remaining, 0.5);
});

test("source policy records a reported post-add average cost", () => {
  const output = applySourceSemantics(configured, {
    channelKey: "source", rawText: "補倉目前成本價@0.25", replyToMessageId: "10"
  }, { classification: "update", contract: {}, lifecycle: {} }, {
    explicit: true, classification: "update", action: "buy_to_open", action_kind: "add", average_cost: 0.25
  });
  assert.equal(output.lifecycle.kind, "add");
  assert.equal(output.lifecycle.average_cost, 0.25);
  assert.equal(output.lifecycle.execution_state, "reported_position_update");
});

test("source policy treats an explicit exit @price as a claimed source fill", () => {
  const output = applySourceSemantics(configured, {
    channelKey: "source", rawText: "止盈50% @3.28", replyToMessageId: "10"
  }, {
    classification: "outcome", lifecycle_action: "sell_to_close",
    lifecycle: { kind: "take_profit", reference_exit_price: 3.28, execution_state: "instruction" }
  });
  assert.equal(output.lifecycle.reference_exit_price, 3.28);
  assert.equal(output.lifecycle.execution_state, "claimed_fill");
  assert.ok(output.source_semantics.applied_fields.includes("lifecycle.execution_state=claimed_fill"));
});

test("Terra normalization cannot reject an explicit source exit fill because of a delayed quote", () => {
  const output = applyTerraSourceSemantics(configured, {
    channelKey: "source", rawText: "止盈50% @3.28"
  }, {
    classification: "outcome", lifecycle_action: "sell_to_close"
  }, {
    schema_version: "terra.v1",
    contract_analysis: { observed_facts: {}, inference: {
      source_exit_price_verification: "unverified",
      reference_price_vs_quote: "The stated price was above the ask."
    } },
    inference: { unverified_alternatives: ["The stated price could be a desired limit rather than a fill."] },
    risk: { inference: { principal_risks: ["The stated exit was not executable and not a verified fill."] } },
    confidence: {}, provenance: {}
  }, {
    target_contract: { matched: { bid: 3.15, ask: 3.25, quote_timestamp: "2026-08-20T18:29:49Z" } }
  });
  assert.equal(output.execution_semantics.source_reported_price, 3.28);
  assert.equal(output.execution_semantics.accepted_as_executable, true);
  assert.equal(output.contract_analysis.observed_facts.execution_state, "claimed_fill");
  assert.equal(output.contract_analysis.inference.source_exit_price_verification, "accepted_source_reported_fill");
  assert.deepEqual(output.inference.unverified_alternatives, []);
  assert.deepEqual(output.risk.inference.principal_risks, []);
});

test("an explicit deterministic close survives a model non-signal miss", () => {
  const output = applySourceSemantics(configured, {
    channelKey: "source", rawText: "清掉@0.94"
  }, {
    schema_version: "luna.v1", classification: "non_signal", contract: {}, lifecycle: {}
  }, {
    schema_version: "signal-hint.v2", classification: "outcome", explicit: true,
    action: "sell_to_close", action_kind: "exit", reference_exit_price: 0.94,
    execution_state: "claimed_fill", contract: null
  });
  assert.equal(output.classification, "outcome");
  assert.equal(output.lifecycle_action, "sell_to_close");
  assert.equal(output.lifecycle.reference_exit_price, 0.94);
  assert.equal(output.lifecycle.execution_state, "claimed_fill");
});
