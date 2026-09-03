/** Публикация и откат версии без редеплоя, включая отказ активировать конфиг, который бросит трафик. */
import { beforeEach, describe, expect, it } from 'vitest';
import { FUNNEL, loadConfig, makeV2, seedV1, useFreshDb, publishV2 } from './helpers.ts';
import {
  ConfigValidationError,
  activateVersion,
  getActiveVersionRow,
  listActivations,
  listVersions,
  publishVersion,
  rollbackToPrevious,
} from '../server/versions.ts';
import { createSession } from '../server/sessions.ts';
import type { FunnelConfig } from '@shared/funnel';

describe('publish and rollback', () => {
  beforeEach(() => {
    useFreshDb();
    seedV1();
  });

  it('publishes a new version and makes it active without touching the old one', () => {
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(1);
    publishV2();

    const versions = listVersions(FUNNEL);
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.version === 2)!.isActive).toBe(true);
    expect(versions.find((v) => v.version === 1)!.isActive).toBe(false);
  });

  it('rolls back to the previously active version', () => {
    publishV2();
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(2);

    const rolled = rollbackToPrevious(FUNNEL);
    expect(rolled.version).toBe(1);
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(1);
  });

  it('keeps both versions available after a rollback (nothing is deleted)', () => {
    publishV2();
    rollbackToPrevious(FUNNEL);

    const versions = listVersions(FUNNEL);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it('can roll forward again by activating the newer version explicitly', () => {
    const v2 = publishV2();
    rollbackToPrevious(FUNNEL);
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(1);

    const target = listVersions(FUNNEL).find((v) => v.version === 2)!;
    activateVersion(FUNNEL, target.id);
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(2);
    expect(v2.version).toBe(2);
  });

  it('records an audit trail of every activation', () => {
    publishV2();
    rollbackToPrevious(FUNNEL);

    const log = listActivations(FUNNEL);
    expect(log[0].action).toBe('rollback');
    expect(log[0].version).toBe(1);
    expect(log[1].action).toBe('publish');
    expect(log[1].version).toBe(2);
    expect(log[2].action).toBe('publish');
    expect(log[2].version).toBe(1);
  });

  it('refuses a config whose sequence names a step that does not exist', () => {
    const broken = loadConfig('funnel-v1.json') as FunnelConfig;
    broken.experiment.variants.A.stepSequence.push('step_that_does_not_exist');

    expect(() => publishVersion(broken)).toThrow(ConfigValidationError);
    // Ничего не опубликовано, значит активный указатель не сдвинулся.
    expect(listVersions(FUNNEL)).toHaveLength(1);
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(1);
  });

  it('refuses a config with fewer than six screens', () => {
    const tooShort = loadConfig('funnel-v1.json') as FunnelConfig;
    tooShort.steps = { intro: tooShort.steps.intro, result: tooShort.steps.result };
    expect(() => publishVersion(tooShort)).toThrow(/at least 6 screens/);
  });

  it('refuses a config whose visibleWhen reads an answer collected later', () => {
    const broken = loadConfig('funnel-v1.json') as FunnelConfig;
    broken.experiment.variants.A.stepSequence = [
      'intro', 'office_days', 'work_mode', 'team_size', 'priorities',
      'timezone_span', 'async_maturity', 'tool_count', 'result',
    ];
    expect(() => publishVersion(broken)).toThrow(ConfigValidationError);
    expect(listVersions(FUNNEL)).toHaveLength(1);
  });

  it('accepts a variant that drops a step by omitting it from its sequence', () => {
    // Так итерация 2 убирает экран у одного варианта; тупика не будет — последовательность линейна.
    const summary = publishVersion(makeV2(), { note: 'v2' });
    expect(summary.version).toBe(2);
    expect(getActiveVersionRow(FUNNEL)!.version).toBe(2);
  });

  it('does not require a redeploy: the active pointer is data, not code', () => {
    const sessionBefore = createSession({ funnelKey: FUNNEL, variantOverride: 'A' });
    publishV2();
    const sessionAfter = createSession({ funnelKey: FUNNEL, variantOverride: 'A' });

    expect(sessionBefore.version).toBe(1);
    expect(sessionAfter.version).toBe(2);
    expect(sessionAfter.funnel.steps.some((s) => s.id === 'meeting_load')).toBe(true);
  });
});
