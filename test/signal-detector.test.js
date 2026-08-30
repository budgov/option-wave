import test from "node:test";
import assert from "node:assert/strict";
import { detectSignalHint, isResearchOnlyOptionCommentary } from "../src/signal-detector.js";

function record(rawText, replyToMessageId = null) {
  return { rawText, replyToMessageId, publishedAt: "2026-08-17T16:00:00.000Z" };
}

test("detects common buy-to-open option formats without relying on the AI service", () => {
  const cases = [
    ["Buy XYZ 8/17 123 Put@市价", "XYZ", "2026-08-17", 123, "put"],
    ["ABC PUT 45 @0.37", "ABC", null, 45, "put"],
    ["DEF CALL 520 8/17 @1.6", "DEF", "2026-08-17", 520, "call"],
    ["$GHI Put $77 8/18 @0.75", "GHI", "2026-08-18", 77, "put"]
  ];
  for (const [text, symbol, expiry, strike, optionType] of cases) {
    const hint = detectSignalHint(record(text));
    assert.equal(hint.classification, "options_signal", text);
    assert.equal(hint.action, "buy_to_open", text);
    assert.equal(hint.contract.symbol, symbol, text);
    assert.equal(hint.contract.expiry, expiry, text);
    assert.equal(hint.contract.strike, strike, text);
    assert.equal(hint.contract.option_type, optionType, text);
    if (hint.contract.entry_price_raw && hint.contract.entry_price_raw !== "市价") {
      assert.equal(hint.contract.price_kind, "source_reported_fill", text);
      assert.equal(hint.contract.entry_execution_state, "claimed_fill", text);
    }
  }
  const undated = detectSignalHint(record("ABC PUT 45 @0.37"));
  assert.deepEqual(undated.contract.expiry_resolution, { policy: "nearest_listed_expiry", resolved_expiry: null });
});

test("detects additions, take profit, and stop loss as lifecycle actions", () => {
  const addition = detectSignalHint(record("加仓进去，新的均价0.29", "10"));
  assert.equal(addition.classification, "update");
  assert.equal(addition.action, "buy_to_open");
  assert.equal(addition.reply_to_message_id, "10");

  for (const text of ["可以止盈", "止损", "0.15止损了", "翻倍兑现", "sell to close", "清掉@0.94", "全部走掉了", "跑光了"]) {
    const hint = detectSignalHint(record(text, "10"));
    assert.equal(hint.classification, "outcome", text);
    assert.equal(hint.action, "sell_to_close", text);
  }
  assert.equal(detectSignalHint(record("0.15止损了", "10")).execution_state, "claimed_fill");
  assert.equal(detectSignalHint(record("0.15止损了", "10")).reference_exit_price, 0.15);
  assert.equal(detectSignalHint(record("止盈50% @3.28", "10")).execution_state, "claimed_fill");
  assert.equal(detectSignalHint(record("止盈50% @3.28", "10")).reference_exit_price, 3.28);
  assert.equal(detectSignalHint(record("清掉@0.94")).reference_exit_price, 0.94);
  assert.equal(detectSignalHint(record("清掉@0.94")).execution_state, "claimed_fill");
  assert.equal(detectSignalHint(record("上周加仓后的XYZ@1.30可以止盈", "9")).contract.symbol, "XYZ");
  const profitControl = detectSignalHint(record("盈利自控", "10"));
  assert.equal(profitControl.action_kind, "profit_control");
  assert.equal(profitControl.execution_state, "source_reported_fill_candidate");
});

test("does not turn broad market commentary into an option order", () => {
  const cases = [
    "市场可能冲高，远月 call 8000 有大单，但这里只做观察。",
    `今天讨论 FOMC 和 call 8000 的结构。${"这只是盘面分析，不是交易指令。".repeat(12)}如果条件变化再考虑每天加仓。`
  ];
  for (const text of cases) {
    const hint = detectSignalHint(record(text));
    assert.equal(hint.classification, "non_signal", text);
    assert.equal(hint.explicit, false, text);
    assert.equal(hint.contract, null, text);
  }
});

test("routes sell-put strategy prose and long option research away from intraday workflows", () => {
  const sellPut = record("我也布局了下几个星期sell put soxl 70-80 这些位置。继续躺平放松，风险可以接受");
  assert.equal(isResearchOnlyOptionCommentary(sellPut, detectSignalHint(sellPut)), true);
  const longResearch = record(`MRVL财报后看好，在220附近做了SP@SEP18。${"研究背景 ".repeat(15)}`);
  assert.equal(isResearchOnlyOptionCommentary(longResearch, detectSignalHint(longResearch)), true);
  const explicit = record("PLTR Put 182.5 9/4 @3.00");
  assert.equal(isResearchOnlyOptionCommentary(explicit, detectSignalHint(explicit)), false);
});

test("does not flag hypothetical or policy language as an executed exit", () => {
  for (const text of ["如果翻倍可以考虑分批", "今天把止盈线提高", "行情波动时要严格止损"]) {
    assert.equal(detectSignalHint(record(text)).classification, "non_signal", text);
  }
});

test("an unclassified short reply is queued for human interpretation", () => {
  const hint = detectSignalHint(record("先跑一点", "10"));
  assert.equal(hint.classification, "non_signal");
  assert.equal(hint.needs_human_interpretation, true);
  assert.equal(hint.uncertainty_reason, "unclassified_reply");
  const commentary = detectSignalHint(record("这是一段普通的长篇市场评论，没有明确操作。"));
  assert.equal(commentary.needs_human_interpretation, false);
});
