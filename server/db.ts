/**
 * Доступ к SQLite через встроенный `node:sqlite`: настоящая реляционная база
 * с транзакциями и уникальными индексами, но без нативной сборки (node-gyp).
 */
import { DatabaseSync, type Database } from './sqlite.ts';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Неизменяемые версии конфига: публикация только добавляет строку, поэтому
-- старые сессии переживают публикацию.
CREATE TABLE IF NOT EXISTS funnel_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_key   TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  -- Версия, объявленная самим конфигом; сессии пинятся на version платформы.
  source_version INTEGER,
  config_json  TEXT    NOT NULL,
  note         TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (funnel_key, version)
);

-- Указатель на версию, с которой стартуют новые сессии.
CREATE TABLE IF NOT EXISTS funnel_active (
  funnel_key TEXT PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES funnel_versions(id),
  updated_at TEXT NOT NULL
);

-- Журнал активаций для админки.
CREATE TABLE IF NOT EXISTS version_activations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_key TEXT NOT NULL,
  version_id INTEGER NOT NULL REFERENCES funnel_versions(id),
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- Сессия фиксирует версию и вариант при создании и больше не перечитывает активный указатель.
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

-- Состояние навигации на сервере, чтобы обновление и возврат ничего не теряли.
CREATE TABLE IF NOT EXISTS session_state (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(session_id),
  current_step TEXT,
  completed    INTEGER NOT NULL DEFAULT 0,
  result_id    TEXT,
  updated_at   TEXT    NOT NULL
);

-- Сырые ответы хранятся ТОЛЬКО здесь; в аналитику уходит обезличенная сводка.
CREATE TABLE IF NOT EXISTS session_answers (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  step_id    TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, step_id)
);

-- Хранилище событий; event_id — ключ идемпотентности, батч можно слать повторно.
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

-- Счётчики приёма: дубли и отказы не становятся строками, но должны быть видны на дашборде.
CREATE TABLE IF NOT EXISTS ingest_counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Отклонённые события сохраняются для разбора: одно битое событие не должно теряться молча.
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

/** Для тестов: подменить базу на изолированную. */
export function setDb(db: DB): void {
  singleton = db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
