/**
 * The pure engine: branching, variant resolution, validation and the progress
 * rule that only counts steps the user can actually reach.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from './helpers.ts';
import {
  RESULT,
  computeProgress,
  configErrors,
  firstStepId,
  nextStepId,
  numericBucket,
  reachablePath,
  resolveVariantConfig,
  stepById,
  summariseAnswer,
  validateAnswer,
  validateConfig,
  type Answers,
  type FunnelConfig,
  type NumberStep,
  type SelectStep,
} from '@shared/funnel';

const v1 = loadConfig('v1-quickcash.json');
const v2 = loadConfig('v2-quickcash.json');
const cardmatch = loadConfig('v1-cardmatch.json');

function walk(config: FunnelConfig, answers: Answers): string[] {
  const path: string[] = [];
  let cursor = firstStepId(config);
  let guard = 0;
  while (cursor !== RESULT && guard < 50) {
    path.push(cursor);
    cursor = nextStepId(config, cursor, answers);
    guard += 1;
  }
  return path;
}

describe('config validation', () => {
  it('accepts every config shipped in the repo', () => {
    expect(configErrors(v1)).toEqual([]);
    expect(configErrors(v2)).toEqual([]);
    expect(configErrors(cardmatch)).toEqual([]);
  });

  it('requires at least six screens and one branch', () => {
    const short = { ...v1, steps: v1.steps.slice(0, 3) };
    expect(configErrors(short as FunnelConfig).join(' ')).toMatch(/at least 6 screens/);

    const linear = {
      ...v1,
      steps: v1.steps.map((s) => ({ ...s, next: undefined })),
    };
    expect(configErrors(linear as FunnelConfig).join(' ')).toMatch(/conditional branch/);
  });

  it('warns when a branch has no default transition', () => {
    const risky = JSON.parse(JSON.stringify(v1)) as FunnelConfig;
    (risky.steps[1] as any).next = [
      { when: { all: [{ field: 'goal', op: 'eq', value: 'business' }] }, goto: 'amount' },
    ];
    const warnings = validateConfig(risky).filter((i) => i.level === 'warning');
    expect(warnings.some((w) => /no default transition/.test(w.message))).toBe(true);
  });
});

describe('conditional branching', () => {
  it('routes business intent through the revenue question', () => {
    const A = resolveVariantConfig(v1, 'A');
    const path = walk(A, { goal: 'business', amount: 10000, income: 3000 });
    expect(path).toContain('business_revenue');
    expect(path).not.toContain('low_income_notice');
  });

  it('routes low income to the affordability notice and skips the credit questions', () => {
    const A = resolveVariantConfig(v1, 'A');
    const path = walk(A, { goal: 'home_improvement', amount: 5000, income: 900 });
    expect(path).toContain('low_income_notice');
    expect(path).not.toContain('credit_band');
    expect(path).not.toContain('employment');
  });

  it('adds the refinance branch in v2 only', () => {
    const a1 = resolveVariantConfig(v1, 'A');
    const a2 = resolveVariantConfig(v2, 'A');
    const answers = { goal: 'debt_consolidation', amount: 8000, income: 3000 };

    expect(walk(a1, answers)).not.toContain('refinance_details');
    expect(walk(a2, answers)).toContain('refinance_details');
  });

  it('handles the cardmatch balance-transfer branch', () => {
    const A = resolveVariantConfig(cardmatch, 'A');
    expect(walk(A, { card_use: 'balance_transfer', monthly_spend: 500 })).toContain('existing_balance');
    expect(walk(A, { card_use: 'rewards', monthly_spend: 500 })).not.toContain('existing_balance');
    expect(walk(A, { card_use: 'rewards', monthly_spend: 3000 })).toContain('premium_notice');
  });
});

describe('variant resolution', () => {
  it('reorders steps for the amount-first variant', () => {
    const A = resolveVariantConfig(v1, 'A');
    const B = resolveVariantConfig(v1, 'B');
    expect(A.steps[1].id).toBe('goal');
    expect(B.steps[1].id).toBe('amount');
    expect(walk(B, { goal: 'home_improvement', amount: 5000, income: 3000 })[1]).toBe('amount');
  });

  it('removes a step for variant B and repairs the transitions into it', () => {
    const B = resolveVariantConfig(v2, 'B');
    expect(B.steps.some((s) => s.id === 'preferences')).toBe(false);

    // `employment` and `low_income_notice` both pointed at `preferences`.
    expect(nextStepId(B, 'employment', {})).toBe(RESULT);
    expect(nextStepId(B, 'low_income_notice', {})).toBe(RESULT);

    const path = walk(B, { goal: 'home_improvement', amount: 5000, income: 3000 });
    expect(path).not.toContain('preferences');
    expect(path[path.length - 1]).toBe('employment');
  });

  it('keeps variant A untouched when B removes a step', () => {
    const A = resolveVariantConfig(v2, 'A');
    expect(A.steps.some((s) => s.id === 'preferences')).toBe(true);
    expect(walk(A, { goal: 'home_improvement', amount: 5000, income: 3000 })).toContain('preferences');
  });

  it('merges the result-screen override without losing untouched fields', () => {
    const B = resolveVariantConfig(v1, 'B');
    expect(B.result.title).toBe('Your indicative offer is ready');
    // href was not overridden, so it survives from the base config.
    expect(B.result.cta.href).toBe('#offers');
    expect(B.result.cta.label).toBe('See my offer');
  });

  it('falls back to the base config for an unknown variant instead of throwing', () => {
    const unknown = resolveVariantConfig(v1, 'Z');
    expect(unknown.steps).toHaveLength(v1.steps.length);
  });
});

describe('progress', () => {
  it('counts only steps the user can still reach', () => {
    const A = resolveVariantConfig(v1, 'A');

    // Low income cuts out credit_band and employment.
    const lowIncome = computeProgress(A, 'low_income_notice', { income: 900 }, ['intro', 'goal', 'amount', 'income']);
    // Normal income keeps them.
    const normal = computeProgress(A, 'credit_band', { income: 4000 }, ['intro', 'goal', 'amount', 'income']);

    expect(lowIncome.total).toBeLessThan(normal.total);
    expect(lowIncome.total).toBe(6); // 4 behind + notice + preferences
    expect(normal.total).toBe(7); // 4 behind + credit_band + employment + preferences
  });

  it('never exceeds 100% and reaches 100% at the result', () => {
    const A = resolveVariantConfig(v1, 'A');
    const done = computeProgress(A, RESULT, {}, ['intro', 'goal', 'amount', 'income']);
    expect(done.percent).toBe(100);

    const mid = computeProgress(A, 'goal', {}, ['intro']);
    expect(mid.percent).toBeGreaterThanOrEqual(0);
    expect(mid.percent).toBeLessThan(100);
  });

  it('does not double-count a step already in history', () => {
    const A = resolveVariantConfig(v1, 'A');
    const p = computeProgress(A, 'goal', {}, ['intro', 'goal']);
    expect(p.position).toBe(2);
  });

  it('gives a stable estimate before a branch is decided', () => {
    const A = resolveVariantConfig(v1, 'A');
    const path = reachablePath(A, 'income', {});
    expect(path[0]).toBe('income');
    expect(path.length).toBeGreaterThan(1);
  });
});

describe('answer validation', () => {
  const goal = stepById(v1, 'goal') as SelectStep;
  const amount = stepById(v1, 'amount') as NumberStep;
  const preferences = stepById(v1, 'preferences') as SelectStep;

  it('accepts a known option and rejects an unknown one', () => {
    expect(validateAnswer(goal, 'business').ok).toBe(true);
    expect(validateAnswer(goal, 'not_an_option').ok).toBe(false);
    expect(validateAnswer(goal, undefined).ok).toBe(false);
  });

  it('enforces numeric bounds and coerces numeric strings', () => {
    expect(validateAnswer(amount, 10000)).toMatchObject({ ok: true, value: 10000 });
    expect(validateAnswer(amount, '12000')).toMatchObject({ ok: true, value: 12000 });
    expect(validateAnswer(amount, 500).ok).toBe(false);
    expect(validateAnswer(amount, 999999).ok).toBe(false);
    expect(validateAnswer(amount, 'abc').ok).toBe(false);
  });

  it('enforces min and max selections on a multi-select', () => {
    expect(validateAnswer(preferences, ['lowest_rate']).ok).toBe(true);
    expect(validateAnswer(preferences, ['lowest_rate', 'no_fees']).ok).toBe(true);
    expect(validateAnswer(preferences, []).ok).toBe(false);
    expect(validateAnswer(preferences, ['lowest_rate', 'no_fees', 'fast_payout']).ok).toBe(false);
    expect(validateAnswer(preferences, ['lowest_rate', 'lowest_rate']).ok).toBe(false);
  });

  it('treats an info screen as always valid', () => {
    const intro = stepById(v1, 'intro')!;
    expect(validateAnswer(intro, null).ok).toBe(true);
  });
});

describe('analytics-safe answer summaries', () => {
  it('keeps config-defined option ids but buckets free numeric input', () => {
    const amount = stepById(v1, 'amount') as NumberStep;
    const goal = stepById(v1, 'goal') as SelectStep;

    expect(summariseAnswer(goal, 'business')).toEqual({
      answer_kind: 'single_select',
      option_id: 'business',
    });

    const summary = summariseAnswer(amount, 27350) as Record<string, unknown>;
    expect(summary.answer_kind).toBe('number');
    // The exact figure the user typed must not appear.
    expect(JSON.stringify(summary)).not.toContain('27350');
    expect(typeof summary.bucket).toBe('string');
  });

  it('buckets monotonically', () => {
    const amount = stepById(v1, 'amount') as NumberStep;
    expect(numericBucket(amount, 1000)).not.toBe(numericBucket(amount, 49000));
    expect(numericBucket(amount, null)).toBe('unknown');
  });
});
