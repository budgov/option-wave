import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { processMessage } from "../src/pipeline.js";

const config = loadConfig();
const workDir = path.join(config.__root, "work");
fs.mkdirSync(workDir, { recursive: true });
const database = path.join(workDir, "smoke-pipeline.sqlite");
for (const suffix of ["", "-shm", "-wal"]) {
  const filename = `${database}${suffix}`;
  if (fs.existsSync(filename)) fs.rmSync(filename);
}
const db = openDatabase(database);
try {
  const result = await processMessage(config, db, {
    channelKey: "go_finance",
    chatId: "smoke-chat",
    messageId: "1",
    publishedAt: "2026-08-16T16:00:00.000Z",
    receivedAt: "2026-08-16T16:00:01.000Z",
    rawText: "SMOKE 2026-09-18 100C buy 2 contracts, stop 40%",
    raw: { smoke_test: true }
  });
  if (result.luna?.schema_version !== "luna.v1") throw new Error("Luna pipeline smoke failed.");
  if (result.terra?.schema_version !== "terra.v1") throw new Error("Terra pipeline smoke failed.");
  if (result.terra.status === "scored") throw new Error("Text-only Terra output must not be scored.");
  console.log(JSON.stringify({
    raw_message_id: result.rawMessageId,
    luna: result.luna.classification,
    terra: result.terra.status
  }));
} finally {
  db.close();
}
