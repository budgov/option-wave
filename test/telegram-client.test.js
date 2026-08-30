import assert from "node:assert/strict";
import test from "node:test";
import { latestMessageId, messagesAfter, subscribeMessages } from "../src/telegram-client.js";

test("cursor polling only returns newer messages in chronological order", async () => {
  const client = {
    getMessages: async (_entity, options) => {
      assert.equal(options.minId, 10);
      assert.equal(options.reverse, true);
      return [{ id: 12 }, { id: 9 }, { id: 11 }];
    }
  };
  const messages = await messagesAfter(client, { entity: "a" }, 10);
  assert.deepEqual(messages.map((message) => message.id), [11, 12]);
});

test("latest cursor establishes a baseline without processing old messages", async () => {
  const client = {
    getMessages: async (_entity, options) => {
      assert.equal(options.limit, 1);
      return [{ id: 88 }];
    }
  };
  assert.equal(await latestMessageId(client, { entity: "a" }), 88);
});

test("subscription resolves safe builders and filters by numeric peer id", async () => {
  const handlers = [];
  const builders = [];
  const client = {
    addEventHandler(handler, builder) { handlers.push(handler); builders.push(builder); },
    removeEventHandler() {}
  };
  const seen = [];
  await subscribeMessages(client, [{ key: "a", entity: { id: "123" }, chatId: "-100123", displayName: "A" }], (record) => {
    seen.push(`${record.channelKey}:${record.messageId}`);
  });
  assert.equal(builders.length, 2);
  assert.equal(builders[0].chats, undefined);
  assert.equal(builders[0].resolved, true);
  await handlers[0]({ message: { id: 7, peerId: { channelId: "123" }, date: new Date("2026-01-01T00:00:00Z"), message: "ok" } });
  await handlers[0]({ message: { id: 8, peerId: { channelId: "999" }, date: new Date("2026-01-01T00:00:00Z"), message: "skip" } });
  assert.deepEqual(seen, ["a:7"]);
});

test("a rejected Telegram event error reporter is contained", async () => {
  const handlers = [];
  const client = {
    addEventHandler(handler) { handlers.push(handler); },
    removeEventHandler() {}
  };
  const originalError = console.error;
  const errors = [];
  console.error = (message) => { errors.push(String(message)); };
  try {
    await subscribeMessages(
      client,
      [{ key: "a", entity: { id: "123" }, chatId: "-100123", displayName: "A" }],
      () => { throw new Error("message callback failed"); },
      async () => { throw new Error("reporter failed"); }
    );
    await handlers[0]({
      message: {
        id: 9,
        peerId: { channelId: "123" },
        date: new Date("2026-01-01T00:00:00Z"),
        message: "bad callback"
      }
    });
    assert.ok(errors.some((message) => message.includes("Telegram event error handler failed: reporter failed")));
  } finally {
    console.error = originalError;
  }
});
