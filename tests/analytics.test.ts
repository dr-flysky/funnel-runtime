/**
 * Requirement 7.1: "расчёт основных аналитических показателей", and section 5's
 * demand that the numbers survive repeat views, Back, duplicates and events
 * that arrive out of order.
 *
 * Every case here builds a hand-countable scenario so the expected values are
 * obvious by inspection rather than by trusting the implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FUNNEL, makeEvent, publishV2, seedV1, useFreshDb } from './helpers.ts';
import { createSession } from '../server/sessions.ts';
import { ingestEvents } from '../server/events.ts';
import { buildReport } from '../server/analytics.ts';

function newSession(variant?: 'A' | 'B', campaign?: string) {
  return createSession({
    funnelKey: FUNNEL,
    variantOverride: variant,
    utm: campaign ? { utm_campaign: campaign } : undefined,
  });
}

/** Walk a session through the given steps, emitting the usual event trio. */
function walk(
  sessionId: string,
  steps: string[],
  opts: { complete?: boolean; resultId?: string } = {},
) {
  const events: Record<string, unknown>[] = [makeEvent(sessionId, 'session_started')];
  steps.forEach((step, i) => {
    events.push(makeEvent(sessionId, 'step_viewed', { step_id: step, client_seq: i * 3 + 1 }));
    events.push(makeEvent(sessionId, 'answer_submitted', { step_id: step, client_seq: i * 3 + 2 }));
    events.push(makeEvent(sessionId, 'step_completed', { step_id: step, client_seq: i * 3 + 3 }));
  });
  if (opts.complete) {
    events.push(
      makeEvent(sessionId, 'result_viewed', {
        step_id: 'result',
        props: { result_id: opts.resultId ?? 'balanced' },
      }),
    );
  }
  ingestEvents(events);
  return events;
}

describe('analytics aggregation', () => {
  beforeEach(() => {
    useFreshDb();
    seedV1();
  });

  it('counts unique sessions, not events', () => {
    const s = newSession();
    // The same step viewed five times is still one session on that step.
    ingestEvents([
      makeEvent(s.sessionId, 'session_started'),
      ...Array.from({ length: 5 }, (_, i) =>
        makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size', client_seq: i }),
      ),
    ]);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const teamSize = report.overall.steps.find((x) => x.stepId === 'team_size')!;

    expect(report.overall.startedSessions).toBe(1);
    expect(teamSize.reached).toBe(1);
    expect(teamSize.viewsPerSession).toBe(5);
  });

  it('is unaffected by duplicate events', () => {
    const s = newSession();
    const events = [
      makeEvent(s.sessionId, 'session_started'),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size' }),
      makeEvent(s.sessionId, 'step_completed', { step_id: 'team_size' }),
    ];
    ingestEvents(events);
    ingestEvents(events); // the retry
    ingestEvents(events); // and another

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const teamSize = report.overall.steps.find((x) => x.stepId === 'team_size')!;
    expect(report.overall.startedSessions).toBe(1);
    expect(teamSize.reached).toBe(1);
    expect(teamSize.completed).toBe(1);
    expect(teamSize.completionRate).toBe(1);
  });

  it('produces the same numbers whatever order events arrive in', () => {
    const forward = newSession();
    const events = walk(forward.sessionId, ['team_size', 'work_mode', 'priorities'], { complete: true });

    const shuffled = newSession();
    const reversed = events
      .map((e) => ({ ...e, event_id: `r-${String(e.event_id)}`, session_id: shuffled.sessionId }))
      .reverse();
    ingestEvents(reversed);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const a = report.byVariant;

    // Both sessions did identical things; totals must be exactly double.
    expect(report.overall.startedSessions).toBe(2);
    expect(report.overall.resultSessions).toBe(2);
    const teamSize = report.overall.steps.find((x) => x.stepId === 'team_size')!;
    expect(teamSize.reached).toBe(2);
    expect(teamSize.completed).toBe(2);
    expect(a.length).toBeGreaterThan(0);
  });

  it('computes drop-off as reached minus completed', () => {
    // 3 sessions see `priorities`; only 1 gets past it.
    const a = newSession();
    const b = newSession();
    const c = newSession();

    walk(a.sessionId, ['team_size', 'priorities']);
    ingestEvents([
      makeEvent(b.sessionId, 'session_started'),
      makeEvent(b.sessionId, 'step_viewed', { step_id: 'priorities' }),
    ]);
    ingestEvents([
      makeEvent(c.sessionId, 'session_started'),
      makeEvent(c.sessionId, 'step_viewed', { step_id: 'priorities' }),
    ]);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const priorities = report.overall.steps.find((x) => x.stepId === 'priorities')!;

    expect(priorities.reached).toBe(3);
    expect(priorities.completed).toBe(1);
    expect(priorities.dropOff).toBe(2);
    expect(priorities.completionRate).toBeCloseTo(1 / 3, 5);
    expect(priorities.dropOffRate).toBeCloseTo(2 / 3, 5);
  });

  it('does not let Back inflate conversion', () => {
    const s = newSession();
    ingestEvents([
      makeEvent(s.sessionId, 'session_started'),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size', client_seq: 1 }),
      makeEvent(s.sessionId, 'step_completed', { step_id: 'team_size', client_seq: 2 }),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'work_mode', client_seq: 3 }),
      makeEvent(s.sessionId, 'back_clicked', { step_id: 'work_mode', client_seq: 4 }),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size', client_seq: 5 }),
      makeEvent(s.sessionId, 'step_completed', { step_id: 'team_size', client_seq: 6 }),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'work_mode', client_seq: 7 }),
    ]);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const teamSize = report.overall.steps.find((x) => x.stepId === 'team_size')!;
    const workMode = report.overall.steps.find((x) => x.stepId === 'work_mode')!;

    expect(teamSize.reached).toBe(1);
    expect(teamSize.completed).toBe(1);
    expect(teamSize.viewsPerSession).toBe(2);
    expect(workMode.reached).toBe(1);
    expect(workMode.completed).toBe(0);
    expect(workMode.backs).toBe(1);
  });

  it('computes the primary metric as unique CTA sessions over unique starts', () => {
    const clicked = newSession();
    const notClicked = newSession();

    walk(clicked.sessionId, ['team_size'], { complete: true });
    // Clicking twice must not double-count.
    ingestEvents([
      makeEvent(clicked.sessionId, 'cta_clicked', {
        step_id: 'result',
        props: { result_id: 'balanced', action: 'expand_recommendation' },
      }),
      makeEvent(clicked.sessionId, 'cta_clicked', {
        step_id: 'result',
        props: { result_id: 'balanced', action: 'expand_recommendation' },
      }),
    ]);
    walk(notClicked.sessionId, ['team_size'], { complete: true });

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    expect(report.overall.startedSessions).toBe(2);
    expect(report.overall.resultSessions).toBe(2);
    expect(report.overall.ctaSessions).toBe(1);
    expect(report.overall.ctaClickRate).toBe(0.5);
    expect(report.overall.ctaCtrOnResult).toBe(0.5);
  });

  it('splits metrics by variant and the parts sum to the whole', () => {
    const a1 = newSession('A');
    const a2 = newSession('A');
    const b1 = newSession('B');

    walk(a1.sessionId, ['team_size'], { complete: true });
    ingestEvents([
      makeEvent(a1.sessionId, 'cta_clicked', {
        step_id: 'result',
        props: { result_id: 'balanced', action: 'expand_recommendation' },
      }),
    ]);
    walk(a2.sessionId, ['team_size']);
    walk(b1.sessionId, ['team_size'], { complete: true });

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const A = report.byVariant.find((v) => v.variant === 'A')!;
    const B = report.byVariant.find((v) => v.variant === 'B')!;

    expect(A.startedSessions).toBe(2);
    expect(B.startedSessions).toBe(1);
    expect(A.startedSessions + B.startedSessions).toBe(report.overall.startedSessions);
    expect(A.ctaSessions).toBe(1);
    expect(B.ctaSessions).toBe(0);
    expect(A.ctaClickRate).toBe(0.5);
  });

  it('filters by UTM campaign', () => {
    const brand = newSession('A', 'brand_search');
    const email = newSession('A', 'winback_sep');
    walk(brand.sessionId, ['team_size'], { complete: true });
    walk(email.sessionId, ['team_size']);

    const all = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    expect(all.overall.startedSessions).toBe(2);

    const filtered = buildReport({
      funnelKey: FUNNEL,
      campaign: 'brand_search',
      includeOverrides: true,
    });
    expect(filtered.overall.startedSessions).toBe(1);
    expect(filtered.overall.resultSessions).toBe(1);
    expect(all.campaigns).toContain('brand_search');
    expect(all.campaigns).toContain('winback_sep');
  });

  it('splits metrics by version across a publish', () => {
    const onV1 = newSession('A');
    walk(onV1.sessionId, ['team_size'], { complete: true });

    publishV2();
    const onV2 = newSession('A');
    walk(onV2.sessionId, ['team_size'], { complete: true });

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const v1 = report.byVersion.find((v) => v.version === 1)!;
    const v2 = report.byVersion.find((v) => v.version === 2)!;

    expect(v1.startedSessions).toBe(1);
    expect(v2.startedSessions).toBe(1);
    expect(report.overall.startedSessions).toBe(2);
    expect(report.versions).toEqual([1, 2]);
  });

  it('excludes override sessions from the experiment read-out by default', () => {
    const forced = newSession('A');
    walk(forced.sessionId, ['team_size'], { complete: true });

    const clean = buildReport({ funnelKey: FUNNEL });
    const withOverrides = buildReport({ funnelKey: FUNNEL, includeOverrides: true });

    expect(clean.overall.startedSessions).toBe(0);
    expect(withOverrides.overall.startedSessions).toBe(1);
  });

  it('reports an event a newer version introduces, with no schema change', () => {
    publishV2();
    const s = newSession('A');
    ingestEvents([
      makeEvent(s.sessionId, 'session_started'),
      makeEvent(s.sessionId, 'help_opened', { step_id: 'priorities' }),
      makeEvent(s.sessionId, 'help_opened', { step_id: 'team_size' }),
    ]);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const help = report.customEvents.find((c) => c.type === 'help_opened')!;
    expect(help.events).toBe(2);
    expect(help.sessions).toBe(1);
  });

  it('breaks results down by unique session, not by event', () => {
    const a = newSession('A');
    const b = newSession('A');
    const c = newSession('A');

    walk(a.sessionId, ['team_size'], { complete: true, resultId: 'async_native' });
    walk(b.sessionId, ['team_size'], { complete: true, resultId: 'async_native' });
    walk(c.sessionId, ['team_size'], { complete: true, resultId: 'office_core' });

    // A refresh of the result screen must not inflate the share.
    ingestEvents([
      makeEvent(a.sessionId, 'result_viewed', {
        step_id: 'result',
        props: { result_id: 'async_native' },
      }),
    ]);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const async_ = report.results.find((r) => r.resultId === 'async_native')!;
    const office = report.results.find((r) => r.resultId === 'office_core')!;

    expect(async_.sessions).toBe(2);
    expect(async_.title).toBe('Async-native');
    expect(office.sessions).toBe(1);
    expect(async_.share).toBeCloseTo(2 / 3, 5);
  });

  it('surfaces data-quality counters so the numbers can be trusted', () => {
    const s = newSession('A');
    const events = [
      makeEvent(s.sessionId, 'session_started'),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size', client_seq: 1 }),
      makeEvent(s.sessionId, 'step_viewed', { step_id: 'team_size', client_seq: 2 }),
    ];
    ingestEvents(events);
    ingestEvents(events);

    const report = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    expect(report.dataQuality.scoped.distinctSessions).toBe(1);
    expect(report.dataQuality.scoped.totalEvents).toBe(3);
    expect(report.dataQuality.scoped.repeatStepViews).toBe(1);
    expect(report.dataQuality.allTime.duplicatesSuppressed).toBe(3);
  });

  /**
   * The split exists because these two groups behave differently under a
   * filter. Asserting that keeps anyone from "tidying" them back together.
   */
  it('narrows scoped counters under a filter but not the all-time ones', () => {
    const kept = newSession('A', 'keep');
    const other = newSession('A', 'drop');
    const events = [
      makeEvent(kept.sessionId, 'session_started'),
      makeEvent(other.sessionId, 'session_started'),
    ];
    ingestEvents(events);
    ingestEvents(events); // duplicates, suppressed at write time

    const all = buildReport({ funnelKey: FUNNEL, includeOverrides: true });
    const one = buildReport({ funnelKey: FUNNEL, campaign: 'keep', includeOverrides: true });

    expect(one.dataQuality.scoped.distinctSessions).toBeLessThan(
      all.dataQuality.scoped.distinctSessions,
    );
    // A suppressed duplicate never became a row, so it cannot be attributed to
    // a campaign — the all-time tally is identical under both.
    expect(one.dataQuality.allTime.duplicatesSuppressed).toBe(
      all.dataQuality.allTime.duplicatesSuppressed,
    );
  });
});
