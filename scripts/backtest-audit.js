import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import { buildBacktestReadiness, buildSignalLifecycles } from "../src/backtest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = openDatabase(path.join(root, "data", "ocean-wave.sqlite"));
const readiness = buildBacktestReadiness(db, ["meigu_baijialun", "go_finance"]);
const lifecycles = buildSignalLifecycles(db);
const outputs = path.join(root, "outputs");
fs.mkdirSync(outputs, { recursive: true });

const safeLifecycle = lifecycles.map((row) => ({
  signal_id: row.signal_id,
  channel_key: row.channel_key,
  published_at: row.published_at,
  symbol: row.symbol,
  expiry: row.expiry,
  strike: row.strike,
  option_type: row.option_type,
  side: row.side,
  parser_confidence: row.parser_confidence,
  follow_up_count: row.follow_ups.length,
  self_reported_outcome_count: row.self_reported_outcome_count,
  independently_verified_outcome: row.independently_verified_outcome
}));

fs.writeFileSync(path.join(outputs, "backtest-readiness.json"), JSON.stringify({ readiness, lifecycles: safeLifecycle }, null, 2));
const c = readiness.counts;
const channelLines = readiness.channels.map((r) => `| ${r.channel_key} | ${r.n} | ${r.first_at} | ${r.last_at} |`).join("\n") || "| — | 0 | — | — |";
const blockerLines = readiness.blockers.map((b) => `- \`${b.code}\`: ${b.detail}`).join("\n") || "- 无硬性阻塞。";
const report = `# Telegram 期权频道回测就绪性审计

生成时间：${readiness.generated_at}

## 结论

当前**不能形成可信的真实收益回测，也不允许训练或提升 Ocean-Wave 权重**。已解析 ${c.signals} 条期权信号；其中 ${c.self_reported_outcomes} 条存在频道自报结果，但独立验证结果为 ${c.independently_verified_outcomes}，点时期权市场快照为 ${c.point_in_time_snapshots}。

Fidelity 后台数据只自动校验标的价格，并在 Schwab 故障时提供标的级备援；它不能替代信号时刻的期权 bid/ask、Greeks、IV 曲面、成交和新闻快照。所有模型训练必须以数据源真实报价时间为准，并用可执行买卖价和费用计算结果。

## 覆盖

| 频道键 | 消息数 | 最早时间（UTC） | 最晚时间（UTC） |
|---|---:|---|---|
${channelLines}

| 指标 | 数量 |
|---|---:|
| 原始消息 | ${c.raw_messages} |
| Luna 成功记录 | ${c.luna_runs} |
| Terra 成功记录 | ${c.terra_runs} |
| Telegram 图片 | ${c.media_assets} |
| 视觉识别成功 | ${c.media_vision_ok} |
| 期权信号 | ${c.signals} |
| 合约四要素完整 | ${c.complete_contracts} |
| 明确 buy/sell | ${c.explicit_side} |
| 频道自报结果 | ${c.self_reported_outcomes} |
| 点时期权市场快照 | ${c.point_in_time_snapshots} |
| 独立验证结果 | ${c.independently_verified_outcomes} |

## 训练阻塞

${blockerLines}

## 已纳入的分析面

回测特征合同不只包含 Delta/Gamma/Theta/IV。它还覆盖：标的多周期价格/成交量/VWAP/实现波动率，完整期权链流动性与买卖盘，OI 变化与主动成交，波动率曲面/偏斜/期限结构/VRP，高阶 Greeks 与 dealer GEX，VIX/利率/信用/美元/商品/广度/相关与反向资产，以及财报、指引、SEC 文件、宏观日历、分析师变动、行业与公司新闻、事件惊喜度和信号发布延迟。

## 标签与验证规则

- 买入信号按 entry ask、exit bid；卖出信号按 entry bid、exit ask；扣除手续费与滑点。
- 记录 5/15/30/60 分钟、收盘、到期的净收益，以及 MFE/MAE 与 triple-barrier 标签。
- 频道“止盈/翻倍”仅保留为自报辅助证据，不替换独立价格标签。
- 使用 purged walk-forward；按 ticker × event/day 分组，按最大持有期 embargo；预处理、聚类和校准全部在训练折内完成。
- Ocean-Wave 只产生 challenger；达到样本、校准、成本压力和 shadow-run 闸门后，才可人工审批晋级。
`;
fs.writeFileSync(path.join(outputs, "backtest-readiness-report.md"), report);
console.log(JSON.stringify(readiness, null, 2));
