import readline from "node:readline";

const MAX_MESSAGES = 4;
let messages = 0;
let initialized = false;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("forecast must be an object");
  const symbol = String(input.symbol ?? "").toUpperCase();
  const direction = String(input.direction ?? "").toLowerCase();
  const horizonMinutes = finite(input.horizonMinutes ?? input.horizon_minutes);
  if (!new Set(["QQQ", "SPY"]).has(symbol)) throw new Error("unsupported channel forecast symbol");
  if (!new Set(["up", "down", "flat"]).has(direction)) throw new Error("unsupported channel forecast direction");
  if (!(horizonMinutes >= 1 && horizonMinutes <= 390)) throw new Error("channel forecast horizon is not scoreable");
  return {
    schemaVersion: "isolated-channel-forecast.v1",
    symbol,
    direction,
    horizonMinutes,
    expectedReturn: finite(input.expectedReturn ?? input.expected_return),
    expectedPrice: finite(input.target_price ?? input.expectedPrice ?? input.expected_price),
    probabilityUp: finite(input.probability_up),
    confidence: finite(input.confidence),
    maturityPolicy: input.maturity_policy ?? "fixed_minutes",
    evidenceHash: input.evidence_hash ?? null,
    sourceEventId: finite(input.source_event_id),
    researchOnly: true
  };
}

emit({ schema_version: "intraday-channel-worker.v1", event: "ready", pid: process.pid, research_only: true });

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try {
    if (Buffer.byteLength(line, "utf8") > 128 * 1024) throw new Error("request exceeds 128 KiB");
    request = JSON.parse(line);
    messages += 1;
    if (messages > MAX_MESSAGES) throw new Error("worker request limit exceeded");
    if (request.command === "shutdown") {
      emit({ id: request.id, ok: true, result: { status: "stopping" } });
      lines.close();
      return;
    }
    if (request.command !== "initialize" || initialized) throw new Error("unsupported worker state transition");
    initialized = true;
    emit({ id: request.id, ok: true, result: normalize(request.forecast) });
  } catch (error) {
    emit({ id: request?.id ?? null, ok: false, error: String(error?.message ?? error).slice(0, 500) });
  } finally {
    request = null;
  }
});

lines.once("close", () => {
  setImmediate(() => process.exit(0));
});
