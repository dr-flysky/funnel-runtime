/**
 * The pure engine against the supplied config: variant resolution, visibility
 * branching, result rules, validation, and the progress policy.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, makeV2 } from './helpers.ts';
import {
  computeProgress,
  configErrors,
  firstStepId,
  nextStepId,
  previousStepId,
  resolveResultId,
  resolveVariant,
  stepById,
  summariseAnswer,
  validateAnswer,
  validateConfig,
  visibleSteps,
  type Answers,
  type FunnelConfig,
  type ResolvedFunnel,
} from '@shared/funnel';

const v1 = loadConfig('funnel-v1.json');

/** Walk the whole funnel with a fixed answer set, returning the step ids seen. */
function walk(funnel: ResolvedFunnel, answers: Answers): string[] {
  const path: string[] = [];
  let cursor = firstStepId(funnel, answers);
  let guard = 0;
  while (cursor && guard < 50) {
    path.push(cursor);
    cursor = nextStepId(funnel, cursor, answers);
    guard += 1;
  }
  return path;
}

describe('config validation', () => {
  it('accepts the supplied config with no errors or warnings', () => {
    expect(configErrors(v1)).toEqual([]);
    expect(validateConfig(v1).filter((i) => i.level === 'warning')).toEqual([]);
  });

  it('rejects a result rule pointing at a result that does not exist', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    broken.resultRules![0].resultId = 'no_such_result';
    expect(configErrors(broken).join(' ')).toMatch(/unknown result "no_such_result"/);
  });

  it('rejects a defaultResultId that is not defined', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    broken.defaultResultId = 'missing';
    expect(configErrors(broken).join(' ')).toMatch(/defaultResultId "missing"/);
  });

  it('rejects a stepSequence naming an unknown step', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    broken.experiment.variants.A.stepSequence.push('ghost_step');
    expect(configErrors(broken).join(' ')).toMatch(/sequences unknown step "ghost_step"/);
  });

  it('rejects a variant whose sequence has no result step', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    broken.experiment.variants.B.stepSequence =
      broken.experiment.variants.B.stepSequence.filter((id) => id !== 'result');
    expect(configErrors(broken).join(' ')).toMatch(/no result step/);
  });

  /**
   * The important one: `visibleWhen` reads an answer, so the step that supplies
   * that answer must come earlier in *this variant's* order. Otherwise the
   * predicate silently evaluates against an absent answer and the step vanishes.
   */
  it('rejects a visibleWhen gated on an answer collected later in the sequence', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    // Move office_days before work_mode, which gates it.
    broken.experiment.variants.A.stepSequence = [
      'intro', 'office_days', 'work_mode', 'team_size', 'priorities',
      'timezone_span', 'async_maturity', 'tool_count', 'result',
    ];
    expect(configErrors(broken).join(' ')).toMatch(/gated on "work_mode", which comes later/);
  });

  it('warns when a result declares a CTA action the client cannot perform', () => {
    const odd = structuredClone(v1) as FunnelConfig;
    odd.results.balanced.cta.action = 'open_checkout';

    // A warning, not an error: the client degrades to revealing the
    // recommendation rather than presenting a dead button.
    expect(configErrors(odd)).toEqual([]);
    const warnings = validateConfig(odd).filter((i) => i.level === 'warning');
    expect(warnings.some((w) => /open_checkout/.test(w.message))).toBe(true);
  });

  it('rejects a result step whose resultSource the engine cannot honour', () => {
    const odd = structuredClone(v1) as FunnelConfig;
    odd.steps.result.resultSource = 'externalScoringService';
    expect(configErrors(odd).join(' ')).toMatch(/unsupported resultSource/);
  });

  it('accepts the resultRules source the supplied config declares', () => {
    expect(v1.steps.result.resultSource).toBe('resultRules');
    expect(configErrors(v1)).toEqual([]);
  });

  it('rejects a config with fewer than six screens', () => {
    const broken = structuredClone(v1) as FunnelConfig;
    broken.steps = { intro: broken.steps.intro, result: broken.steps.result };
    expect(configErrors(broken).join(' ')).toMatch(/at least 6 screens/);
  });
});

describe('variant resolution', () => {
  it('orders steps by the variant stepSequence', () => {
    const A = resolveVariant(v1, 'A');
    const B = resolveVariant(v1, 'B');

    expect(A.steps.map((s) => s.id)).toEqual([
      'intro', 'team_size', 'work_mode', 'priorities',
      'timezone_span', 'office_days', 'async_maturity', 'tool_count', 'result',
    ]);
    expect(B.steps.map((s) => s.id)).toEqual([
      'intro', 'work_mode', 'timezone_span', 'team_size',
      'async_maturity', 'priorities', 'office_days', 'tool_count', 'result',
    ]);
  });

  it('deep-merges stepOverrides without dropping untouched fields', () => {
    const A = resolveVariant(v1, 'A');
    const B = resolveVariant(v1, 'B');

    expect(A.steps[0].content.title).toBe('Build a work model your team can actually follow');
    expect(B.steps[0].content.title).toBe('How should your team really work?');
    expect(B.steps[0].content.primaryActionLabel).toBe('Show me');

    // priorities is overridden for B in content only; its validation survives.
    const bPriorities = stepById(B, 'priorities')!;
    expect(bPriorities.content.title).toBe('What would make the biggest difference right now?');
    expect(bPriorities.validation?.maxSelections).toBe(3);
    expect(bPriorities.input?.options).toHaveLength(5);
  });

  it('applies resultOverrides per variant', () => {
    const A = resolveVariant(v1, 'A');
    const B = resolveVariant(v1, 'B');

    expect(A.results.async_native.title).toBe('Async-native');
    expect(B.results.async_native.title).toBe('Your team is ready to reduce meetings');
    expect(B.results.async_native.cta.label).toBe('See the 30-day action list');
    // Untouched fields survive the merge.
    expect(B.results.async_native.recommendations).toHaveLength(3);
  });

  it('falls back to a defined variant instead of throwing on an unknown one', () => {
    const unknown = resolveVariant(v1, 'Z');
    expect(unknown.steps.length).toBeGreaterThan(0);
    expect(['A', 'B']).toContain(unknown.variant);
  });
});

describe('conditional visibility', () => {
  it('hides office_days for a fully remote team', () => {
    const A = resolveVariant(v1, 'A');
    const path = walk(A, { work_mode: 'remote', async_maturity: 'low' });
    expect(path).not.toContain('office_days');
  });

  it('shows office_days for hybrid and office teams', () => {
    const A = resolveVariant(v1, 'A');
    expect(walk(A, { work_mode: 'hybrid' })).toContain('office_days');
    expect(walk(A, { work_mode: 'office' })).toContain('office_days');
  });

  it('skips the hidden step when navigating forward', () => {
    const A = resolveVariant(v1, 'A');
    const remote = { work_mode: 'remote' };
    expect(nextStepId(A, 'timezone_span', remote)).toBe('async_maturity');

    const hybrid = { work_mode: 'hybrid' };
    expect(nextStepId(A, 'timezone_span', hybrid)).toBe('office_days');
  });

  it('skips the hidden step when navigating back', () => {
    const A = resolveVariant(v1, 'A');
    expect(previousStepId(A, 'async_maturity', { work_mode: 'remote' })).toBe('timezone_span');
    expect(previousStepId(A, 'async_maturity', { work_mode: 'hybrid' })).toBe('office_days');
  });

  it('recomputes visibility when an earlier answer changes', () => {
    const A = resolveVariant(v1, 'A');
    const before = visibleSteps(A, { work_mode: 'hybrid' }).map((s) => s.id);
    const after = visibleSteps(A, { work_mode: 'remote' }).map((s) => s.id);

    expect(before).toContain('office_days');
    expect(after).not.toContain('office_days');
    expect(before.length).toBe(after.length + 1);
  });

  it('returns null at the end of the funnel', () => {
    const A = resolveVariant(v1, 'A');
    expect(nextStepId(A, 'result', {})).toBeNull();
    expect(previousStepId(A, 'intro', {})).toBeNull();
  });
});

describe('result rules', () => {
  const A = resolveVariant(v1, 'A');

  it('matches the first rule that passes, in config order', () => {
    // Remote + wide timezones satisfies the first branch of async_native.
    expect(resolveResultId(A, { work_mode: 'remote', timezone_span: 'wide' })).toBe('async_native');
    // High async maturity satisfies the second branch on its own, and
    // async_native is listed first, so it wins over hybrid_structured.
    expect(resolveResultId(A, { work_mode: 'hybrid', async_maturity: 'high' })).toBe('async_native');
  });

  it('falls through to later rules', () => {
    expect(resolveResultId(A, { work_mode: 'hybrid', async_maturity: 'low' })).toBe('hybrid_structured');
    expect(resolveResultId(A, { work_mode: 'office', async_maturity: 'low' })).toBe('office_core');
  });

  it('uses defaultResultId when nothing matches', () => {
    expect(resolveResultId(A, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'low' }))
      .toBe('balanced');
    expect(resolveResultId(A, {})).toBe('balanced');
  });

  it('evaluates nested any/all trees correctly', () => {
    // remote + same hours fails the `all`, and low maturity fails the `any`.
    expect(resolveResultId(A, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'medium' }))
      .toBe('balanced');
    // remote + global hours satisfies the `all`.
    expect(resolveResultId(A, { work_mode: 'remote', timezone_span: 'global', async_maturity: 'low' }))
      .toBe('async_native');
  });
});

describe('progress', () => {
  it('excludes info and result screens from the count', () => {
    const A = resolveVariant(v1, 'A');
    // Variant A hybrid path: 7 questions (intro and result are excluded).
    const p = computeProgress(A, 'team_size', { work_mode: 'hybrid' });
    expect(p.total).toBe(7);
  });

  it('counts only the steps this user can reach', () => {
    const A = resolveVariant(v1, 'A');
    const hybrid = computeProgress(A, 'team_size', { work_mode: 'hybrid' });
    const remote = computeProgress(A, 'team_size', { work_mode: 'remote' });

    // Remote hides office_days, so the denominator shrinks by one.
    expect(hybrid.total).toBe(7);
    expect(remote.total).toBe(6);
  });

  it('advances position and percent through the funnel', () => {
    const A = resolveVariant(v1, 'A');
    const answers = { work_mode: 'remote' };

    const first = computeProgress(A, 'team_size', answers);
    const later = computeProgress(A, 'async_maturity', answers);

    expect(first.position).toBe(1);
    expect(first.percent).toBe(0);
    expect(later.position).toBeGreaterThan(first.position);
    expect(later.percent).toBeGreaterThan(first.percent);
    expect(later.percent).toBeLessThanOrEqual(100);
  });

  it('reports visible index and count for the step_viewed event', () => {
    const A = resolveVariant(v1, 'A');
    const p = computeProgress(A, 'intro', { work_mode: 'remote' });
    expect(p.visibleIndex).toBe(0);
    // intro + 6 questions + result
    expect(p.visibleCount).toBe(8);
  });
});

describe('answer validation', () => {
  const A = resolveVariant(v1, 'A');
  const teamSize = stepById(A, 'team_size')!;
  const workMode = stepById(A, 'work_mode')!;
  const priorities = stepById(A, 'priorities')!;

  it('uses the message text the config supplies', () => {
    expect(validateAnswer(teamSize, null)).toEqual({
      ok: false,
      error: 'Enter the team size.',
    });
    expect(validateAnswer(teamSize, 0).error).toBe('The team must have at least one person.');
    expect(validateAnswer(teamSize, 500).error).toBe('For this demo, enter a value up to 200.');
    expect(validateAnswer(workMode, null).error).toBe("Select the team's main work mode.");
    expect(validateAnswer(priorities, []).error).toBe('Choose at least one priority.');
    expect(validateAnswer(priorities, ['speed', 'focus', 'cost', 'culture']).error).toBe(
      'Choose no more than three priorities.',
    );
  });

  it('accepts valid answers and coerces numeric strings', () => {
    expect(validateAnswer(teamSize, 12)).toEqual({ ok: true, value: 12 });
    expect(validateAnswer(teamSize, '12')).toEqual({ ok: true, value: 12 });
    expect(validateAnswer(workMode, 'hybrid')).toEqual({ ok: true, value: 'hybrid' });
    expect(validateAnswer(priorities, ['speed', 'focus'])).toEqual({
      ok: true,
      value: ['speed', 'focus'],
    });
  });

  it('rejects unknown options and duplicates', () => {
    expect(validateAnswer(workMode, 'hovercraft').ok).toBe(false);
    expect(validateAnswer(priorities, ['speed', 'speed']).ok).toBe(false);
    expect(validateAnswer(teamSize, 'not a number').ok).toBe(false);
  });

  it('treats info and result screens as always valid', () => {
    expect(validateAnswer(stepById(A, 'intro')!, null).ok).toBe(true);
    expect(validateAnswer(stepById(A, 'result')!, null).ok).toBe(true);
  });
});

describe('analytics-safe answer summaries', () => {
  it('emits the answer kind and nothing else', () => {
    const A = resolveVariant(v1, 'A');

    // The config sets events.privacy.storeRawAnswers to false and declares
    // answer_submitted with exactly one property: answer_kind.
    expect(summariseAnswer(stepById(A, 'work_mode')!)).toEqual({ answer_kind: 'single_select' });
    expect(summariseAnswer(stepById(A, 'priorities')!)).toEqual({ answer_kind: 'multi_select' });
    expect(summariseAnswer(stepById(A, 'team_size')!)).toEqual({ answer_kind: 'number' });

    // No value, bucket or option id may leak into the payload.
    const keys = Object.keys(summariseAnswer(stepById(A, 'team_size')!));
    expect(keys).toEqual(['answer_kind']);
  });
});

describe('a v2-shaped config', () => {
  const v2 = makeV2();

  it('validates', () => {
    expect(configErrors(v2)).toEqual([]);
  });

  it('adds a step behind a new condition for variant A only', () => {
    const A = resolveVariant(v2, 'A');
    const B = resolveVariant(v2, 'B');

    expect(A.steps.some((s) => s.id === 'meeting_load')).toBe(true);
    expect(walk(A, { work_mode: 'remote', async_maturity: 'low' })).toContain('meeting_load');
    expect(walk(A, { work_mode: 'remote', async_maturity: 'high' })).not.toContain('meeting_load');
    expect(B.steps.some((s) => s.id === 'meeting_load')).toBe(false);
  });

  it('drops a step for variant B by omitting it from the sequence', () => {
    const A = resolveVariant(v2, 'A');
    const B = resolveVariant(v2, 'B');

    expect(A.steps.some((s) => s.id === 'tool_count')).toBe(true);
    expect(B.steps.some((s) => s.id === 'tool_count')).toBe(false);

    // Omission cannot strand the user: the sequence is linear, so the step
    // after the removed one simply becomes next.
    const path = walk(B, { work_mode: 'remote', async_maturity: 'low' });
    expect(path).not.toContain('tool_count');
    expect(path[path.length - 1]).toBe('result');
  });
});
