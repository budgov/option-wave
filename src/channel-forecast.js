import { appendIntradayEvent } from "./db.js";
import { localDateKey } from "./time.js";

const UP = /(?:看涨|上涨|上行|反弹|拉升|突破|走高|偏多|bullish|breakout|break\s+up|go(?:ing)?\s+up|higher)/i;
const DOWN = /(?:看跌|下跌|下行|回落|跳水|跌破|走低|偏空|bearish|breakdown|break\s+down|go(?:ing)?\s+down|lower)/i;
const FORWARD = /(?:预计|预测|预期|接下来|稍后|随后|将会|可能|应该|目标|看到|看至|今天|收盘|半小时|一小时|分钟|forecast|expect|likely|target|next|later|today|eod|will)/i;

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function horizonMinutes(text) {
  if (/(?:半小时|half\s+hour)/i.test(text)) return 30;
  if (/(?:一小时|1\s*(?:h|hr|hour))/i.test(text)) return 60;
  const match = text.match(/(?:未来|接下来|next)?\s*(\d{1,3})\s*(?:分钟|min(?:ute)?s?)/i);
  if (match) {
    const value = Number(match[1]);
    return value >= 1 && value <= 390 ? value : null;
  }
  return null;
}

export function detectChannelForecastCandidate(record) {
  const text = String(record?.rawText ?? record?.raw_text ?? "").replace(/\s+/g, " ").trim();
  const symbols = ["QQQ", "SPY"].filter((symbol) => new RegExp(`(?:^|[^A-Z])${symbol}(?:$|[^A-Z])`, "i").test(text));
  const up = UP.test(text);
  const down = DOWN.test(text);
  const direction = up === down ? null : up ? "up" : "down";
  const targetMatch = text.match(/(?:目标|target|看到|看至)\s*[:：@]?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const horizon = horizonMinutes(text);
  const endOfDay = /(?:收盘|今天|今日|eod|close)/i.test(text);
  const eligible = symbols.length > 0 && direction != null && FORWARD.test(text);
  return {
    schema_version: "channel-forecast-candidate.v1",
    eligible,
    symbols,
    direction,
    horizon_minutes: horizon,
    maturity_policy: horizon != null ? "fixed_minutes" : endOfDay ? "regular_close" : "unknown",
    target_price: targetMatch ? numberOrNull(targetMatch[1]) : null,
    raw_text: text,
    evidence: eligible ? text : null
  };
}

function verifiedForecasts(luna, candidate) {
  const verified = luna?.market_forecast;
  if (verified?.eligible !== true) return [];
  const symbols = Array.isArray(verified.symbols) ? verified.symbols.map((value) => String(value).toUpperCase()) : [];
  const allowed = symbols.filter((symbol) => new Set(["QQQ", "SPY"]).has(symbol));
  const direction = new Set(["up", "down", "flat"]).has(verified.direction) ? verified.direction : null;
  if (!allowed.length || direction == null) return [];
  const horizon = numberOrNull(verified.horizon_minutes);
  return allowed.map((symbol) => ({
    symbol,
    direction,
    horizon_minutes: horizon != null && horizon >= 1 && horizon <= 390 ? horizon : candidate.horizon_minutes,
    maturity_policy: verified.maturity_policy === "regular_close"
      ? "regular_close"
      : horizon != null || candidate.horizon_minutes != null ? "fixed_minutes" : candidate.maturity_policy,
    target_price: numberOrNull(verified.target_price) ?? candidate.target_price,
    confidence: numberOrNull(verified.confidence),
    evidence: verified.evidence ?? candidate.evidence
  }));
}

export function recordVerifiedChannelForecasts(config, db, record, rawMessageId, luna) {
  const candidate = detectChannelForecastCandidate(record);
  const forecasts = verifiedForecasts(luna, candidate);
  const eventAt = record.eventAt ?? record.event_at ?? record.editedAt ?? record.edited_at
    ?? record.publishedAt ?? record.published_at;
  const sessionDate = localDateKey(eventAt, config.intradayResearch?.marketTimeZone ?? "America/New_York");
  return forecasts.map((forecast) => {
    const forecastId = `channel-${Number(rawMessageId)}-${forecast.symbol}`;
    const maturesAt = forecast.horizon_minutes == null
      ? null
      : new Date(Date.parse(eventAt) + forecast.horizon_minutes * 60_000).toISOString();
    return appendIntradayEvent(db, {
      eventKey: `${forecastId}:open:v1`,
      sessionDate,
      eventType: "channel_forecast",
      symbol: forecast.symbol,
      source: `telegram:${record.channelKey ?? record.channel_key}`,
      eventAt,
      forecastId,
      maturesAt,
      payload: {
        schema_version: "channel-forecast.v1",
        raw_message_id: Number(rawMessageId),
        telegram_message_id: String(record.messageId ?? record.telegram_message_id),
        channel_key: record.channelKey ?? record.channel_key,
        ...forecast,
        excluded_from_option_statistics: true,
        process_policy: "dedicated_bounded_worker"
      }
    });
  });
}
