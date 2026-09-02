/**
 * Requirement 7.1: "закрепление версии за сессией" — a session is pinned to the
 * version it started on, and a publish must not move it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { publishV2, seedV1, useFreshDb } from './helpers.ts';
import { buildView, createSession, getSession, submitAnswer } from '../server/sessions.ts';
import { getActiveVersionRow, listVersions, rollbackToPrevious } from '../server/versions.ts';

describe('version pinning', () => {
  beforeEach(() => {
    useFreshDb();
    seedV1();
  });

  it('pins a session to the version that was active when it started', () => {
    const session = createSession({ funnelKey: 'quickcash' });
    expect(session.version).toBe(1);

    publishV2();
    expect(getActiveVersionRow('quickcash')!.version).toBe(2);

    const resumed = buildView(getSession(session.sessionId)!);
    expect(resumed.version).toBe(1);
  });

  it('starts new sessions on the newly published version', () => {
    const before = createSession({ funnelKey: 'quickcash' });
    publishV2();
    const after = createSession({ funnelKey: 'quickcash' });

    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
  });

  it('keeps an in-flight session usable across a publish', () => {
    // Pin the variant so the step after `intro` is deterministic: variant B
    // reorders the funnel to ask for the amount first.
    const session = createSession({ funnelKey: 'quickcash', variantOverride: 'A' });
    submitAnswer(session.sessionId, 'intro', null);

    publishV2();

    // The step the user is on came from v1 and must still resolve and advance.
    const view = buildView(getSession(session.sessionId)!);
    expect(view.version).toBe(1);
    const result = submitAnswer(session.sessionId, view.currentStep, 'home_improvement');
    expect(result.ok).toBe(true);
    expect(result.view!.version).toBe(1);
  });

  it('serves the old session its own config, not the new one', () => {
    const session = createSession({ funnelKey: 'quickcash' });
    publishV2();

    const old = buildView(getSession(session.sessionId)!);
    const fresh = createSession({ funnelKey: 'quickcash' });

    // refinance_details only exists from v2 onwards.
    expect(old.config.steps.some((s) => s.id === 'refinance_details')).toBe(false);
    expect(fresh.config.steps.some((s) => s.id === 'refinance_details')).toBe(true);
  });

  it('leaves sessions on the rolled-back-from version running after a rollback', () => {
    publishV2();
    const onV2 = createSession({ funnelKey: 'quickcash' });
    expect(onV2.version).toBe(2);

    rollbackToPrevious('quickcash');
    expect(getActiveVersionRow('quickcash')!.version).toBe(1);

    // Documented policy: a live session never migrates across configs.
    const resumed = buildView(getSession(onV2.sessionId)!);
    expect(resumed.version).toBe(2);
    expect(submitAnswer(onV2.sessionId, resumed.currentStep, null).ok).toBe(true);

    expect(createSession({ funnelKey: 'quickcash' }).version).toBe(1);
  });

  it('never mutates a published config row', () => {
    const v1Before = JSON.stringify(listVersions('quickcash').find((v) => v.version === 1));
    publishV2();
    rollbackToPrevious('quickcash');
    const v1After = listVersions('quickcash').find((v) => v.version === 1);

    // isActive flips, so compare the immutable identity fields.
    const before = JSON.parse(v1Before);
    expect(v1After!.id).toBe(before.id);
    expect(v1After!.createdAt).toBe(before.createdAt);
    expect(v1After!.stepCount).toBe(before.stepCount);
  });
});
