/**
 * Requirement 7.1: "дедупликация событий", plus the section 4.2 invariants —
 * batching, safe retry after timeout, and one bad event not poisoning a batch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FUNNEL, makeEvent, publishV2, seedV1, startServer, useFreshDb, type TestServer } from './helpers.ts';
import { createSession } from '../server/sessions.ts';
import { countEvents, ingestEvents } from '../server/events.ts';
import { getDb } from '../server/db.ts';

let server: TestServer;

beforeEach(async () => {
  useFreshDb();
  seedV1();
  server = await startServer();
});

afterEach(async () => {
  await server.close();
});

describe('event ingest', () => {
  it('stores an event once no matter how often it is resent', () => {
    const session = createSession({ funnelKey: FUNNEL });
    const event = makeEvent(session.sessionId, 'step_viewed', { step_id: 'intro' });

    const first = ingestEvents([event]);
    const second = ingestEvents([event]);
    const third = ingestEvents([event]);

    expect(first.accepted).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(second.accepted).toBe(0);
    expect(third.duplicates).toBe(1);
    expect(countEvents()).toBe(1);
  });

  it('accepts a batch and reports a verdict per event', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    const batch = [
      makeEvent(session.sessionId, 'session_started'),
      makeEvent(session.sessionId, 'step_viewed', { step_id: 'intro' }),
      makeEvent(session.sessionId, 'step_completed', { step_id: 'intro' }),
    ];

    const res = await server.post('/api/events', { events: batch });
    expect(res.status).toBe(200);
    expect(res.received).toBe(3);
    expect(res.accepted).toBe(3);
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r: any) => r.status === 'accepted')).toBe(true);
  });

  it('is safe to replay an entire batch after a timeout', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    const batch = Array.from({ length: 12 }, (_, i) =>
      makeEvent(session.sessionId, 'step_viewed', { step_id: `step_${i}`, client_seq: i }),
    );

    const first = await server.post('/api/events', { events: batch });
    const retry = await server.post('/api/events', { events: batch });
    const retryAgain = await server.post('/api/events', { events: batch });

    expect(first.accepted).toBe(12);
    expect(retry.accepted).toBe(0);
    expect(retry.duplicates).toBe(12);
    expect(retryAgain.duplicates).toBe(12);
    expect(countEvents()).toBe(12);
  });

  it('rejects only the malformed event and stores its siblings', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    const batch = [
      makeEvent(session.sessionId, 'step_viewed', { step_id: 'intro' }),
      { event_id: 'no-session-here', session_id: 'does-not-exist', type: 'step_viewed' },
      makeEvent(session.sessionId, 'step_completed', { step_id: 'intro' }),
      { session_id: session.sessionId, type: 'step_viewed' }, // missing event_id
      makeEvent(session.sessionId, 'result_viewed', { step_id: 'result' }),
      { event_id: 'bad-name-event', session_id: session.sessionId, type: 'Not A Name' },
    ];

    const res = await server.post('/api/events', { events: batch });

    expect(res.status).toBe(200);
    expect(res.accepted).toBe(3);
    expect(res.rejected).toBe(3);
    expect(countEvents()).toBe(3);

    const reasons = res.results.filter((r: any) => r.status === 'rejected');
    expect(reasons).toHaveLength(3);
  });

  it('keeps a rejection trail rather than dropping bad events silently', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    await server.post('/api/events', {
      events: [
        makeEvent(session.sessionId, 'step_viewed', { step_id: 'intro' }),
        { event_id: 'rejected-one', session_id: 'nope', type: 'step_viewed' },
      ],
    });

    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM event_rejections')
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('labels events from the session row, ignoring client-supplied version and variant', () => {
    const session = createSession({ funnelKey: FUNNEL, variantOverride: 'B' });
    ingestEvents([
      makeEvent(session.sessionId, 'step_viewed', {
        step_id: 'intro',
        version: 999,
        variant: 'Z',
      }),
    ]);

    const row = getDb()
      .prepare('SELECT version, variant, funnel_key, experiment_id FROM events LIMIT 1')
      .get() as { version: number; variant: string; funnel_key: string; experiment_id: string };

    expect(row.version).toBe(1);
    expect(row.variant).toBe('B');
    expect(row.funnel_key).toBe(FUNNEL);
    expect(row.experiment_id).toBe('question-order-and-result-framing-v1');
  });

  it('rejects an event the session version does not declare', () => {
    const session = createSession({ funnelKey: FUNNEL });
    const res = ingestEvents([makeEvent(session.sessionId, 'help_opened', { step_id: 'intro' })]);

    expect(res.rejected).toBe(1);
    expect(res.results[0].error).toMatch(/not declared by funnel version 1/);
    expect(countEvents()).toBe(0);
  });

  it('accepts an event a newer config version introduces, with no schema change', () => {
    // v2 declares `help_opened` in events.allowed. No migration, no server edit.
    publishV2();
    const session = createSession({ funnelKey: FUNNEL });
    expect(session.version).toBe(2);

    const res = ingestEvents([
      makeEvent(session.sessionId, 'help_opened', { step_id: 'intro', props: { surface: 'inline' } }),
    ]);
    expect(res.accepted).toBe(1);

    const row = getDb().prepare(`SELECT type FROM events LIMIT 1`).get() as { type: string };
    expect(row.type).toBe('help_opened');
  });

  it('refuses an oversized batch instead of silently truncating it', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    const huge = Array.from({ length: 501 }, () => makeEvent(session.sessionId, 'step_viewed'));
    const res = await server.post('/api/events', { events: huge });
    expect(res.status).toBe(413);
    expect(countEvents()).toBe(0);
  });
});
