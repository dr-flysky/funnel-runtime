/**
 * Session TTL.
 *
 * The config sets `session.ttlHours: 72`. Every write route already refuses an
 * expired session; the danger is the *read* route disagreeing with them, which
 * hands the client a funnel it can render but never submit. These tests pin the
 * contract: a session the server will not write to is not a session it serves.
 */
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { FUNNEL, seedV1, startServer, useFreshDb, type TestServer } from './helpers.ts';
import { createSession, getSession, isExpired, funnelForSession } from '../server/sessions.ts';
import { getDb } from '../server/db.ts';

/** Backdate a session so it is past the config's TTL. */
function age(sessionId: string, hours: number): void {
  const when = new Date(Date.now() - hours * 3_600_000).toISOString();
  getDb().prepare('UPDATE sessions SET created_at = ? WHERE session_id = ?').run(when, sessionId);
}

describe('session expiry', () => {
  let server: TestServer;

  beforeEach(async () => {
    useFreshDb();
    seedV1();
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('treats a session past the config TTL as expired', () => {
    const session = createSession({ funnelKey: FUNNEL });
    const row = getSession(session.sessionId)!;
    expect(isExpired(row, funnelForSession(row))).toBe(false);

    age(session.sessionId, 100); // TTL is 72h
    const aged = getSession(session.sessionId)!;
    expect(isExpired(aged, funnelForSession(aged))).toBe(true);
  });

  it('serves a live session normally', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    const res = await server.get(`/api/session/${session.sessionId}`);
    expect(res.status).toBe(200);
    expect(res.currentStep).toBe('intro');
  });

  /**
   * The bug this file exists for: resume answered 200 with a renderable view
   * while `answer` answered 400, so the user got a funnel that died on the
   * first Continue with no way to recover.
   */
  it('refuses to resume an expired session, rather than serving a dead view', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    age(session.sessionId, 100);

    const res = await server.get(`/api/session/${session.sessionId}`);
    expect(res.status).toBe(410);
    expect(res.error).toBe('Session expired.');
    expect(res.currentStep).toBeUndefined();
  });

  it('answers 410 — not 400 — when an expired session is written to', async () => {
    const session = createSession({ funnelKey: FUNNEL });
    age(session.sessionId, 100);

    const answered = await server.post(`/api/session/${session.sessionId}/answer`, {
      stepId: 'intro',
    });
    expect(answered.status).toBe(410);
    expect(answered.error).toBe('Session expired.');

    const back = await server.post(`/api/session/${session.sessionId}/back`, {});
    expect(back.status).toBe(410);
  });

  it('keeps 404 for an unknown session and 400 for a recoverable mistake', async () => {
    expect((await server.get('/api/session/no-such-session')).status).toBe(404);

    const session = createSession({ funnelKey: FUNNEL });
    // Wrong step id: the user can fix this in place, so it stays a 400.
    const stale = await server.post(`/api/session/${session.sessionId}/answer`, {
      stepId: 'tool_count',
      value: 3,
    });
    expect(stale.status).toBe(400);
  });

  it('starts a fresh session on the active version after one expires', async () => {
    const expired = createSession({ funnelKey: FUNNEL });
    age(expired.sessionId, 100);
    expect((await server.get(`/api/session/${expired.sessionId}`)).status).toBe(410);

    // What the client does with a 410: drop the id and start over.
    const fresh = await server.post('/api/session', { funnelKey: FUNNEL });
    expect(fresh.status).toBe(201);
    expect(fresh.sessionId).not.toBe(expired.sessionId);
    expect(fresh.currentStep).toBe('intro');
  });
});
