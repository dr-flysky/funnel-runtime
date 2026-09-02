/**
 * SQLite access via Node's built-in `node:sqlite`.
 *
 * Using the runtime's own driver keeps the project free of native build steps
 * (no node-gyp, no prebuilt-binary roulette on Windows/CI) while still giving
 * us a real relational store with transactions and unique constraints.
 */
import { DatabaseSync, type Database } from './sqlite.ts';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Immutable config versions. A row is never updated once written; publishing
-- always appends. This is what makes old sessions safe across a publish.
CREATE TABLE IF NOT EXISTS funnel_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_key   TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  -- The version the config declared for itself, kept for traceability. The
  -- platform's own version column is what sessions pin to.
  source_version INTEGER,
  config_json  TEXT    NOT NULL,
  note         TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (funnel_key, version)
);

-- Which version new sessions start on, per funnel. Mutable pointer only.
CREATE TABLE IF NOT EXISTS funnel_active (
  funnel_key TEXT PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES funnel_versions(id),
  updated_at TEXT NOT NULL
);

-- Audit trail of every activation, so the admin page can show what happened.
CREATE TABLE IF NOT EXISTS version_activations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_key TEXT NOT NULL,
  version_id INTEGER NOT NULL REFERENCES funnel_versions(id),
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- A session pins its version and variant at creation and never re-reads the
-- active pointer again.
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  funnel_key     TEXT    NOT NULL,
  version_id     INTEGER NOT NULL REFERENCES funnel_versions(id),
  version        INTEGER NOT NULL,
  variant        TEXT    NOT NULL,
  variant_source TEXT    NOT NULL,
  experiment_id  TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  synthetic      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);

-- Server-authoritative navigation state, so refresh/back/reopen never lose it.
CREATE TABLE IF NOT EXISTS session_state (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(session_id),
  current_step TEXT,
  completed    INTEGER NOT NULL DEFAULT 0,
  -- Resolved once the user reaches the result step.
  result_id    TEXT,
  updated_at   TEXT    NOT NULL
);

-- Raw user answers live HERE and only here. The analytics store never sees
-- them; events carry a sanitised summary instead.
CREATE TABLE IF NOT EXISTS session_answers (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  step_id    TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, step_id)
);

-- The analytics store. event_id is the idempotency key: a client may resend a
-- batch as often as it likes.
CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT    NOT NULL,
  funnel_key   TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  step_id      TEXT,
  version_id   INTEGER,
  version      INTEGER NOT NULL,
  variant      TEXT    NOT NULL,
  experiment_id TEXT,
  client_ts    TEXT,
  server_ts    TEXT    NOT NULL,
  client_seq   INTEGER,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  props_json   TEXT    NOT NULL DEFAULT '{}',
  synthetic    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_session  ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_type     ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_step     ON events (type, step_id);
CREATE INDEX IF NOT EXISTS idx_events_funnel   ON events (funnel_key, version, variant);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events (utm_campaign);
CREATE INDEX IF NOT EXISTS idx_sessions_funnel ON sessions (funnel_key, version, variant);

-- Running ingest tallies, so the dashboard can show that duplicate and
-- out-of-order traffic was actually received and handled rather than absent.
CREATE TABLE IF NOT EXISTS ingest_counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Rejected events are kept for debugging: one bad event in a batch must never
-- be silently lost, nor break its siblings.
CREATE TABLE IF NOT EXISTS event_rejections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT,
  reason     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

let singleton: DB | null = null;

export function getDb(): DB {
  if (!singleton) {
    const file = process.env.DB_FILE ?? path.resolve(process.cwd(), 'data', 'funnel.db');
    singleton = openDb(file);
  }
  return singleton;
}

/** Test helper: swap in an isolated database. */
export function setDb(db: DB): void {
  singleton = db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
