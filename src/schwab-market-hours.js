import { getSchwabAccessToken } from "./schwab-oauth.js";

const MARKET_HOURS_URL = "https://api.schwabapi.com/marketdata/v1/markets";

function walk(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Object.hasOwn(value, "isOpen") || value.sessionHours) output.push(value);
  for (const child of Object.values(value)) walk(child, output);
  return output;
}
function localDateKey(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

export function normalizeEquityMarketHours(payload, requestedDate) {
  const candidates = walk(payload).filter((candidate) => {
    const label = `${candidate.marketType ?? ""} ${candidate.product ?? ""} ${candidate.productName ?? ""} ${candidate.category ?? ""}`;
    return /equity|stock|eq/i.test(label) || candidate.sessionHours?.regularMarket;
  });
  const candidate = candidates.find((item) => item.date === requestedDate) ?? candidates[0];
  if (!candidate) throw new Error("Schwab market-hours response did not contain an equity session");
  if (candidate.isOpen !== true) {
    return { date: requestedDate, is_open: false, regular_open: null, regular_close: null, source: "schwab" };
  }
  const regular = candidate.sessionHours?.regularMarket?.[0];
  const start = regular?.start;
  const end = regular?.end;
  if (!Number.isFinite(Date.parse(start ?? "")) || !Number.isFinite(Date.parse(end ?? ""))) {
    throw new Error("Schwab reported an open equity session without regular-market boundaries");
  }
  return {
    date: requestedDate,
    is_open: true,
    regular_open: new Date(start).toISOString(),
    regular_close: new Date(end).toISOString(),
    source: "schwab"
  };
}

export async function fetchEquityMarketHours(root, {
  at = new Date(),
  timeZone = "America/New_York",
  getAccessToken = getSchwabAccessToken,
  fetchImpl = fetch
} = {}) {
  const date = localDateKey(at, timeZone);
  const token = await getAccessToken(root);
  const url = new URL(MARKET_HOURS_URL);
  url.searchParams.set("markets", "equity");
  url.searchParams.set("date", date);
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Schwab market hours failed (${response.status})`);
  return normalizeEquityMarketHours(payload, date);
}
