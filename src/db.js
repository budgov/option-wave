import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const APPEND_ONLY_TABLES = [
  "raw_messages",
  "signal_hints",
  "media_assets",
  "media_analyses",
  "analysis_runs",
  "interpretation_events",
  "market_snapshots",
  "lifecycle_reviews",
  "position_workflow_events",
  "model_feedback",
  "outcomes",
  "daily_reports",
  "intraday_events"
];
const SCHEMA_VERSION = 3;

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    PRAGMA wal_autocheckpoint=1000;
    PRAGMA cache_size=-8192;
    PRAGMA temp_store=MEMORY;
  `);
  const currentVersion = Number(db.prepare("PRAGMA user_version").get().user_version ?? 0);
  if (currentVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`);
  }
  migrate(db);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
  db.exec("PRAGMA optimize;");
  return db;
}

export function checkpointAndCloseDatabase(db) {
  db.exec("PRAGMA optimize;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY,
      channel_key TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      edited_at TEXT,
      reply_to_message_id TEXT,
      raw_text TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(telegram_chat_id, telegram_message_id, content_hash)
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY,
      raw_message_id INTEGER REFERENCES raw_messages(id),
      stage TEXT NOT NULL CHECK(stage IN ('luna','terra','sol')),
      schema_version TEXT NOT NULL,
      model TEXT NOT NULL,
      session_key TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS signal_hints (
      id INTEGER PRIMARY KEY,
      raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      detector_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      hint_json TEXT NOT NULL,
      UNIQUE(raw_message_id, detector_version)
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      id INTEGER PRIMARY KEY,
      raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      media_index INTEGER NOT NULL,
      telegram_kind TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(raw_message_id, media_index, sha256)
    );

    CREATE TABLE IF NOT EXISTS media_analyses (
      id INTEGER PRIMARY KEY,
      media_asset_id INTEGER NOT NULL REFERENCES media_assets(id),
      schema_version TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY,
      raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      captured_at TEXT NOT NULL,
      as_of TEXT NOT NULL,
      data_tier TEXT NOT NULL,
      provider TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interpretation_events (
      id INTEGER PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('pending','resolved','dismissed')),
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY,
      signal_id TEXT NOT NULL,
      label_version TEXT NOT NULL,
      matured_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      outcome_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lifecycle_reviews (
      id INTEGER PRIMARY KEY,
      signal_raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      exit_raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      created_at TEXT NOT NULL,
      review_version TEXT NOT NULL,
      input_manifest_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      review_json TEXT NOT NULL,
      UNIQUE(signal_raw_message_id, exit_raw_message_id, review_version, input_manifest_hash)
    );

    CREATE TABLE IF NOT EXISTS position_workflow_events (
      id INTEGER PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      signal_raw_message_id INTEGER NOT NULL REFERENCES raw_messages(id),
      exit_raw_message_id INTEGER REFERENCES raw_messages(id),
      event_type TEXT NOT NULL,
      process_role TEXT,
      process_pid INTEGER,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_feedback (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      feedback_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      feedback_json TEXT NOT NULL,
      UNIQUE(workflow_id, feedback_version)
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY,
      report_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model TEXT NOT NULL,
      input_manifest_json TEXT NOT NULL,
      report_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intraday_events (
      id INTEGER PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      session_date TEXT NOT NULL,
      event_type TEXT NOT NULL,
      symbol TEXT,
      source TEXT NOT NULL,
      event_at TEXT NOT NULL,
      forecast_id TEXT,
      matures_at TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operational_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS raw_messages_channel_published
      ON raw_messages(channel_key, published_at, id);
    CREATE INDEX IF NOT EXISTS raw_messages_source_latest
      ON raw_messages(telegram_chat_id, telegram_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS raw_messages_source_version
      ON raw_messages(telegram_chat_id, telegram_message_id, version DESC, id DESC);
    CREATE INDEX IF NOT EXISTS raw_messages_event_at
      ON raw_messages(COALESCE(edited_at,published_at), id);
    CREATE INDEX IF NOT EXISTS analysis_runs_message_stage
      ON analysis_runs(raw_message_id, stage, status, id DESC);
    CREATE INDEX IF NOT EXISTS signal_hints_message
      ON signal_hints(raw_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS media_assets_message
      ON media_assets(raw_message_id, media_index, id);
    CREATE INDEX IF NOT EXISTS media_analyses_asset
      ON media_analyses(media_asset_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS market_snapshots_message
      ON market_snapshots(raw_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS interpretation_events_message
      ON interpretation_events(raw_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS lifecycle_reviews_signal_exit
      ON lifecycle_reviews(signal_raw_message_id, exit_raw_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS position_workflow_events_workflow
      ON position_workflow_events(workflow_id, id DESC);
    CREATE INDEX IF NOT EXISTS position_workflow_events_signal
      ON position_workflow_events(signal_raw_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS position_workflow_events_type_signal_exit
      ON position_workflow_events(event_type, signal_raw_message_id, exit_raw_message_id);
    CREATE INDEX IF NOT EXISTS model_feedback_workflow
      ON model_feedback(workflow_id, id DESC);
    CREATE INDEX IF NOT EXISTS outcomes_signal_label
      ON outcomes(signal_id, label_version, id DESC);
    CREATE INDEX IF NOT EXISTS intraday_events_session_type
      ON intraday_events(session_date, event_type, event_at, id);
    CREATE INDEX IF NOT EXISTS intraday_events_forecast
      ON intraday_events(forecast_id, event_type, id);
    CREATE INDEX IF NOT EXISTS intraday_events_maturity
      ON intraday_events(event_type, matures_at, symbol, id);

    CREATE VIEW IF NOT EXISTS latest_raw_messages AS
      SELECT r.*,
             COALESCE(r.edited_at,r.published_at) AS event_at
      FROM raw_messages r
      WHERE r.id=(
        SELECT candidate.id FROM raw_messages candidate
        WHERE candidate.telegram_chat_id=r.telegram_chat_id
          AND candidate.telegram_message_id=r.telegram_message_id
        ORDER BY candidate.version DESC,candidate.id DESC
        LIMIT 1
      );

    CREATE VIEW IF NOT EXISTS latest_successful_analysis_runs AS
      SELECT a.*
      FROM analysis_runs a
      JOIN latest_raw_messages r ON r.id=a.raw_message_id
      WHERE a.status='ok'
        AND a.id=(
          SELECT candidate.id FROM analysis_runs candidate
          WHERE candidate.raw_message_id=a.raw_message_id
            AND candidate.stage=a.stage
            AND candidate.status='ok'
          ORDER BY candidate.id DESC
          LIMIT 1
        );
  `);

  for (const table of APPEND_ONLY_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_deny_update
      BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_deny_delete
      BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    `);
  }
}

export function appendRawMessage(db, record) {
  const rawText = record.rawText ?? "";
  const fingerprint = JSON.stringify({
    rawText,
    replyToMessageId: record.replyToMessageId == null ? null : String(record.replyToMessageId),
    mediaId: record.raw?.media_id ?? null,
    groupedId: record.raw?.grouped_id ?? null
  });
  const contentHash = crypto.createHash("sha256").update(fingerprint).digest("hex");
  const existing = db.prepare(`
    SELECT id FROM raw_messages
    WHERE telegram_chat_id=? AND telegram_message_id=? AND content_hash=?
  `).get(String(record.chatId), String(record.messageId), contentHash);
  if (existing) return { id: existing.id, inserted: false };

  const latest = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS version FROM raw_messages
    WHERE telegram_chat_id=? AND telegram_message_id=?
  `).get(String(record.chatId), String(record.messageId));
  const result = db.prepare(`
    INSERT INTO raw_messages(
      channel_key, telegram_chat_id, telegram_message_id, version, published_at,
      received_at, edited_at, reply_to_message_id, raw_text, raw_json, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.channelKey,
    String(record.chatId),
    String(record.messageId),
    Number(latest.version) + 1,
    record.publishedAt,
    record.receivedAt,
    record.editedAt ?? null,
    record.replyToMessageId == null ? null : String(record.replyToMessageId),
    rawText,
    JSON.stringify(record.raw ?? {}),
    contentHash
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function appendSignalHint(db, rawMessageId, hint) {
  const existing = db.prepare(`
    SELECT id FROM signal_hints WHERE raw_message_id=? AND detector_version=?
  `).get(rawMessageId, hint.schema_version);
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO signal_hints(raw_message_id,detector_version,created_at,hint_json)
    VALUES(?,?,?,?)
  `).run(rawMessageId, hint.schema_version, new Date().toISOString(), JSON.stringify(hint));
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function getSignalHint(db, rawMessageId) {
  const row = db.prepare(`
    SELECT hint_json FROM signal_hints WHERE raw_message_id=? ORDER BY id DESC LIMIT 1
  `).get(rawMessageId);
  return row ? JSON.parse(row.hint_json) : null;
}

export function appendAnalysis(db, record) {
  const result = db.prepare(`
    INSERT INTO analysis_runs(
      raw_message_id, stage, schema_version, model, session_key, created_at,
      status, input_json, output_json, error_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.rawMessageId ?? null,
    record.stage,
    record.schemaVersion,
    record.model,
    record.sessionKey ?? null,
    record.createdAt ?? new Date().toISOString(),
    record.status,
    JSON.stringify(record.input ?? {}),
    record.output == null ? null : JSON.stringify(record.output),
    record.error ?? null
  );
  return Number(result.lastInsertRowid);
}

export function appendMediaAsset(db, record) {
  const existing = db.prepare(`
    SELECT id FROM media_assets
    WHERE raw_message_id=? AND media_index=? AND sha256=?
  `).get(record.rawMessageId, record.mediaIndex, record.sha256);
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO media_assets(
      raw_message_id,media_index,telegram_kind,mime_type,size_bytes,sha256,storage_path,created_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(
    record.rawMessageId,
    record.mediaIndex,
    record.telegramKind,
    record.mimeType ?? null,
    record.sizeBytes,
    record.sha256,
    record.storagePath,
    record.createdAt ?? new Date().toISOString()
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function appendMediaAnalysis(db, record) {
  const result = db.prepare(`
    INSERT INTO media_analyses(
      media_asset_id,schema_version,model,created_at,status,output_json,error_text
    ) VALUES(?,?,?,?,?,?,?)
  `).run(
    record.mediaAssetId,
    record.schemaVersion,
    record.model,
    record.createdAt ?? new Date().toISOString(),
    record.status,
    record.output == null ? null : JSON.stringify(record.output),
    record.error ?? null
  );
  return Number(result.lastInsertRowid);
}

export function listMediaEvidence(db, rawMessageId) {
  return db.prepare(`
    SELECT m.id AS media_asset_id, m.media_index, m.telegram_kind, m.mime_type,
           m.size_bytes, m.sha256, m.storage_path,
           a.schema_version, a.model, a.status, a.output_json, a.error_text
    FROM media_assets m
    LEFT JOIN media_analyses a ON a.id=(
      SELECT x.id FROM media_analyses x WHERE x.media_asset_id=m.id ORDER BY x.id DESC LIMIT 1
    )
    WHERE m.raw_message_id=? ORDER BY m.media_index, m.id
  `).all(rawMessageId).map((row) => ({
    asset_id: Number(row.media_asset_id),
    media_index: Number(row.media_index),
    telegram_kind: row.telegram_kind,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    storage_path: row.storage_path,
    analysis: row.output_json ? JSON.parse(row.output_json) : null,
    analysis_status: row.status ?? "pending",
    analysis_error: row.error_text ?? null,
    model: row.model ?? null,
    schema_version: row.schema_version ?? null
  }));
}

export function appendMarketSnapshot(db, rawMessageId, snapshot) {
  const result = db.prepare(`
    INSERT INTO market_snapshots(raw_message_id,captured_at,as_of,data_tier,provider,snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rawMessageId,
    snapshot.captured_at ?? new Date().toISOString(),
    snapshot.as_of ?? snapshot.observed_at ?? snapshot.captured_at ?? new Date().toISOString(),
    snapshot.data_tier,
    snapshot.provider,
    JSON.stringify(snapshot)
  );
  return Number(result.lastInsertRowid);
}

export function appendInterpretationEvent(db, record) {
  const existing = db.prepare("SELECT id FROM interpretation_events WHERE event_key=?").get(String(record.eventKey));
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO interpretation_events(event_key,raw_message_id,event_type,created_at,payload_json)
    VALUES(?,?,?,?,?)
  `).run(
    String(record.eventKey),
    Number(record.rawMessageId),
    String(record.eventType),
    record.createdAt ?? new Date().toISOString(),
    JSON.stringify(record.payload ?? {})
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function listPendingInterpretations(db) {
  return db.prepare(`
    SELECT e.id,e.raw_message_id,e.created_at,e.payload_json,
           r.channel_key,r.telegram_message_id,r.event_at AS published_at,r.reply_to_message_id,r.raw_text
    FROM interpretation_events e
    JOIN latest_raw_messages r ON r.id=e.raw_message_id
    WHERE e.event_type='pending'
      AND e.id=(SELECT MAX(x.id) FROM interpretation_events x WHERE x.raw_message_id=e.raw_message_id)
    ORDER BY e.id
  `).all().map((row) => ({
    id: Number(row.id),
    raw_message_id: Number(row.raw_message_id),
    created_at: row.created_at,
    channel_key: row.channel_key,
    telegram_message_id: row.telegram_message_id,
    published_at: row.published_at,
    reply_to_message_id: row.reply_to_message_id,
    raw_text: row.raw_text,
    payload: JSON.parse(row.payload_json)
  }));
}

export function appendLifecycleReview(db, record) {
  const manifest = JSON.stringify(record.inputManifest ?? {});
  const inputManifestHash = crypto.createHash("sha256").update(manifest).digest("hex");
  const existing = db.prepare(`
    SELECT id FROM lifecycle_reviews
    WHERE signal_raw_message_id=? AND exit_raw_message_id=? AND review_version=? AND input_manifest_hash=?
  `).get(record.signalRawMessageId, record.exitRawMessageId, record.reviewVersion, inputManifestHash);
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO lifecycle_reviews(signal_raw_message_id,exit_raw_message_id,created_at,review_version,input_manifest_hash,status,review_json)
    VALUES(?,?,?,?,?,?,?)
  `).run(
    record.signalRawMessageId,
    record.exitRawMessageId,
    record.createdAt ?? new Date().toISOString(),
    record.reviewVersion,
    inputManifestHash,
    record.status,
    JSON.stringify(record.review)
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function appendPositionWorkflowEvent(db, record) {
  const eventKey = String(record.eventKey);
  const existing = db.prepare("SELECT id FROM position_workflow_events WHERE event_key=?").get(eventKey);
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO position_workflow_events(
      event_key,workflow_id,signal_raw_message_id,exit_raw_message_id,event_type,
      process_role,process_pid,created_at,payload_json
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    eventKey,
    String(record.workflowId),
    Number(record.signalRawMessageId),
    record.exitRawMessageId == null ? null : Number(record.exitRawMessageId),
    String(record.eventType),
    record.processRole ?? null,
    record.processPid == null ? null : Number(record.processPid),
    record.createdAt ?? new Date().toISOString(),
    JSON.stringify(record.payload ?? {})
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function appendModelFeedback(db, record) {
  const existing = db.prepare(`
    SELECT id FROM model_feedback WHERE workflow_id=? AND feedback_version=?
  `).get(String(record.workflowId), String(record.feedbackVersion));
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO model_feedback(workflow_id,feedback_version,created_at,status,feedback_json)
    VALUES(?,?,?,?,?)
  `).run(
    String(record.workflowId),
    String(record.feedbackVersion),
    record.createdAt ?? new Date().toISOString(),
    String(record.status),
    JSON.stringify(record.feedback ?? {})
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function appendIntradayEvent(db, record) {
  const eventKey = String(record.eventKey);
  const existing = db.prepare("SELECT id FROM intraday_events WHERE event_key=?").get(eventKey);
  if (existing) return { id: Number(existing.id), inserted: false };
  const result = db.prepare(`
    INSERT INTO intraday_events(
      event_key,session_date,event_type,symbol,source,event_at,forecast_id,matures_at,payload_json
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    eventKey,
    String(record.sessionDate),
    String(record.eventType),
    record.symbol == null ? null : String(record.symbol).toUpperCase(),
    String(record.source),
    String(record.eventAt ?? new Date().toISOString()),
    record.forecastId == null ? null : String(record.forecastId),
    record.maturesAt == null ? null : String(record.maturesAt),
    JSON.stringify(record.payload ?? {})
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function listIntradayEvents(db, {
  sessionDate = null,
  eventType = null,
  symbol = null,
  source = null,
  afterId = 0,
  limit = 10_000
} = {}) {
  const boundedLimit = Math.min(100_000, Math.max(1, Math.trunc(Number(limit) || 1)));
  const normalizedSymbol = symbol == null ? null : String(symbol).toUpperCase();
  return db.prepare(`
    SELECT * FROM intraday_events
    WHERE id>?
      AND (? IS NULL OR session_date=?)
      AND (? IS NULL OR event_type=?)
      AND (? IS NULL OR symbol=?)
      AND (? IS NULL OR source=?)
    ORDER BY id LIMIT ?
  `).all(
    Math.max(0, Math.trunc(Number(afterId) || 0)),
    sessionDate, sessionDate,
    eventType, eventType,
    normalizedSymbol, normalizedSymbol,
    source, source,
    boundedLimit
  ).map((row) => ({
    ...row,
    id: Number(row.id),
    payload: JSON.parse(row.payload_json)
  }));
}

export function listResumablePositionWorkflows(db) {
  return db.prepare(`
    SELECT opened.workflow_id,opened.signal_raw_message_id,opened.created_at,opened.payload_json
    FROM position_workflow_events opened
    WHERE opened.event_type='opened'
      AND opened.id=(
        SELECT MAX(candidate.id) FROM position_workflow_events candidate
        WHERE candidate.workflow_id=opened.workflow_id AND candidate.event_type='opened'
      )
      AND NOT EXISTS (
        SELECT 1 FROM position_workflow_events terminal
        WHERE terminal.workflow_id=opened.workflow_id
          AND terminal.event_type IN ('completed','expired','cancelled','superseded','awaiting_human_choice')
          AND terminal.id>opened.id
      )
    ORDER BY opened.id
  `).all().map((row) => ({
    workflow_id: row.workflow_id,
    signal_raw_message_id: Number(row.signal_raw_message_id),
    created_at: row.created_at,
    payload: JSON.parse(row.payload_json)
  }));
}

export function listPositionWorkflowEvents(db, workflowId) {
  return db.prepare(`
    SELECT * FROM position_workflow_events WHERE workflow_id=? ORDER BY id
  `).all(String(workflowId)).map((row) => ({
    ...row,
    signal_raw_message_id: Number(row.signal_raw_message_id),
    exit_raw_message_id: row.exit_raw_message_id == null ? null : Number(row.exit_raw_message_id),
    process_pid: row.process_pid == null ? null : Number(row.process_pid),
    payload: JSON.parse(row.payload_json)
  }));
}

export function getRawMessage(db, id) {
  return db.prepare("SELECT * FROM raw_messages WHERE id=?").get(id);
}

export function isLatestRawMessageVersion(db, id) {
  return db.prepare("SELECT 1 AS is_latest FROM latest_raw_messages WHERE id=?")
    .get(Number(id))?.is_latest === 1;
}

export function getLatestStageOutput(db, rawMessageId, stage) {
  const row = db.prepare(`
    SELECT output_json FROM analysis_runs
    WHERE raw_message_id=? AND stage=? AND status='ok'
    ORDER BY id DESC LIMIT 1
  `).get(rawMessageId, stage);
  return row?.output_json ? JSON.parse(row.output_json) : null;
}

export function getLatestMarketSnapshot(db, rawMessageId) {
  const row = db.prepare(`
    SELECT * FROM market_snapshots WHERE raw_message_id=? ORDER BY id DESC LIMIT 1
  `).get(rawMessageId);
  return row ? { ...row, snapshot: JSON.parse(row.snapshot_json) } : null;
}

export function listPendingRawMessages(db, limit = 100) {
  return db.prepare(`
    SELECT r.*
    FROM latest_raw_messages r
    WHERE
      NOT EXISTS (
        SELECT 1 FROM latest_successful_analysis_runs a
        WHERE a.raw_message_id=r.id AND a.stage='luna'
      )
      OR (
        EXISTS (
          SELECT 1 FROM latest_successful_analysis_runs a
          WHERE a.raw_message_id=r.id AND a.stage='luna'
            AND json_extract(a.output_json,'$.classification') IN ('options_signal','update','cancel','outcome')
        )
        AND NOT EXISTS (
          SELECT 1 FROM latest_successful_analysis_runs a
          WHERE a.raw_message_id=r.id AND a.stage='terra'
        )
      )
      OR (
        json_extract(r.raw_json,'$.has_media')=1
        AND NOT EXISTS (
          SELECT 1 FROM media_assets m JOIN media_analyses ma ON ma.media_asset_id=m.id
          WHERE m.raw_message_id=r.id AND ma.status='ok'
        )
      )
    ORDER BY r.event_at,r.id
    LIMIT ?
  `).all(Math.max(1, Number(limit)));
}

export function listDailyInputs(db, startInclusive, endExclusive) {
  return db.prepare(`
    SELECT r.id AS raw_message_id, r.channel_key, r.event_at AS published_at,
      r.published_at AS source_published_at, r.raw_text,
      a.stage, a.schema_version, a.output_json
    FROM latest_raw_messages r
    LEFT JOIN latest_successful_analysis_runs a ON a.raw_message_id=r.id
    WHERE r.event_at>=? AND r.event_at<?
    ORDER BY r.event_at,r.id,a.stage
  `).all(startInclusive, endExclusive);
}

function lifecycleReviewRows(db, asOfExclusive = null) {
  const select = (exitSource, cutoffClauses = "", partialCutoff = "", reviewCutoff = "") => `
    SELECT lr.id,lr.signal_raw_message_id,lr.exit_raw_message_id,lr.review_version,
           lr.status,lr.created_at,lr.review_json,r.channel_key,r.event_at AS published_at,
           r.published_at AS source_published_at,r.raw_text,
           signal.telegram_chat_id AS signal_chat_id,
           signal.telegram_message_id AS signal_message_id,
           partial.payload_json AS partial_payload_json
    FROM lifecycle_reviews lr
    JOIN ${exitSource} r ON r.id=lr.exit_raw_message_id
    JOIN raw_messages signal ON signal.id=lr.signal_raw_message_id
    LEFT JOIN position_workflow_events partial ON partial.id=(
      SELECT candidate.id FROM position_workflow_events candidate
      WHERE candidate.signal_raw_message_id=lr.signal_raw_message_id
        AND candidate.exit_raw_message_id=lr.exit_raw_message_id
        AND candidate.event_type='partial_exit'
        ${partialCutoff}
      ORDER BY candidate.id DESC LIMIT 1
    )
    WHERE lr.id=(
      SELECT candidate.id FROM lifecycle_reviews candidate
      WHERE candidate.signal_raw_message_id=lr.signal_raw_message_id
        AND candidate.exit_raw_message_id=lr.exit_raw_message_id
        ${reviewCutoff}
      ORDER BY candidate.id DESC LIMIT 1
    )
      ${cutoffClauses}
    ORDER BY signal.telegram_chat_id,signal.telegram_message_id,r.event_at,lr.id
  `;
  if (asOfExclusive == null) {
    return db.prepare(select("latest_raw_messages")).all();
  }
  const cutoff = new Date(asOfExclusive).toISOString();
  return db.prepare(`
    WITH canonical_exit AS (
      SELECT raw.*,COALESCE(raw.edited_at,raw.published_at) AS event_at
      FROM raw_messages raw
      WHERE COALESCE(raw.edited_at,raw.published_at) < ?
        AND raw.id=(
          SELECT candidate.id FROM raw_messages candidate
          WHERE candidate.telegram_chat_id=raw.telegram_chat_id
            AND candidate.telegram_message_id=raw.telegram_message_id
            AND COALESCE(candidate.edited_at,candidate.published_at) < ?
          ORDER BY candidate.version DESC,candidate.id DESC LIMIT 1
        )
    )
    ${select(
      "canonical_exit",
      "AND COALESCE(signal.edited_at,signal.published_at) < ?"
    )}
  `).all(cutoff, cutoff, cutoff);
}

function jsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function aggregatePartialLifecycleRows(partialRows, finalRow) {
  const finalReview = jsonObject(finalRow.review_json);
  if (!partialRows.length || finalReview.partial_exit_aggregation) return finalRow;
  const partialLegs = partialRows.map((row) => {
    const payload = jsonObject(row.partial_payload_json);
    return {
      row,
      review: jsonObject(row.review_json),
      fraction: finiteNumber(payload.portfolio_fraction)
    };
  });
  const fractionsValid = partialLegs.every((leg) => leg.fraction != null && leg.fraction > 0 && leg.fraction < 1);
  const partialFraction = fractionsValid ? partialLegs.reduce((sum, leg) => sum + leg.fraction, 0) : Number.NaN;
  const finalFraction = fractionsValid && partialFraction <= 1 + 1e-9 ? Math.max(0, 1 - partialFraction) : null;
  const legs = [
    ...partialLegs,
    { row: finalRow, review: finalReview, fraction: finalFraction }
  ].filter((leg) => leg.fraction != null && leg.fraction > 1e-9);
  const weighted = (selector) => {
    if (finalFraction == null) return null;
    const values = legs.map((leg) => ({ fraction: leg.fraction, value: finiteNumber(selector(leg.review)) }));
    if (values.some((item) => item.value == null)) return null;
    const denominator = values.reduce((sum, item) => sum + item.fraction, 0);
    return denominator > 0
      ? values.reduce((sum, item) => sum + item.fraction * item.value, 0) / denominator
      : null;
  };
  const allScored = finalFraction != null && legs.length > 0
    && legs.every((leg) => leg.review?.status === "scored");
  const exitPrice = weighted((review) => review?.execution_check?.exit_execution_price);
  const grossReturn = weighted((review) => review?.execution_check?.gross_executable_return);
  const holdMinutes = weighted((review) => review?.exit?.hold_minutes);
  const status = allScored && exitPrice != null && grossReturn != null
    ? "scored" : "blocked_incomplete_partial_exit_data";
  const effectiveReview = {
    ...finalReview,
    schema_version: "lifecycle-review.v1.3",
    status,
    exit: { ...(finalReview.exit ?? {}), hold_minutes: holdMinutes },
    execution_check: {
      ...(finalReview.execution_check ?? {}),
      exit_execution_price: exitPrice,
      gross_executable_return: grossReturn,
      exit_basis: "portfolio_fraction_weighted_source_exits"
    },
    partial_exit_aggregation: {
      policy: "portfolio_fraction_weighted",
      status: finalFraction == null ? "invalid_fractions" : status === "scored" ? "complete" : "incomplete_data",
      total_fraction: finalFraction == null ? null : legs.reduce((sum, leg) => sum + leg.fraction, 0),
      weighted_exit_price: exitPrice,
      weighted_gross_return: grossReturn,
      exposure_weighted_hold_minutes: holdMinutes,
      derived_for_statistics: true,
      legs: legs.map((leg) => ({
        exit_raw_message_id: Number(leg.row.exit_raw_message_id),
        portfolio_fraction: leg.fraction,
        exit_price: finiteNumber(leg.review?.execution_check?.exit_execution_price),
        gross_return: finiteNumber(leg.review?.execution_check?.gross_executable_return),
        hold_minutes: finiteNumber(leg.review?.exit?.hold_minutes)
      }))
    }
  };
  return {
    ...finalRow,
    review_version: "lifecycle-review.v1.3-derived",
    status,
    review_json: JSON.stringify(effectiveReview)
  };
}

/**
 * Keep the append-only audit trail separate from the single effective outcome
 * used by performance statistics. A later full close supersedes an earlier
 * full close. Explicit partial legs are portfolio-weighted into the final
 * close, so one opening signal remains one statistical trade.
 */
export function lifecycleReviewSelection(db, { asOfExclusive = null } = {}) {
  const rows = lifecycleReviewRows(db, asOfExclusive);
  const groups = new Map();
  for (const row of rows) {
    const signalKey = `${row.signal_chat_id}:${row.signal_message_id}`;
    if (!groups.has(signalKey)) groups.set(signalKey, []);
    groups.get(signalKey).push(row);
  }
  const effectiveRows = [];
  for (const group of groups.values()) {
    const fullCloseRows = group.filter((row) => row.partial_payload_json == null);
    if (!fullCloseRows.length) continue;
    const finalRow = fullCloseRows.at(-1);
    const partialRows = group.filter((row) => row.partial_payload_json != null
      && row.published_at <= finalRow.published_at);
    effectiveRows.push(aggregatePartialLifecycleRows(partialRows, finalRow));
  }
  effectiveRows.sort((left, right) => left.published_at.localeCompare(right.published_at)
    || Number(left.id) - Number(right.id));
  const reviewedExitRawIds = [...new Set(rows.map((row) => Number(row.exit_raw_message_id)))];
  const effectiveExitRawIds = [...new Set(effectiveRows.map((row) => Number(row.exit_raw_message_id)))];
  const effectiveSet = new Set(effectiveExitRawIds);
  return {
    effectiveRows,
    reviewedExitRawIds,
    effectiveExitRawIds,
    supersededExitRawIds: reviewedExitRawIds.filter((id) => !effectiveSet.has(id))
  };
}

export function listEffectiveLifecycleReviews(db, options = {}) {
  return lifecycleReviewSelection(db, options).effectiveRows;
}

export function listDailyLifecycleReviews(db, startInclusive, endExclusive) {
  return listEffectiveLifecycleReviews(db, { asOfExclusive: endExclusive })
    .filter((row) => row.published_at >= startInclusive && row.published_at < endExclusive);
}

export function setOperationalState(db, key, value) {
  db.prepare(`
    INSERT INTO operational_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

export function getOperationalState(db, key) {
  const row = db.prepare("SELECT value FROM operational_state WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : null;
}
