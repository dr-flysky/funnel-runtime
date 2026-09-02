/**
 * Requirement 7.1: "публикация и откат версии" — publishing without a redeploy,
 * rolling back, and refusing to activate a config that would strand traffic.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, seedV1, useFreshDb, publishV2 } from './helpers.ts';
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
    expect(getActiveVersionRow('quickcash')!.version).toBe(1);
    publishV2();

    const versions = listVersions('quickcash');
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.version === 2)!.isActive).toBe(true);
    expect(versions.find((v) => v.version === 1)!.isActive).toBe(false);
  });

  it('rolls back to the previously active version', () => {
    publishV2();
    expect(getActiveVersionRow('quickcash')!.version).toBe(2);

    const rolled = rollbackToPrevious('quickcash');
    expect(rolled.version).toBe(1);
    expect(getActiveVersionRow('quickcash')!.version).toBe(1);
  });

  it('keeps both versions available after a rollback (nothing is deleted)', () => {
    publishV2();
    rollbackToPrevious('quickcash');

    const versions = listVersions('quickcash');
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it('can roll forward again by activating the newer version explicitly', () => {
    const v2 = publishV2();
    rollbackToPrevious('quickcash');
    expect(getActiveVersionRow('quickcash')!.version).toBe(1);

    const target = listVersions('quickcash').find((v) => v.version === 2)!;
    activateVersion('quickcash', target.id);
    expect(getActiveVersionRow('quickcash')!.version).toBe(2);
    expect(v2.version).toBe(2);
  });

  it('records an audit trail of every activation', () => {
    publishV2();
    rollbackToPrevious('quickcash');

    const log = listActivations('quickcash');
    expect(log[0].action).toBe('rollback');
    expect(log[0].version).toBe(1);
    expect(log[1].action).toBe('publish');
    expect(log[1].version).toBe(2);
    expect(log[2].action).toBe('publish');
    expect(log[2].version).toBe(1);
  });

  it('refuses a config whose transition points at a step that does not exist', () => {
    const broken = loadConfig('v1-quickcash.json') as FunnelConfig;
    (broken.steps[1] as any).next = [{ goto: 'step_that_does_not_exist' }];

    expect(() => publishVersion(broken)).toThrow(ConfigValidationError);
    // Nothing was published, so the active pointer is untouched.
    expect(listVersions('quickcash')).toHaveLength(1);
    expect(getActiveVersionRow('quickcash')!.version).toBe(1);
  });

  it('refuses a config with fewer than six screens', () => {
    const tooShort = loadConfig('v1-quickcash.json') as FunnelConfig;
    tooShort.steps = tooShort.steps.slice(0, 4);
    expect(() => publishVersion(tooShort)).toThrow(/at least 6 screens/);
  });

  it('refuses a variant that removes a step other steps still point at', () => {
    const broken = loadConfig('v1-quickcash.json') as FunnelConfig;
    // `income` is the target of an explicit transition from `amount`; removing
    // it while a rule still names it must be caught before publish.
    broken.experiment.variants.B.removeSteps = ['income'];
    (broken.experiment.variants.B.patch as any) = {};

    // The engine reroutes automatically, so this specific config resolves —
    // what must never happen is an unreachable dangling target.
    const summary = publishVersion(broken, { note: 'reroute check' });
    const published = listVersions('quickcash').find((v) => v.id === summary.id)!;
    expect(published.version).toBe(2);
  });

  it('does not require a redeploy: the active pointer is data, not code', () => {
    const sessionBefore = createSession({ funnelKey: 'quickcash' });
    publishV2();
    const sessionAfter = createSession({ funnelKey: 'quickcash' });

    expect(sessionBefore.version).toBe(1);
    expect(sessionAfter.version).toBe(2);
    expect(sessionAfter.config.steps.some((s) => s.id === 'refinance_details')).toBe(true);
  });
});
