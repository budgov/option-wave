import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendAnalysis,
  appendLifecycleReview,
  appendPositionWorkflowEvent,
  appendRawMessage,
  listEffectiveLifecycleReviews,
  listDailyInputs,
  listDailyLifecycleReviews,
  openDatabase
} from "../src/db.js";
import { partitionDailyInputs, readyUnreportedDates, scheduledDailyDates, validateSolReport } from "../src/daily.js";
import { recoverDailyReportArtifact } from "../src/cli.js";

test("daily catch-up selects only fully analyzed unreported local dates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daily-"));
  const db = openDatabase(path.join(root, "daily.sqlite"));
  try {
    const complete = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "1",
      publishedAt: "2026-08-18T18:00:00.000Z", receivedAt: "2026-08-18T18:00:01.000Z",
      rawText: "commentary", raw: { has_media: false }
    });
    appendAnalysis(db, {
      rawMessageId: complete.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok",
      input: {}, output: { schema_version: "luna.v1", classification: "non_signal" }
    });
    appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "2",
      publishedAt: "2026-08-19T18:00:00.000Z", receivedAt: "2026-08-19T18:00:01.000Z",
      rawText: "pending", raw: { has_media: false }
    });
    assert.deepEqual(readyUnreportedDates(db, "America/Los_Angeles", "2026-08-19"), ["2026-08-18"]);
    assert.deepEqual(scheduledDailyDates(db, "America/Los_Angeles", "2026-08-19"), []);
    db.prepare("INSERT INTO daily_reports(report_date,created_at,model,input_manifest_json,report_json) VALUES(?,?,?,?,?)")
      .run("2026-08-18", new Date().toISOString(), "test", "{}", "{}");
    assert.deepEqual(readyUnreportedDates(db, "America/Los_Angeles", "2026-08-19"), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daily Sol validation requires the requested date, complete shape, and a safe decision", () => {
  const valid = {
    schema_version: "sol.v1",
    report_date: "2026-08-25",
    coverage: {},
    lifecycle_links: [],
    style_profile: {},
    performance_bias: {},
    data_quality: {},
    candidate_change: {},
    evaluation_gate: {},
    decision: "collect_more_data"
  };
  assert.equal(validateSolReport(valid, "2026-08-25"), true);
  assert.match(validateSolReport({ ...valid, report_date: "2026-08-24" }, "2026-08-25"), /report_date/);
  assert.match(validateSolReport({ ...valid, decision: "promote" }, "2026-08-25"), /unsupported decision/);
  const incomplete = { ...valid };
  delete incomplete.coverage;
  assert.match(validateSolReport(incomplete, "2026-08-25"), /missing required keys/);
});

test("a committed daily report atomically restores a missing or corrupt output artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daily-artifact-"));
  const db = openDatabase(path.join(root, "data", "daily.sqlite"));
  const reportDate = "2026-08-28";
  const report = {
    schema_version: "sol.v1",
    report_date: reportDate,
    coverage: {},
    lifecycle_links: [],
    style_profile: {},
    performance_bias: {},
    data_quality: {},
    candidate_change: {},
    evaluation_gate: {},
    decision: "collect_more_data"
  };
  try {
    db.prepare("INSERT INTO daily_reports(report_date,created_at,model,input_manifest_json,report_json) VALUES(?,?,?,?,?)")
      .run(reportDate, new Date().toISOString(), "test", "{}", JSON.stringify(report));
    const outputDir = path.join(root, "outputs");
    fs.mkdirSync(outputDir, { recursive: true });
    const filename = path.join(outputDir, `ocean-wave-daily-${reportDate}.json`);
    fs.writeFileSync(filename, "{interrupted", "utf8");

    const first = recoverDailyReportArtifact(db, root, reportDate);
    assert.equal(first.recovered, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), report);
    assert.equal(fs.existsSync(`${filename}.tmp`), false);

    const second = recoverDailyReportArtifact(db, root, reportDate);
    assert.equal(second.recovered, false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daily model inputs contain option trades while market commentary stays in a secondary archive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daily-scope-"));
  const db = openDatabase(path.join(root, "daily.sqlite"));
  try {
    const signal = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "10",
      publishedAt: "2026-08-21T15:00:00.000Z", receivedAt: "2026-08-21T15:00:01.000Z",
      rawText: "MSTR 125 Call 8/28 @3.80", raw: { has_media: false }
    });
    appendAnalysis(db, {
      rawMessageId: signal.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "options_signal", contract: { symbol: "MSTR", expiry: "2026-08-28", strike: 125, option_type: "call" } }
    });
    appendAnalysis(db, {
      rawMessageId: signal.id, stage: "terra", schemaVersion: "terra.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "terra.v1", status: "scored", inference: { why_now: "option flow" } }
    });
    const update = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "11", replyToMessageId: "10",
      publishedAt: "2026-08-21T16:00:00.000Z", receivedAt: "2026-08-21T16:00:01.000Z",
      rawText: "过夜", raw: { has_media: false }
    });
    appendAnalysis(db, {
      rawMessageId: update.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "update", lifecycle_action: "hold_overnight", follow_up: { parent_message_id: "10" } }
    });
    const context = appendRawMessage(db, {
      channelKey: "x", chatId: "1", messageId: "12",
      publishedAt: "2026-08-21T17:00:00.000Z", receivedAt: "2026-08-21T17:00:01.000Z",
      rawText: "大盘在压力位，留意午后走势", raw: { has_media: false }
    });
    appendAnalysis(db, {
      rawMessageId: context.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "non_signal" }
    });

    const rows = listDailyInputs(db, "2026-08-21T07:00:00.000Z", "2026-08-22T07:00:00.000Z").map((row) => ({
      raw_message_id: row.raw_message_id,
      channel_key: row.channel_key,
      published_at: row.published_at,
      raw_text: row.raw_text,
      stage: row.stage,
      schema_version: row.schema_version,
      output: row.output_json ? JSON.parse(row.output_json) : null
    }));
    const partitioned = partitionDailyInputs(db, rows, []);
    assert.deepEqual(
      [...new Set(partitioned.optionTradeRecords.map((row) => row.raw_message_id))].sort((a, b) => a - b),
      [signal.id, update.id]
    );
    assert.deepEqual(
      [...new Set(partitioned.secondaryMarketContext.map((row) => row.raw_message_id))],
      [context.id]
    );
    assert.equal(JSON.stringify(partitioned.optionTradeRecords).includes("大盘在压力位"), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daily inputs use the final Telegram edit time and latest successful stage exactly once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daily-edits-"));
  const db = openDatabase(path.join(root, "daily.sqlite"));
  try {
    const base = {
      channelKey: "meigu_baijialun", chatId: "-1002059", messageId: "2059",
      publishedAt: "2026-08-20T23:55:00.000Z", receivedAt: "2026-08-20T23:55:01.000Z",
      replyToMessageId: "2058", raw: { has_media: false }
    };
    const original = appendRawMessage(db, { ...base, rawText: "清掉@0.90" });
    appendAnalysis(db, {
      rawMessageId: original.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { reference_exit_price: 0.90 } }
    });

    const editedAt = "2026-08-21T08:30:00.000Z";
    const edited = appendRawMessage(db, {
      ...base, rawText: "清掉@0.94", editedAt, receivedAt: "2026-08-21T08:30:01.000Z"
    });
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { reference_exit_price: 0.93 } }
    });
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close", lifecycle: { reference_exit_price: 0.94 } }
    });
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "terra", schemaVersion: "terra.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "terra.v1", status: "scored", inference: { why_now: "superseded" } }
    });
    appendAnalysis(db, {
      rawMessageId: edited.id, stage: "terra", schemaVersion: "terra.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "terra.v1", status: "scored", inference: { why_now: "canonical" } }
    });

    assert.equal(listDailyInputs(db, "2026-08-20T23:00:00.000Z", "2026-08-21T00:00:00.000Z").length, 0);
    const rows = listDailyInputs(db, "2026-08-21T08:00:00.000Z", "2026-08-21T09:00:00.000Z");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.raw_message_id), [edited.id, edited.id]);
    assert.deepEqual(rows.map((row) => row.stage), ["luna", "terra"]);
    assert.ok(rows.every((row) => row.published_at === editedAt));
    assert.ok(rows.every((row) => row.source_published_at === base.publishedAt));
    assert.equal(JSON.parse(rows[0].output_json).lifecycle.reference_exit_price, 0.94);
    assert.equal(JSON.parse(rows[1].output_json).inference.why_now, "canonical");
    assert.deepEqual(readyUnreportedDates(db, "America/Los_Angeles", "2026-08-21"), ["2026-08-21"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daily statistics use the latest full-close message without double-counting an earlier close", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-daily-final-exit-"));
  const db = openDatabase(path.join(root, "daily.sqlite"));
  try {
    const base = {
      channelKey: "meigu_baijialun", chatId: "-1002070",
      publishedAt: "2026-08-25T13:36:39.000Z", receivedAt: "2026-08-25T13:36:40.000Z",
      raw: { has_media: false }
    };
    const signal = appendRawMessage(db, {
      ...base, messageId: "2070", rawText: "COIN Put 175 8/28 @2.90"
    });
    appendAnalysis(db, {
      rawMessageId: signal.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "options_signal", contract: { symbol: "COIN", expiry: "2026-08-28", strike: 175, option_type: "put" } }
    });
    const first = appendRawMessage(db, {
      ...base, messageId: "2072", replyToMessageId: "2070", rawText: "止盈50% @3.68",
      publishedAt: "2026-08-25T14:00:00.000Z", receivedAt: "2026-08-25T14:00:01.000Z"
    });
    const final = appendRawMessage(db, {
      ...base, messageId: "2073", replyToMessageId: "2070", rawText: "清掉止盈了@4.80",
      publishedAt: "2026-08-25T14:15:00.000Z", receivedAt: "2026-08-25T14:15:01.000Z"
    });
    for (const [row, price, grossReturn, holdMinutes] of [
      [first, 3.68, 0.84, 10],
      [final, 4.80, 1.40, 20]
    ]) {
      appendAnalysis(db, {
        rawMessageId: row.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: row.id === first.id
        ? { schema_version: "luna.v1", classification: "update", follow_up: { parent_message_id: "2070" }, lifecycle: { reference_exit_price: price } }
        : { schema_version: "luna.v1", classification: "outcome", lifecycle_action: "sell_to_close", follow_up: { parent_message_id: "2070" }, lifecycle: { reference_exit_price: price } }
      });
      appendLifecycleReview(db, {
        signalRawMessageId: signal.id, exitRawMessageId: row.id, reviewVersion: "lifecycle-review.v1.2",
        inputManifest: { exit: row.id }, status: "scored",
        review: {
          schema_version: "lifecycle-review.v1.2",
          status: "scored",
          exit: { hold_minutes: holdMinutes },
          execution_check: { exit_execution_price: price, gross_executable_return: grossReturn }
        }
      });
    }

    const asOfBeforeCorrection = listEffectiveLifecycleReviews(db, {
      asOfExclusive: "2026-08-25T14:10:00.000Z"
    });
    assert.deepEqual(asOfBeforeCorrection.map((row) => Number(row.exit_raw_message_id)), [first.id]);

    const editedSignal = appendRawMessage(db, {
      ...base,
      messageId: "2070",
      rawText: "COIN Put 175 8/28 @2.90（已确认）",
      editedAt: "2026-08-25T14:20:00.000Z",
      receivedAt: "2026-08-25T14:20:01.000Z"
    });
    appendAnalysis(db, {
      rawMessageId: editedSignal.id, stage: "luna", schemaVersion: "luna.v1", model: "test", status: "ok", input: {},
      output: { schema_version: "luna.v1", classification: "options_signal", contract: { symbol: "COIN", expiry: "2026-08-28", strike: 175, option_type: "put" } }
    });

    const start = "2026-08-25T07:00:00.000Z";
    const end = "2026-08-26T07:00:00.000Z";
    const lifecycleRows = listDailyLifecycleReviews(db, start, end).map((row) => ({
      raw_message_id: Number(row.exit_raw_message_id),
      signal_raw_message_id: Number(row.signal_raw_message_id),
      channel_key: row.channel_key,
      published_at: row.published_at,
      raw_text: row.raw_text,
      stage: "lifecycle",
      schema_version: row.review_version,
      output: JSON.parse(row.review_json)
    }));
    assert.deepEqual(lifecycleRows.map((row) => row.raw_message_id), [final.id]);

    const analysisRows = listDailyInputs(db, start, end).map((row) => ({
      raw_message_id: row.raw_message_id,
      channel_key: row.channel_key,
      published_at: row.published_at,
      raw_text: row.raw_text,
      stage: row.stage,
      schema_version: row.schema_version,
      output: row.output_json ? JSON.parse(row.output_json) : null
    }));
    const partitioned = partitionDailyInputs(db, analysisRows, lifecycleRows);
    const optionIds = new Set(partitioned.optionTradeRecords.map((row) => row.raw_message_id));
    assert.equal(optionIds.has(first.id), false);
    assert.equal(optionIds.has(final.id), true);
    assert.equal(optionIds.has(editedSignal.id), true);
    assert.deepEqual(partitioned.supersededOptionRawIds, [first.id]);
    assert.equal(partitioned.secondaryMarketContext.some((row) => row.raw_message_id === first.id), false);

    appendPositionWorkflowEvent(db, {
      eventKey: "position:2070:partial:2072",
      workflowId: "position:2070",
      signalRawMessageId: signal.id,
      exitRawMessageId: first.id,
      eventType: "partial_exit",
      payload: { portfolio_fraction: 0.5 }
    });
    const aggregated = listDailyLifecycleReviews(db, start, end);
    assert.deepEqual(aggregated.map((row) => Number(row.exit_raw_message_id)), [final.id]);
    const effectiveReview = JSON.parse(aggregated[0].review_json);
    assert.equal(effectiveReview.status, "scored");
    assert.equal(effectiveReview.partial_exit_aggregation.legs.length, 2);
    assert.ok(Math.abs(effectiveReview.execution_check.exit_execution_price - 4.24) < 1e-12);
    assert.ok(Math.abs(effectiveReview.execution_check.gross_executable_return - 1.12) < 1e-12);
    assert.equal(effectiveReview.exit.hold_minutes, 15);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
