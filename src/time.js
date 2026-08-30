function localParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function localDateKey(value = new Date(), timeZone = "America/Los_Angeles") {
  const parts = localParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localMidnightUtc(year, month, day, timeZone) {
  return localDateTimeUtc(year, month, day, 0, 0, 0, timeZone);
}

function localDateTimeUtc(year, month, day, hour, minute, second, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - represented;
  }
  return new Date(guess);
}

function parseLocalClock(localTime) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(localTime ?? "13:00"));
  if (!match) throw new Error(`Invalid local market-close time: ${localTime}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local market-close time: ${localTime}`);
  return { hour, minute };
}

export function regularMarketCloseForDate(dateKey, timeZone = "America/Los_Angeles", localTime = "13:00") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new Error(`Invalid local date: ${dateKey}`);
  const { hour, minute } = parseLocalClock(localTime);
  return localDateTimeUtc(Number(match[1]), Number(match[2]), Number(match[3]), hour, minute, 0, timeZone);
}

export function utcRangeForLocalDate(dateKey, timeZone = "America/Los_Angeles") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new Error(`Invalid local date: ${dateKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = localMidnightUtc(year, month, day, timeZone);
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));
  const end = localMidnightUtc(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
    timeZone
  );
  return { start: start.toISOString(), end: end.toISOString() };
}
