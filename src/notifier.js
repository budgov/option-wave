import { loadNotifierSecrets, hasNotifierSecrets } from "./secrets.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function isEnabled(config) {
  return config.notifications?.telegram?.enabled === true;
}

function clip(text, maxLength = 3500) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20)}\n...[truncated]`;
}

function formatError(error) {
  const text = error?.stack ?? error?.message ?? String(error);
  return clip(text, 1800);
}

export function formatLocalTime(config, value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const timezone = config.timezone ?? "America/Los_Angeles";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(date);
}

async function postTelegramMessage({ token, chatId, text, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: clip(text),
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(`Telegram bot send failed (${response.status}): ${body.description ?? response.statusText}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function createNotifier(config, { logger = console } = {}) {
  if (!isEnabled(config)) return { enabled: false, send: async () => false };
  if (!hasNotifierSecrets(config.__root)) {
    logger.warn("Telegram bot notifications enabled but notifier secrets are missing.");
    return { enabled: false, send: async () => false };
  }
  const secrets = loadNotifierSecrets(config.__root);
  const minIntervalMs = Number(config.notifications?.telegram?.minIntervalMs ?? 0);
  let lastSentAt = 0;

  async function send(kind, message) {
    const now = Date.now();
    if (minIntervalMs > 0 && now - lastSentAt < minIntervalMs && kind !== "fatal") return false;
    lastSentAt = now;
    try {
      await postTelegramMessage({
        token: secrets.telegramBotToken,
        chatId: secrets.telegramChatId,
        text: message,
        timeoutMs: Number(config.notifications?.telegram?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
      return true;
    } catch (error) {
      logger.error(`Notifier error: ${error.message}`);
      return false;
    }
  }

  return { enabled: true, send };
}

export function signalNotification(config, record, result) {
  const luna = result.luna;
  const contract = luna?.contract ?? {};
  const resolvedExpiry = contract.expiry
    ?? result.marketSnapshot?.target_contract?.resolved?.expiry
    ?? null;
  const inferredExpiry = !contract.expiry && resolvedExpiry != null;
  const parts = [
    `Ocean-Wave new ${luna?.classification ?? "message"}`,
    `${record.channelKey} #${record.messageId}`,
    `time: ${formatLocalTime(config, record.publishedAt)}`
  ];
  if (contract.symbol || resolvedExpiry || contract.strike || contract.option_type) {
    parts.push(`contract: ${contract.symbol ?? "?"} ${resolvedExpiry ?? "?"}${inferredExpiry ? " (nearest listed)" : ""} ${contract.strike ?? "?"}${contract.option_type ? ` ${contract.option_type}` : ""}`);
  }
  const entryPrice = typeof contract.entry_price === "object" ? contract.entry_price?.value : contract.entry_price;
  if (entryPrice != null) parts.push(`source fill: ${entryPrice}`);
  if (contract.open_action || luna?.lifecycle_action) {
    parts.push(`action: ${luna.lifecycle_action ?? contract.open_action}`);
  }
  if (result.terra?.status) parts.push(`terra: ${result.terra.status}`);
  const assessment = result.marketSnapshot?.contract_assessment;
  if (assessment?.decision === "abstain") {
    parts.push(`score: abstain${assessment.reasons?.length ? ` (${assessment.reasons.join(", ")})` : ""}`);
  } else if (Number.isFinite(Number(assessment?.contract_score))) {
    parts.push(`contract score: ${Number(assessment.contract_score).toFixed(4)} (${assessment.decision ?? "unknown"})`);
  }
  if (result.media?.length) parts.push(`media: ${result.media.length}`);
  return parts.join("\n");
}

export function interpretationNotification(config, record, request) {
  const snapshot = request?.marketSnapshot ?? {};
  const matched = snapshot?.target_contract?.matched;
  const parts = [
    "Ocean-Wave 等待人工解释",
    `${record.channelKey} #${record.messageId}`,
    `time: ${formatLocalTime(config, record.publishedAt)}`,
    `reason: ${request?.reason ?? "language_intent_ambiguous"}`
  ];
  const rawText = String(record.rawText ?? "").replace(/\s+/g, " ").trim();
  if (rawText) parts.push(`message: ${clip(rawText, 500)}`);
  parts.push(`market saved: ${snapshot?.provider ?? "unknown"}/${snapshot?.data_tier ?? "unknown"}`);
  if (snapshot?.observed_at) parts.push(`quote time: ${formatLocalTime(config, snapshot.observed_at)}`);
  if (matched) {
    parts.push(`captured contract: ${matched.expiry ?? "?"} ${matched.strike ?? "?"} ${matched.option_type ?? "?"} bid ${matched.bid ?? "?"} / ask ${matched.ask ?? "?"}`);
  }
  parts.push("请告诉我这条消息表示开仓、加仓、止盈、止损、清仓，还是非信号；在解释前不会猜方向或生成分数。");
  return parts.join("\n");
}

export function captureNotification(config, record, hint, source = "telegram", { aiPausedUntil = null } = {}) {
  const contract = hint?.contract ?? {};
  const parts = [
    aiPausedUntil ? "Ocean-Wave 已捕获，AI 将稍后补分析" : "Ocean-Wave 已捕获，AI 分析中",
    `${record.channelKey} #${record.messageId}`,
    `time: ${formatLocalTime(config, record.publishedAt)}`,
    `action: ${hint?.action ?? hint?.classification ?? "message"}`
  ];
  if (contract.symbol || contract.expiry || contract.strike || contract.option_type) {
    parts.push(`contract: ${contract.symbol ?? "?"} ${contract.expiry ?? "?"} ${contract.strike ?? "?"}${contract.option_type ? ` ${contract.option_type}` : ""}`);
  }
  const rawText = String(record.rawText ?? "").replace(/\s+/g, " ").trim();
  if (rawText) parts.push(`message: ${clip(rawText, 500)}`);
  parts.push(`capture: ${source}`);
  if (aiPausedUntil) parts.push(`AI resume after: ${aiPausedUntil}`);
  return parts.join("\n");
}

export function exceptionNotification(scope, error) {
  return [
    "Ocean-Wave abnormal event",
    `scope: ${scope}`,
    formatError(error)
  ].join("\n");
}
