/**
 * Приём событий.
 *
 * Гарантии эндпоинта: повторный `event_id` не создаёт дубль (PK + INSERT OR IGNORE),
 * события идут батчами, повтор всего батча безопасен, а одно битое событие
 * отклоняется отдельно и не роняет соседей.
 *
 * Порядок событий здесь не важен: ниже по потоку строки никогда не читаются как
 * последовательность, поэтому опоздавшее событие — это просто строка, пришедшая позже.
 */
import { getDb, nowIso } from './db.ts';
import { getSession } from './sessions.ts';
import { getVersionById, parseConfig } from './versions.ts';
import { allowedEventNames, isValidEventName } from '@shared/funnel';

export interface IncomingEvent {
  event_id?: unknown;
  session_id?: unknown;
  type?: unknown;
  step_id?: unknown;
  client_ts?: unknown;
  client_seq?: unknown;
  props?: unknown;
  /** Клиент может продублировать UTM, но источник истины — строка сессии. */
  utm?: Record<string, unknown>;
}

export type EventStatus = 'accepted' | 'duplicate' | 'rejected';

export interface EventResult {
  event_id: string | null;
  status: EventStatus;
  error?: string;
}

export interface IngestSummary {
  received: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  results: EventResult[];
}

const UUID_ISH = /^[A-Za-z0-9_:.-]{8,128}$/;

/** Объявленные события кэшируются по версии: строки конфигов неизменяемы. */
const allowedCache = new Map<number, Set<string>>();

function allowedForVersion(versionId: number): Set<string> {
  const cached = allowedCache.get(versionId);
  if (cached) return cached;
  const row = getVersionById(versionId);
  const names = row ? allowedEventNames(parseConfig(row)) : new Set<string>();
  allowedCache.set(versionId, names);
  return names;
}

/** Для тестов: иначе кэш переживает подмену in-memory базы. */
export function resetEventCaches(): void {
  allowedCache.clear();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asIsoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function recordRejection(eventId: string | null, reason: string, payload: unknown): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO event_rejections (event_id, reason, payload, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(eventId, reason, JSON.stringify(payload ?? null).slice(0, 4000), nowIso());
  } catch {
    // Журнал для разбора не должен ломать приём событий.
  }
}

/** Обрабатывает батч и возвращает вердикт по каждому событию; отказ одного не прерывает остальные. */
export function ingestEvents(batch: IncomingEvent[]): IngestSummary {
  const db = getDb();
  const results: EventResult[] = [];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (
       event_id, session_id, funnel_key, type, step_id, version_id, version, variant, experiment_id,
       client_ts, server_ts, client_seq,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       props_json, synthetic
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const raw of batch) {
    let eventId: string | null = null;
    try {
      if (!isPlainObject(raw)) {
        results.push({ event_id: null, status: 'rejected', error: 'Event must be an object.' });
        recordRejection(null, 'not_an_object', raw);
        continue;
      }

      eventId = typeof raw.event_id === 'string' ? raw.event_id : null;
      if (!eventId || !UUID_ISH.test(eventId)) {
        results.push({ event_id: eventId, status: 'rejected', error: 'Invalid or missing event_id.' });
        recordRejection(eventId, 'invalid_event_id', raw);
        continue;
      }

      const type = typeof raw.type === 'string' ? raw.type : '';
      if (!isValidEventName(type)) {
        results.push({ event_id: eventId, status: 'rejected', error: `Invalid event name "${type}".` });
        recordRejection(eventId, 'invalid_type', raw);
        continue;
      }

      const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
      const session = sessionId ? getSession(sessionId) : undefined;
      if (!session) {
        results.push({ event_id: eventId, status: 'rejected', error: 'Unknown session_id.' });
        recordRejection(eventId, 'unknown_session', raw);
        continue;
      }

      // Версия, к которой привязана сессия, определяет допустимые события: новое событие вводится конфигом.
      if (!allowedForVersion(session.version_id).has(type)) {
        results.push({
          event_id: eventId,
          status: 'rejected',
          error: `Event "${type}" is not declared by funnel version ${session.version}.`,
        });
        recordRejection(eventId, 'undeclared_event', raw);
        continue;
      }

      const stepId = typeof raw.step_id === 'string' && raw.step_id.trim() !== ''
        ? raw.step_id.trim().slice(0, 120)
        : null;

      const props = isPlainObject(raw.props) ? raw.props : {};
      const clientSeq = Number.isFinite(raw.client_seq) ? Number(raw.client_seq) : null;

      // Версия, вариант и UTM берутся из строки сессии, а не из тела запроса:
      // подделанный или устаревший клиент не может переразметить свои события.
      const info = insert.run(
        eventId,
        session.session_id,
        session.funnel_key,
        type,
        stepId,
        session.version_id,
        session.version,
        session.variant,
        session.experiment_id,
        asIsoOrNull(raw.client_ts),
        nowIso(),
        clientSeq,
        session.utm_source,
        session.utm_medium,
        session.utm_campaign,
        session.utm_content,
        session.utm_term,
        JSON.stringify(props).slice(0, 8000),
        session.synthetic,
      );

      results.push({
        event_id: eventId,
        status: info.changes === 0 ? 'duplicate' : 'accepted',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ event_id: eventId, status: 'rejected', error: message });
      recordRejection(eventId, 'exception', raw);
    }
  }

  const summary: IngestSummary = {
    received: batch.length,
    accepted: results.filter((r) => r.status === 'accepted').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    results,
  };

  bumpCounters(summary);
  return summary;
}

/** Счётчики, чтобы на дашборде было видно: повторы и отказы действительно были. */
function bumpCounters(summary: IngestSummary): void {
  const stmt = getDb().prepare(
    `INSERT INTO ingest_counters (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
  );
  try {
    stmt.run('received', summary.received);
    stmt.run('accepted', summary.accepted);
    stmt.run('duplicates', summary.duplicates);
    stmt.run('rejected', summary.rejected);
  } catch {
    // Счётчики — диагностика; из-за них приём падать не должен.
  }
}

export function countEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  return row.n;
}
