/**
 * Хранилище версий.
 *
 * Инварианты: опубликованная строка неизменяема (публикация только добавляет),
 * `funnel_active` — указатель, поэтому откат это его сдвиг, а не удаление,
 * и ничто не прошедшее валидацию не может стать активным.
 */
import { getDb, nowIso } from './db.ts';
import { configErrors, type FunnelConfig } from '@shared/funnel';

export interface VersionRow {
  id: number;
  funnel_key: string;
  version: number;
  source_version: number | null;
  config_json: string;
  note: string | null;
  created_at: string;
}

export interface VersionSummary {
  id: number;
  funnelKey: string;
  version: number;
  /** Версия, объявленная самим конфигом, если есть. */
  sourceVersion: number | null;
  name: string;
  note: string | null;
  createdAt: string;
  isActive: boolean;
  stepCount: number;
  resultCount: number;
  variants: string[];
  experimentId: string;
}

export class ConfigValidationError extends Error {
  constructor(public issues: string[]) {
    super(`Config rejected: ${issues.join(' ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function parseConfig(row: VersionRow): FunnelConfig {
  return JSON.parse(row.config_json) as FunnelConfig;
}

export function getVersionById(id: number): VersionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM funnel_versions WHERE id = ?')
    .get(id) as VersionRow | undefined;
}

export function getVersion(funnelKey: string, version: number): VersionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM funnel_versions WHERE funnel_key = ? AND version = ?')
    .get(funnelKey, version) as VersionRow | undefined;
}

export function listVersions(funnelKey: string): VersionSummary[] {
  const db = getDb();
  const active = getActiveVersionRow(funnelKey);
  const rows = db
    .prepare('SELECT * FROM funnel_versions WHERE funnel_key = ? ORDER BY version DESC')
    .all(funnelKey) as VersionRow[];

  return rows.map((row) => {
    const cfg = parseConfig(row);
    return {
      id: row.id,
      funnelKey: row.funnel_key,
      version: row.version,
      sourceVersion: row.source_version,
      name: cfg.title,
      note: row.note,
      createdAt: row.created_at,
      isActive: active?.id === row.id,
      stepCount: Object.keys(cfg.steps ?? {}).length,
      resultCount: Object.keys(cfg.results ?? {}).length,
      variants: Object.keys(cfg.experiment?.variants ?? {}),
      experimentId: cfg.experiment?.id ?? '',
    };
  });
}

export function listFunnelKeys(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT funnel_key FROM funnel_versions ORDER BY funnel_key')
    .all() as { funnel_key: string }[];
  return rows.map((r) => r.funnel_key);
}

export function getActiveVersionRow(funnelKey: string): VersionRow | undefined {
  return getDb()
    .prepare(
      `SELECT v.* FROM funnel_active a
       JOIN funnel_versions v ON v.id = a.version_id
       WHERE a.funnel_key = ?`,
    )
    .get(funnelKey) as VersionRow | undefined;
}

function recordActivation(
  funnelKey: string,
  versionId: number,
  version: number,
  action: 'publish' | 'rollback' | 'activate',
  note: string | null,
): void {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO funnel_active (funnel_key, version_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(funnel_key) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at`,
  ).run(funnelKey, versionId, ts);
  db.prepare(
    `INSERT INTO version_activations (funnel_key, version_id, version, action, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(funnelKey, versionId, version, action, note, ts);
}

/**
 * Добавляет новую версию и делает её активной.
 * Живые сессии не трогаются: они держат FK на свою неизменяемую строку.
 */
export function publishVersion(
  config: FunnelConfig,
  opts: { note?: string; activate?: boolean } = {},
): VersionSummary {
  const errors = configErrors(config);
  if (errors.length > 0) throw new ConfigValidationError(errors);

  const db = getDb();
  const funnelKey = config.funnelId;
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max FROM funnel_versions WHERE funnel_key = ?')
    .get(funnelKey) as { max: number };
  const version = row.max + 1;
  const ts = nowIso();

  const info = db
    .prepare(
      `INSERT INTO funnel_versions (funnel_key, version, source_version, config_json, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      funnelKey,
      version,
      typeof config.version === 'number' ? config.version : null,
      // Конфиг хранится дословно, кроме `version`: к ней привязываются сессии,
      // поэтому она следует нашей нумерации, а не той, что в файле.
      JSON.stringify({ ...config, version }),
      opts.note ?? null,
      ts,
    );

  const versionId = Number(info.lastInsertRowid);
  if (opts.activate !== false) {
    recordActivation(funnelKey, versionId, version, 'publish', opts.note ?? null);
  }

  return listVersions(funnelKey).find((v) => v.id === versionId)!;
}

/**
 * Переключает воронку на уже опубликованную версию.
 * Сессии со старой версии продолжают на ней: их ответы валидировались по тому конфигу.
 */
export function activateVersion(
  funnelKey: string,
  versionId: number,
  action: 'rollback' | 'activate' = 'activate',
  note?: string,
): VersionSummary {
  const target = getVersionById(versionId);
  if (!target || target.funnel_key !== funnelKey) {
    throw new Error(`Version ${versionId} does not belong to funnel "${funnelKey}".`);
  }
  recordActivation(funnelKey, target.id, target.version, action, note ?? null);
  return listVersions(funnelKey).find((v) => v.id === versionId)!;
}

/** Откат на версию, активную непосредственно перед текущей. */
export function rollbackToPrevious(funnelKey: string, note?: string): VersionSummary {
  const db = getDb();
  const history = db
    .prepare(
      `SELECT version_id, version FROM version_activations
       WHERE funnel_key = ? ORDER BY id DESC`,
    )
    .all(funnelKey) as { version_id: number; version: number }[];

  if (history.length === 0) throw new Error(`Funnel "${funnelKey}" has no activation history.`);

  const current = history[0].version_id;
  const previous = history.find((h) => h.version_id !== current);
  if (!previous) throw new Error(`Funnel "${funnelKey}" has no earlier version to roll back to.`);

  return activateVersion(funnelKey, previous.version_id, 'rollback', note ?? 'Rollback to previous version');
}

export interface ActivationRow {
  id: number;
  funnel_key: string;
  version_id: number;
  version: number;
  action: string;
  note: string | null;
  created_at: string;
}

export function listActivations(funnelKey: string, limit = 25): ActivationRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM version_activations WHERE funnel_key = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(funnelKey, limit) as ActivationRow[];
}
