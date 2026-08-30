import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRawMessage, listMediaEvidence, openDatabase } from "../src/db.js";
import { ingestMessageMedia, mediaDescriptor } from "../src/media.js";

test("Telegram photos are hashed, stored, described, and deduplicated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-media-"));
  const db = openDatabase(path.join(root, "data", "audit.sqlite"));
  const raw = appendRawMessage(db, {
    channelKey: "x", chatId: "1", messageId: "2",
    publishedAt: "2026-08-16T10:00:00Z", receivedAt: "2026-08-16T10:00:01Z",
    rawText: "", raw: { has_media: true }
  });
  const config = {
    __root: root,
    media: {
      enabled: true, maxBytes: 1024, visionModel: "openai/gpt-5.6-luna"
    },
    openclaw: { agents: { luna: { model: "openai/gpt-5.6-luna" } } }
  };
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const client = { downloadMedia: async () => bytes };
  const message = { media: { className: "MessageMediaPhoto", photo: {} } };
  let calls = 0;
  const describe = async () => {
    calls += 1;
    return {
      envelope: { model: "openai/gpt-5.6-luna" },
      output: { schema_version: "media-vision.v1", visible_text: "SPY 600C", confidence: { overall: 0.9 } }
    };
  };
  const first = await ingestMessageMedia(config, db, client, raw.id, {
    channelKey: "x", messageId: "2"
  }, message, describe);
  const second = await ingestMessageMedia(config, db, client, raw.id, {
    channelKey: "x", messageId: "2"
  }, message, describe);
  assert.equal(first.newAnalysis, true);
  assert.equal(second.newAnalysis, false);
  assert.equal(calls, 1);
  const evidence = listMediaEvidence(db, raw.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].analysis.visible_text, "SPY 600C");
  assert.equal(evidence[0].analysis_status, "ok");
  assert.ok(fs.existsSync(path.join(root, evidence[0].storage_path)));
  assert.equal(fs.readdirSync(path.dirname(path.join(root, evidence[0].storage_path))).some((name) => name.endsWith(".vision.png")), false);
});

test("image documents are accepted and non-image documents are ignored", () => {
  assert.equal(mediaDescriptor({ media: { className: "MessageMediaDocument", document: { mimeType: "image/png" } } })?.mimeType, "image/png");
  assert.equal(mediaDescriptor({ media: { className: "MessageMediaDocument", document: { mimeType: "application/pdf" } } }), null);
});

test("media download failure preserves the text pipeline and remains retryable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-media-fail-"));
  const db = openDatabase(path.join(root, "data", "audit.sqlite"));
  try {
    const raw = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "3",
      publishedAt: "2026-08-16T10:00:00Z", receivedAt: "2026-08-16T10:00:01Z",
      rawText: "XYZ CALL 100", raw: { has_media: true }
    });
    const result = await ingestMessageMedia({ __root: root, media: { enabled: true } }, db, {
      downloadMedia: async () => { throw new Error("temporary download failure"); }
    }, raw.id, { channelKey: "x", messageId: "3" }, { media: { className: "MessageMediaPhoto", photo: {} } });
    assert.equal(result.retryable, true);
    assert.match(result.error, /temporary download failure/);
    assert.equal(listMediaEvidence(db, raw.id).length, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quota mode saves an image once and defers vision without redownloading", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-media-deferred-"));
  const db = openDatabase(path.join(root, "data", "audit.sqlite"));
  try {
    const raw = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "4",
      publishedAt: "2026-08-16T10:00:00Z", receivedAt: "2026-08-16T10:00:01Z",
      rawText: "", raw: { has_media: true }
    });
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    let downloads = 0;
    let descriptions = 0;
    const client = { downloadMedia: async () => { downloads += 1; return bytes; } };
    const message = { media: { className: "MessageMediaPhoto", photo: {} } };
    const config = {
      __root: root,
      media: {
        enabled: true, maxBytes: 1024
      },
      openclaw: { agents: { luna: { model: "test" } } }
    };
    const describe = async () => {
      descriptions += 1;
      return { envelope: { model: "test" }, output: { schema_version: "media-vision.v1" } };
    };
    const deferred = await ingestMessageMedia(
      config, db, client, raw.id, { channelKey: "x", messageId: "4" }, message, describe, { analyze: false }
    );
    assert.equal(deferred.analysisDeferred, true);
    assert.equal(descriptions, 0);
    assert.equal(downloads, 1);
    assert.equal(deferred.evidence[0].analysis_status, "pending");
    await ingestMessageMedia(config, db, client, raw.id, { channelKey: "x", messageId: "4" }, message, describe);
    assert.equal(descriptions, 1);
    assert.equal(downloads, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
