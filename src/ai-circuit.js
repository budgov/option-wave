const MONTHS = new Map([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11]
]);

export const AI_CIRCUIT_KEY = "openclaw_ai_circuit";

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout, error?.cause?.message]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function explicitReset(text, now) {
  const match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*(PDT|PST|UTC)\b/i);
  if (!match) return null;
  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  let hour = Number(match[3]) % 12;
  if (match[5].toUpperCase() === "PM") hour += 12;
  const minute = Number(match[4]);
  const offsetHours = match[6].toUpperCase() === "PDT" ? 7 : match[6].toUpperCase() === "PST" ? 8 : 0;
  let year = now.getUTCFullYear();
  let timestamp = Date.UTC(year, month, day, hour + offsetHours, minute);
  if (timestamp < now.getTime() - 24 * 60 * 60_000) {
    year += 1;
    timestamp = Date.UTC(year, month, day, hour + offsetHours, minute);
  }
  return new Date(timestamp);
}

function relativeReset(text, now) {
  const match = text.match(/reset\s+in\s+(\d+)\s*(minute|hour|day)s?/i);
  if (!match) return null;
  const units = { minute: 60_000, hour: 60 * 60_000, day: 24 * 60 * 60_000 };
  return new Date(now.getTime() + Number(match[1]) * units[match[2].toLowerCase()]);
}

export function classifyAiAvailabilityError(error, now = new Date()) {
  const text = errorText(error);
  const quota = /subscription usage limit|reached your [^.]{0,80}usage limit/i.test(text);
  const rateLimit = quota || /rate[_ -]?limit|too many requests|\b429\b/i.test(text);
  if (!rateLimit) return null;

  const parsedReset = explicitReset(text, now) ?? relativeReset(text, now);
  const fallbackDelay = quota ? 6 * 60 * 60_000 : 15 * 60_000;
  const retryAt = parsedReset ?? new Date(now.getTime() + fallbackDelay);
  const maximum = now.getTime() + 8 * 24 * 60 * 60_000;
  const boundedRetryAt = new Date(Math.min(Math.max(retryAt.getTime(), now.getTime() + 60_000), maximum));
  return {
    kind: quota ? "subscription_quota" : "rate_limit",
    retry_after: boundedRetryAt.toISOString(),
    summary: quota ? "Codex subscription usage limit reached" : "AI provider rate limit reached"
  };
}

export function isAiCircuitOpen(circuit, now = Date.now()) {
  return Boolean(circuit?.status === "open" && Number.isFinite(Date.parse(circuit.retry_after)) && Date.parse(circuit.retry_after) > now);
}
