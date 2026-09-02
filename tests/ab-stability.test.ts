/**
 * Requirement 7.1: "стабильность A/B-варианта" — assignment happens on the
 * server, survives refresh, and only moves when the documented override says so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { publishV2, seedV1, useFreshDb, loadConfig } from './helpers.ts';
import { buildView, createSession, getSession } from '../server/sessions.ts';
import { assignVariant, hash32 } from '../server/ab.ts';
import { resolveVariantConfig } from '@shared/funnel';

describe('A/B assignment', () => {
  beforeEach(() => {
    useFreshDb();
    seedV1();
  });

  it('is stable across resume (refresh does not re-roll)', () => {
    const created = createSession({ funnelKey: 'quickcash' });
    for (let i = 0; i < 10; i += 1) {
      expect(buildView(getSession(created.sessionId)!).variant).toBe(created.variant);
    }
  });

  it('is a pure function of session id and experiment key', () => {
    const config = loadConfig('v1-quickcash.json');
    const first = assignVariant(config, 'session-abc');
    for (let i = 0; i < 50; i += 1) {
      expect(assignVariant(config, 'session-abc').variant).toBe(first.variant);
    }
    expect(hash32('session-abc')).toBe(hash32('session-abc'));
  });

  it('honours the query-parameter override and records it as an override', () => {
    const forcedB = createSession({ funnelKey: 'quickcash', variantOverride: 'B' });
    expect(forcedB.variant).toBe('B');
    expect(forcedB.variantSource).toBe('override');

    const forcedA = createSession({ funnelKey: 'quickcash', variantOverride: 'A' });
    expect(forcedA.variant).toBe('A');
    expect(forcedA.variantSource).toBe('override');
  });

  it('ignores an override naming a variant the config does not define', () => {
    const session = createSession({ funnelKey: 'quickcash', variantOverride: 'Z' });
    expect(['A', 'B']).toContain(session.variant);
    expect(session.variantSource).toBe('assigned');
  });

  it('splits roughly evenly across many sessions', () => {
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 400; i += 1) {
      counts[createSession({ funnelKey: 'quickcash' }).variant] += 1;
    }
    // Equal weights: allow a generous band, we are testing "not degenerate".
    expect(counts.A).toBeGreaterThan(140);
    expect(counts.B).toBeGreaterThan(140);
    expect(counts.A + counts.B).toBe(400);
  });

  it('gives each variant its own resolved config', () => {
    const a = createSession({ funnelKey: 'quickcash', variantOverride: 'A' });
    const b = createSession({ funnelKey: 'quickcash', variantOverride: 'B' });

    // Variant B is the amount-first ordering.
    expect(a.config.steps[1].id).toBe('goal');
    expect(b.config.steps[1].id).toBe('amount');
  });

  it('keeps a pinned session on its own variant config after a new version publishes', () => {
    const session = createSession({ funnelKey: 'quickcash', variantOverride: 'B' });
    publishV2();

    const resumed = buildView(getSession(session.sessionId)!);
    expect(resumed.variant).toBe('B');
    // v2 removes `preferences` for B; the v1 session must still have it.
    expect(resumed.config.steps.some((s) => s.id === 'preferences')).toBe(true);

    const v2ForB = resolveVariantConfig(loadConfig('v2-quickcash.json'), 'B');
    expect(v2ForB.steps.some((s) => s.id === 'preferences')).toBe(false);
  });
});
