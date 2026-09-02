/**
 * Event ingest.
 *
 * Four properties the endpoint guarantees, in the order the brief lists them:
 *  1. Re-sending the same event_id never creates a duplicate (PK + INSERT OR IGNORE).
 *  2. Events arrive in batches.
 *  3. Re-sending an entire batch after a timeout is safe — it is just (1) N times.
 *  4. One malformed event is rejected on its own; its siblings still land.
 *
 * Ingest deliberately does not care about ordering. Nothing downstream reads
 * these rows as a sequence, so a late or out-of-order event is not a special
 * case — it is simply a row that arrives later.
 */
import { getDb, nowIso } from './db.ts';
import { getSession } from './sessions.ts';
import { isValidEventType } from '@shared/funnel';

export interface IncomingEvent {
  event_id?: unknown;
  session_id?: unknown;
  type?: unknown;
  step_id?: unknown;
  client_ts?: unknown;
  client_seq?: unknown;
  props?: unknown;
  /** UTM may be echoed by the client; the session row is the source of truth. */
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
    // Never let the debug trail break ingest.
  }
}

/**
 * Ingest one batch. Always returns a per-event verdict; a rejected event never
 * aborts the batch, and the HTTP layer still answers 200 so a retrying client
 * does not spin on a permanently-bad payload.
 */
export function ingestEvents(batch: IncomingEvent[]): IngestSummary {
  const db = getDb();
  const results: EventResult[] = [];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (
       event_id, session_id, funnel_key, type, step_id, version_id, version, variant,
       client_ts, server_ts, client_seq,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       props_json, synthetic
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      if (!isValidEventType(type)) {
        results.push({ event_id: eventId, status: 'rejected', error: `Invalid event type "${type}".` });
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

      const stepId = typeof raw.step_id === 'string' && raw.step_id.trim() !== ''
        ? raw.step_id.trim().slice(0, 120)
        : null;

      const props = isPlainObject(raw.props) ? raw.props : {};
      const clientSeq = Number.isFinite(raw.client_seq) ? Number(raw.client_seq) : null;

      // Version, variant and UTM are taken from the pinned session row, never
      // from the client payload — a tampered or stale client cannot mislabel
      // its own events.
      const info = insert.run(
        eventId,
        session.session_id,
        session.funnel_key,
        type,
        stepId,
        session.version_id,
        session.version,
        session.variant,
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

/** Running tallies so the dashboard can evidence that retries really happened. */
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
    // Counters are diagnostics; never fail ingest over them.
  }
}

export function countEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  return row.n;
}
