import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRawMessage, getOperationalState, openDatabase } from "../src/db.js";
import { AI_CIRCUIT_KEY } from "../src/ai-circuit.js";
import { channelCursor, createMessageCoordinator, initializeCursorBaselines, pollChannelsOnce } from "../src/listener.js";

function tempDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-listener-"));
  return openDatabase(path.join(root, "listener.sqlite"));
}

const config = {
  channelSemantics: { source: { entryAction: "buy_to_open", exitAction: "sell_to_close" } },
  notifications: { telegram: { enabled: false } },
  listener: { maxQueuedMessages: 250 },
  marketData: { primary: "none" }
};
const notifier = { send: async () => true };
const record = {
  channelKey: "source", chatId: "-1001", messageId: "11",
  publishedAt: "2026-08-17T16:00:00.000Z", receivedAt: "2026-08-17T16:00:00.100Z",
  editedAt: null, replyToMessageId: null, rawText: "XYZ CALL 100 8/21 @1.00", raw: { has_media: false }
};

test("raw message and cursor are durable before a slow AI worker finishes", async () => {
  const db = tempDatabase();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const coordinator = createMessageCoordinator({
    config, db, client: {}, notifier,
    logger: { log() {}, error() {} },
    marketCapture: async (_config, _hint, publishedAt) => ({
      schema_version: "market-snapshot.v1", provider: "none", data_tier: "text_only",
      as_of: publishedAt, captured_at: publishedAt, execution_eligible: false
    }),
    processor: async () => { await blocked; return { duplicate: false, luna: { classification: "non_signal" }, media: [] }; }
  });
  coordinator.schedule(record, {}, "test");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM signal_hints").get().n, 1);
  assert.equal(channelCursor(db, "source"), 11);
  release();
  await coordinator.drain();
  db.close();
});

test("preliminary quote is durable before history/prediction and only an explicit entry primes", async () => {
  const db = tempDatabase();
  let releasePrediction;
  const delayedPrediction = new Promise((resolve) => { releasePrediction = resolve; });
  const primed = [];
  const publishedAt = new Date().toISOString();
  const preliminary = {
    schema_version: "ocean-wave-snapshot.v2",
    provider: "schwab",
    data_tier: "realtime_underlying",
    signal_published_at: publishedAt,
    observed_at: publishedAt,
    captured_at: publishedAt,
    capture_stage: "preliminary_quote",
    market_state: { spot: 100 }
  };
  const final = {
    ...preliminary,
    data_tier: "realtime",
    capture_stage: "prediction_final",
    target_contract: {
      matched: { bid: 1, ask: 1.1, quote_timestamp: publishedAt },
      exact_expiry_match: true,
      exact_strike_match: true,
      exact_option_type_match: true
    },
    ocean_wave: { native_core: true, expectations: { "5.0": { horizon_minutes: 5, probability_up: 0.55 } } }
  };
  const coordinator = createMessageCoordinator({
    config,
    db,
    client: {},
    notifier,
    logger: { log() {}, error() {} },
    positionWorkflows: {
      async prime(request) { primed.push(request); return { status: "primed" }; }
    },
    marketCapture: async (_config, _hint, _publishedAt, context) => {
      context.onPreliminarySnapshot(preliminary);
      await delayedPrediction;
      return final;
    },
    processor: async () => ({ duplicate: false, luna: { classification: "options_signal" }, media: [] })
  });
  coordinator.schedule({ ...record, publishedAt, receivedAt: publishedAt }, {}, "test");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_snapshots").get().n, 1);
  assert.equal(primed.length, 0);
  releasePrediction();
  await coordinator.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_snapshots").get().n, 2);
  assert.equal(primed.length, 1);
  assert.equal(primed[0].hint.classification, "options_signal");

  coordinator.schedule({
    ...record,
    messageId: "12",
    publishedAt,
    receivedAt: publishedAt,
    rawText: "大盘今天波动不大"
  }, {}, "test");
  await coordinator.drain();
  assert.equal(primed.length, 1, "non-signal text must never prime a position workflow");
  db.close();
});

test("edited-message intake logs signed clock delta while transport latency stays nonnegative", async () => {
  const db = tempDatabase();
  const logs = [];
  const coordinator = createMessageCoordinator({
    config,
    db,
    client: {},
    notifier,
    logger: { log(message) { logs.push(message); }, error() {} },
    marketCapture: async (_config, _hint, publishedAt) => ({
      schema_version: "market-snapshot.v2",
      provider: "none",
      data_tier: "text_only",
      observed_at: null,
      as_of: publishedAt,
      captured_at: publishedAt,
      execution_eligible: false
    }),
    processor: async () => ({ duplicate: false, luna: { classification: "non_signal" }, media: [] })
  });
  coordinator.schedule({
    ...record,
    messageId: "79",
    receivedAt: "2026-08-17T16:00:00.100Z",
    editedAt: "2026-08-17T16:00:00.500Z"
  }, {}, "edited_event");
  await coordinator.drain();
  assert.ok(logs.some((message) => message.includes("transport=0ms clock_delta=-400ms")));
  db.close();
});

test("first start sets a no-history baseline and later polls only the gap", async () => {
  const db = tempDatabase();
  const channel = { key: "source", entity: "source", chatId: "-1001", displayName: "Source" };
  const client = {
    getMessages: async (_entity, options) => {
      if (options.limit === 1) return [{ id: 20 }];
      assert.equal(options.minId, 20);
      return [{ id: 21, date: new Date("2026-08-17T16:01:00.000Z"), message: "next" }];
    }
  };
  assert.deepEqual(await initializeCursorBaselines(db, client, [channel]), [{ channel_key: "source", message_id: 20 }]);
  const seen = [];
  await pollChannelsOnce(db, client, [channel], (next) => {
    seen.push(next.messageId);
    // The production scheduler advances synchronously; mirror it here.
    db.prepare("UPDATE operational_state SET value=? WHERE key=?").run(JSON.stringify({ message_id: Number(next.messageId) }), "telegram_cursor:source");
  });
  assert.deepEqual(seen, ["21"]);
  db.close();
});

test("a burst is fully persisted while per-channel AI remains blocked", async () => {
  const db = tempDatabase();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let snapshotStarts = 0;
  const coordinator = createMessageCoordinator({
    config, db, client: {}, notifier,
    logger: { log() {}, error() {} },
    marketCapture: async (_config, _hint, publishedAt) => {
      snapshotStarts += 1;
      return { schema_version: "market-snapshot.v1", provider: "none", data_tier: "text_only", as_of: publishedAt, captured_at: publishedAt };
    },
    processor: async () => { await blocked; return { duplicate: false, luna: { classification: "non_signal" }, media: [] }; }
  });
  for (let id = 1; id <= 100; id += 1) {
    coordinator.schedule({ ...record, messageId: String(id), rawText: `XYZ CALL ${100 + id} 8/21 @1.00` }, {}, "burst");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 100);
  assert.equal(snapshotStarts, 100);
  release();
  await coordinator.drain();
  db.close();
});

test("an unclassified reply starts a point-in-time market capture before AI interpretation", async () => {
  const db = tempDatabase();
  const captures = [];
  const coordinator = createMessageCoordinator({
    config, db, client: {}, notifier,
    logger: { log() {}, error() {} },
    marketCapture: async (_config, marketInput, publishedAt) => {
      captures.push({ symbol: marketInput.contract?.symbol, publishedAt });
      return {
        schema_version: "market-snapshot.v2", provider: "schwab", data_tier: "realtime",
        as_of: publishedAt, observed_at: publishedAt, captured_at: publishedAt,
        target_contract: { requested: marketInput.contract, matched: null }
      };
    },
    processor: async () => ({ duplicate: false, luna: { classification: "non_signal" }, media: [] })
  });
  coordinator.schedule({ ...record, messageId: "70" }, {}, "test");
  await coordinator.drain();
  coordinator.schedule({
    ...record, messageId: "71", replyToMessageId: "70", rawText: "先跑一点",
    publishedAt: "2026-08-17T16:01:00.000Z", receivedAt: "2026-08-17T16:01:00.050Z"
  }, {}, "test");
  await coordinator.drain();
  assert.equal(captures.length, 2);
  assert.equal(captures[1].symbol, "XYZ");
  assert.equal(captures[1].publishedAt, "2026-08-17T16:01:00.000Z");
  db.close();
});

test("the in-memory AI queue is bounded without dropping durable messages", async () => {
  const db = tempDatabase();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let processed = 0;
  const coordinator = createMessageCoordinator({
    config: { ...config, listener: { maxQueuedMessages: 10 } },
    db, client: {}, notifier,
    logger: { log() {}, error() {} },
    processor: async () => {
      processed += 1;
      await blocked;
      return { duplicate: false, luna: { classification: "non_signal" }, media: [] };
    }
  });
  for (let id = 1; id <= 25; id += 1) {
    coordinator.schedule({ ...record, messageId: String(id), rawText: `XYZ CALL ${100 + id} 8/21 @1.00` }, {}, "burst");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 25);
  assert.equal(coordinator.queuedCount(), 10);
  release();
  await coordinator.drain();
  assert.equal(processed, 10);
  db.close();
});

test("pending retry reuses the existing raw row", async () => {
  const db = tempDatabase();
  let calls = 0;
  const channel = { key: "source", entity: "source", chatId: "-1001", displayName: "Source" };
  const client = {
    getMessages: async () => [{
      id: 11,
      date: new Date(record.publishedAt),
      editDate: null,
      message: record.rawText,
      media: null
    }]
  };
  const coordinator = createMessageCoordinator({
    config, db, client, notifier,
    logger: { log() {}, error() {} },
    processor: async () => {
      calls += 1;
      return { duplicate: false, luna: { classification: "non_signal" }, media: [] };
    }
  });
  coordinator.schedule(record, {}, "test");
  await coordinator.drain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 1);
  assert.equal(await coordinator.retryPending([channel]), 1);
  await coordinator.drain();
  assert.equal(calls, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 1);
  db.close();
});

test("pending retries are bounded per channel and do not replay signal alerts", async () => {
  const db = tempDatabase();
  const notices = [];
  const pending = [
    { ...record, channelKey: "source", messageId: "31" },
    { ...record, channelKey: "source", messageId: "32" },
    { ...record, channelKey: "other", messageId: "41" }
  ];
  for (const item of pending) appendRawMessage(db, item);
  const channels = [
    { key: "source", entity: "source", chatId: "-1001", displayName: "Source" },
    { key: "other", entity: "other", chatId: "-1002", displayName: "Other" }
  ];
  const coordinator = createMessageCoordinator({
    config,
    db,
    client: {
      getMessages: async (_entity, { ids }) => [{
        id: ids, date: new Date(record.publishedAt), editDate: null,
        message: record.rawText, media: null
      }]
    },
    notifier: { send: async (type, message) => { notices.push({ type, message }); return true; } },
    logger: { log() {}, error() {} },
    processor: async () => ({
      duplicate: false,
      luna: { classification: "options_signal", contract: { symbol: "XYZ" } },
      media: []
    })
  });
  assert.equal(await coordinator.retryPending(channels, 2), 2);
  await coordinator.drain();
  assert.equal(notices.filter(({ type }) => type === "signal").length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analysis_runs").get().n, 0);
  db.close();
});

test("pending repair never queues behind active live work in the same channel", async () => {
  const db = tempDatabase();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  appendRawMessage(db, { ...record, messageId: "51" });
  const channel = { key: "source", entity: "source", chatId: "-1001", displayName: "Source" };
  const coordinator = createMessageCoordinator({
    config,
    db,
    client: { getMessages: async () => [] },
    notifier,
    logger: { log() {}, error() {} },
    processor: async () => {
      await blocked;
      return { duplicate: false, luna: { classification: "non_signal" }, media: [] };
    }
  });
  coordinator.schedule({ ...record, messageId: "52" }, {}, "new_event");
  assert.equal(await coordinator.retryPending([channel], 2), 0);
  release();
  await coordinator.drain();
  db.close();
});

test("shutdown stops new scheduling but drains work already accepted", async () => {
  const db = tempDatabase();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const coordinator = createMessageCoordinator({
    config, db, client: {}, notifier,
    logger: { log() {}, error() {} },
    processor: async () => {
      await blocked;
      return { duplicate: false, luna: { classification: "non_signal" }, media: [] };
    }
  });
  coordinator.schedule(record, {}, "test");
  coordinator.stopAccepting();
  const rejected = coordinator.schedule({ ...record, messageId: "12" }, {}, "test");
  assert.deepEqual(rejected, { queued: false, stopping: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_messages").get().n, 1);
  release();
  await coordinator.drain();
  db.close();
});

test("a rejected notification neither emits an unhandled rejection nor poisons the channel queue", async () => {
  const db = tempDatabase();
  const unhandled = [];
  const errors = [];
  let processorCalls = 0;
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const coordinator = createMessageCoordinator({
      config: { ...config, listener: { maxQueuedMessages: 250, analysisAlertAfterAttempts: 1 } },
      db,
      client: {},
      notifier: {
        send: async (kind) => {
          if (kind === "capture" || kind === "error") throw new Error(`notification ${kind} failed`);
          return true;
        }
      },
      logger: { log() {}, error(message) { errors.push(message); } },
      marketCapture: async (_config, _hint, publishedAt) => ({
        schema_version: "market-snapshot.v2",
        provider: "none",
        data_tier: "text_only",
        observed_at: null,
        as_of: publishedAt,
        captured_at: publishedAt,
        execution_eligible: false
      }),
      processor: async () => {
        processorCalls += 1;
        if (processorCalls === 1) throw new Error("first analysis failed");
        return { duplicate: false, luna: { classification: "options_signal", contract: { symbol: "XYZ" } }, media: [] };
      }
    });
    coordinator.schedule({ ...record, messageId: "81" }, {}, "test");
    coordinator.schedule({ ...record, messageId: "82" }, {}, "test");
    await coordinator.drain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processorCalls, 2);
    assert.equal(unhandled.length, 0);
    assert.ok(errors.some((message) => message.includes("Capture notification error")));
    assert.ok(errors.some((message) => message.includes("Channel task failure")));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    db.close();
  }
});

test("an account quota opens one persistent circuit and defers queued AI work", async () => {
  const db = tempDatabase();
  let processorCalls = 0;
  let mediaCaptureCalls = 0;
  const notices = [];
  const quota = new Error("You've reached your Codex subscription usage limit. Next reset in 4 days.");
  const coordinator = createMessageCoordinator({
    config, db, client: {},
    notifier: { send: async (type, message) => { notices.push({ type, message }); return true; } },
    logger: { log() {}, error() {} },
    mediaCapture: async () => {
      mediaCaptureCalls += 1;
      return { evidence: [], newAnalysis: false, error: null };
    },
    processor: async () => {
      processorCalls += 1;
      throw quota;
    }
  });
  coordinator.schedule(record, {}, "test");
  coordinator.schedule({ ...record, messageId: "12" }, {}, "test");
  await coordinator.drain();
  const circuit = getOperationalState(db, AI_CIRCUIT_KEY);
  assert.equal(processorCalls, 1);
  assert.equal(mediaCaptureCalls, 1);
  assert.equal(circuit.status, "open");
  assert.equal(coordinator.analysisStatus().status, "paused");
  assert.ok(Date.parse(circuit.retry_after) > Date.now() + 3 * 24 * 60 * 60_000);
  assert.equal(notices.filter(({ message }) => message.includes("AI 深度分析暂时暂停")).length, 1);
  db.close();
});
