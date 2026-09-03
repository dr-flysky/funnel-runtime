/** Стабильность A/B-варианта: назначение на сервере, переживает обновление и меняется только по override. */
import { beforeEach, describe, expect, it } from 'vitest';
import { FUNNEL, publishV2, seedV1, useFreshDb, loadConfig } from './helpers.ts';
import { buildView, createSession, getSession } from '../server/sessions.ts';
import { assignVariant, hash32 } from '../server/ab.ts';
import { resolveVariant } from '@shared/funnel';

describe('A/B assignment', () => {
  beforeEach(() => {
    useFreshDb();
    seedV1();
  });

  it('is stable across resume (refresh does not re-roll)', () => {
    const created = createSession({ funnelKey: FUNNEL });
    for (let i = 0; i < 10; i += 1) {
      expect(buildView(getSession(created.sessionId)!).variant).toBe(created.variant);
    }
  });

  it('is a pure function of session id and experiment id', () => {
    const config = loadConfig('funnel-v1.json');
    const first = assignVariant(config, 'session-abc');
    for (let i = 0; i < 50; i += 1) {
      expect(assignVariant(config, 'session-abc').variant).toBe(first.variant);
    }
    expect(hash32('session-abc')).toBe(hash32('session-abc'));
  });

  it('honours the query-parameter override and records it as an override', () => {
    const forcedB = createSession({ funnelKey: FUNNEL, variantOverride: 'B' });
    expect(forcedB.variant).toBe('B');
    expect(forcedB.variantSource).toBe('override');

    const forcedA = createSession({ funnelKey: FUNNEL, variantOverride: 'A' });
    expect(forcedA.variant).toBe('A');
    expect(forcedA.variantSource).toBe('override');
  });

  it('ignores an override naming a variant the config does not define', () => {
    const session = createSession({ funnelKey: FUNNEL, variantOverride: 'Z' });
    expect(['A', 'B']).toContain(session.variant);
    expect(session.variantSource).toBe('assigned');
  });

  it('splits roughly evenly across many sessions', () => {
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 400; i += 1) {
      counts[createSession({ funnelKey: FUNNEL }).variant] += 1;
    }
    // Веса равные; полоса широкая — проверяем «не вырождено», а не точность.
    expect(counts.A).toBeGreaterThan(140);
    expect(counts.B).toBeGreaterThan(140);
    expect(counts.A + counts.B).toBe(400);
  });

  it('gives each variant its own resolved config', () => {
    const a = createSession({ funnelKey: FUNNEL, variantOverride: 'A' });
    const b = createSession({ funnelKey: FUNNEL, variantOverride: 'B' });

    // A сначала спрашивает размер команды, B начинает с формата работы.
    expect(a.funnel.steps[1].id).toBe('team_size');
    expect(b.funnel.steps[1].id).toBe('work_mode');
    // B ещё и переформулирует интро.
    expect(b.funnel.steps[0].content.title).toBe('How should your team really work?');
  });

  it('keeps a pinned session on its own variant config after a new version publishes', () => {
    const session = createSession({ funnelKey: FUNNEL, variantOverride: 'B' });
    publishV2();

    const resumed = buildView(getSession(session.sessionId)!);
    expect(resumed.variant).toBe('B');
    // v2 убирает `tool_count` у B; сессия на v1 обязана его сохранить.
    expect(resumed.funnel.steps.some((s) => s.id === 'tool_count')).toBe(true);
  });

  it('records the experiment id on the session', () => {
    const session = createSession({ funnelKey: FUNNEL });
    expect(session.experimentId).toBe('question-order-and-result-framing-v1');
  });

  it('honours the weights the config declares', () => {
    const config = loadConfig('funnel-v1.json');
    expect(config.experiment.variants.A.weight).toBe(50);
    expect(config.experiment.variants.B.weight).toBe(50);
    expect(resolveVariant(config, 'A').variant).toBe('A');
  });
});
