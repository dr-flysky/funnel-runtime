/**
 * Synthetic traffic generator.
 *
 * Boots the real HTTP app on an ephemeral port and drives it the way a browser
 * would, so the batch endpoint, the validation path and the navigation rules
 * are all genuinely exercised — not bypassed by writing rows directly.
 *
 * It deliberately produces the messy traffic the brief asks for:
 *   - both variants and several UTM campaigns
 *   - every branch of the funnel, including the low-income and business paths
 *   - drop-off spread across different steps
 *   - repeated step views after Back
 *   - whole batches resent after a simulated timeout
 *   - events that arrive out of order
 *   - a few malformed events mixed into otherwise-valid batches
 *
 * Usage: npm run generate:traffic -- [sessions] [--seed=42] [--funnel=quickcash]
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { getDb } from '../server/db.ts';
import { getActiveVersionRow } from '../server/versions.ts';
import { RESULT, type FunnelConfig, type Step } from '@shared/funnel';

// ---------------------------------------------------------------------------
// Deterministic randomness — same seed, same traffic.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name: string, fallback: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SESSION_COUNT = Number(positional[0] ?? flag('sessions', '140'));
const SEED = Number(flag('seed', '20260902'));
const FUNNEL_KEY = flag('funnel', process.env.DEFAULT_FUNNEL_KEY ?? 'quickcash');

const rnd = mulberry32(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number): boolean => rnd() < p;

const CAMPAIGNS = [
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand_search', utm_content: 'headline_a' },
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'debt_generic', utm_content: 'headline_b' },
  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'lookalike_q3', utm_content: 'video_15s' },
  { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'winback_sep', utm_content: 'plain_text' },
  { utm_source: 'reddit', utm_medium: 'paid_social', utm_campaign: 'personalfinance', utm_content: 'carousel' },
  { utm_source: 'organic', utm_medium: 'referral', utm_campaign: 'comparison_site', utm_content: 'listing' },
];

// ---------------------------------------------------------------------------
// Event buffer
// ---------------------------------------------------------------------------

interface QueuedEvent {
  event_id: string;
  session_id: string;
  type: string;
  step_id?: string | null;
  client_ts: string;
  client_seq: number;
  props?: Record<string, unknown>;
}

let clock = Date.parse('2026-09-01T09:00:00.000Z');

function tick(msMax = 45_000): string {
  clock += 1_500 + Math.floor(rnd() * msMax);
  return new Date(clock).toISOString();
}

class SessionBuffer {
  private seq = 0;
  readonly events: QueuedEvent[] = [];
  constructor(readonly sessionId: string) {}

  emit(type: string, stepId?: string | null, props: Record<string, unknown> = {}): void {
    this.seq += 1;
    this.events.push({
      event_id: randomUUID(),
      session_id: this.sessionId,
      type,
      step_id: stepId ?? null,
      client_ts: tick(),
      client_seq: this.seq,
      props,
    });
  }
}

// ---------------------------------------------------------------------------
// Answer synthesis
// ---------------------------------------------------------------------------

/**
 * Pick a plausible answer. Numeric steps are skewed low ~30% of the time so
 * the low-income branch gets real traffic rather than a rounding error.
 */
function synthesiseAnswer(step: Step): unknown {
  switch (step.type) {
    case 'info':
      return null;
    case 'single_select':
      return pick(step.options).id;
    case 'multi_select': {
      const max = Math.min(step.maxSelected ?? 2, step.options.length);
      const min = Math.max(step.minSelected ?? 1, 1);
      const count = min + Math.floor(rnd() * (max - min + 1));
      const shuffled = [...step.options].sort(() => rnd() - 0.5);
      return shuffled.slice(0, count).map((o) => o.id);
    }
    case 'number': {
      const min = step.min ?? 0;
      const max = step.max ?? min + 1000;
      const lowBand = chance(0.3);
      const lo = min;
      const hi = lowBand ? min + (max - min) * 0.18 : max;
      const raw = lo + rnd() * (hi - lo);
      const stepSize = step.step ?? 1;
      return Math.round(raw / stepSize) * stepSize;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJson(base: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && res.status >= 500) throw new Error(`${path} -> ${res.status} ${text}`);
  return { status: res.status, ...json };
}

// ---------------------------------------------------------------------------
// One simulated visitor
// ---------------------------------------------------------------------------

interface Stats {
  sessions: number;
  completed: number;
  ctaClicks: number;
  backs: number;
  dropOffs: Record<string, number>;
  variants: Record<string, number>;
  branchHits: Record<string, number>;
}

async function runSession(base: string, stats: Stats, allEvents: QueuedEvent[][]): Promise<void> {
  const utm = pick(CAMPAIGNS);
  const created = await postJson(base, '/api/session', {
    funnelKey: FUNNEL_KEY,
    utm,
    synthetic: true,
  });
  if (!created.sessionId) throw new Error(`session creation failed: ${JSON.stringify(created)}`);

  const buf = new SessionBuffer(created.sessionId);
  const config = created.config as FunnelConfig;
  stats.sessions += 1;
  stats.variants[created.variant] = (stats.variants[created.variant] ?? 0) + 1;

  buf.emit('session_started', null, { variant: created.variant, version: created.version });

  let currentStep: string = created.currentStep;
  let guard = 0;
  const extraEvents = config.extraEvents ?? [];

  while (currentStep !== RESULT && guard < 40) {
    guard += 1;
    const step = config.steps.find((s) => s.id === currentStep);
    if (!step) break;

    stats.branchHits[step.id] = (stats.branchHits[step.id] ?? 0) + 1;
    buf.emit('step_viewed', step.id);

    // A version that declares extra event types gets them exercised.
    if (extraEvents.length > 0 && step.help && chance(0.12)) {
      buf.emit(pick(extraEvents), step.id, { surface: 'inline_help' });
    }

    // Abandon here?
    if (chance(dropOffProbability(step, guard))) {
      stats.dropOffs[step.id] = (stats.dropOffs[step.id] ?? 0) + 1;
      allEvents.push(buf.events);
      return;
    }

    // Some users step back, re-read the previous screen, then come forward
    // again — this is what produces repeat step_viewed events.
    if (guard > 1 && chance(0.18)) {
      const back = await postJson(base, `/api/session/${created.sessionId}/back`, {});
      if (back.currentStep) {
        buf.emit('back_clicked', step.id, { to: back.currentStep });
        stats.backs += 1;
        buf.emit('step_viewed', back.currentStep);
        const prevStep = config.steps.find((s) => s.id === back.currentStep);
        if (prevStep) {
          const replay = await postJson(base, `/api/session/${created.sessionId}/answer`, {
            stepId: prevStep.id,
            value: synthesiseAnswer(prevStep),
          });
          buf.emit('answer_submitted', prevStep.id, replay.answerSummary ?? {});
          buf.emit('step_completed', prevStep.id);
          currentStep = replay.currentStep;
          continue;
        }
      }
    }

    const value = synthesiseAnswer(step);
    const answered = await postJson(base, `/api/session/${created.sessionId}/answer`, {
      stepId: step.id,
      value,
    });

    if (answered.status >= 400) {
      // Validation refused it — treat as an abandon rather than looping.
      stats.dropOffs[step.id] = (stats.dropOffs[step.id] ?? 0) + 1;
      allEvents.push(buf.events);
      return;
    }

    buf.emit('answer_submitted', step.id, answered.answerSummary ?? {});
    buf.emit('step_completed', step.id);
    currentStep = answered.currentStep;
  }

  if (currentStep === RESULT) {
    stats.completed += 1;
    buf.emit('result_viewed', config.result.id, { result_id: config.result.id });
    // Re-viewing the result (refresh) must not double-count anything.
    if (chance(0.25)) buf.emit('result_viewed', config.result.id, { refresh: true });
    if (chance(0.42)) {
      stats.ctaClicks += 1;
      buf.emit('cta_clicked', config.result.id, { cta_id: config.result.cta.id });
      if (chance(0.1)) buf.emit('cta_clicked', config.result.id, { cta_id: config.result.cta.id });
    }
  }

  allEvents.push(buf.events);
}

/** Later steps are stickier; numeric questions bleed the most users. */
function dropOffProbability(step: Step, depth: number): number {
  const base = step.type === 'number' ? 0.16 : step.type === 'multi_select' ? 0.1 : 0.08;
  const fatigue = Math.max(0, 0.05 - depth * 0.005);
  return Math.min(0.4, base + fatigue);
}

// ---------------------------------------------------------------------------
// Delivery: batching, reordering, retries, bad payloads
// ---------------------------------------------------------------------------

interface Delivery {
  batchesSent: number;
  eventsSent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
}

async function deliver(base: string, perSession: QueuedEvent[][]): Promise<Delivery> {
  const stats: Delivery = { batchesSent: 0, eventsSent: 0, accepted: 0, duplicates: 0, rejected: 0 };

  // Interleave sessions the way concurrent users would arrive.
  const queue: QueuedEvent[] = [];
  const cursors = perSession.map((events) => ({ events, i: 0 }));
  while (cursors.some((c) => c.i < c.events.length)) {
    for (const c of cursors) {
      if (c.i < c.events.length) {
        const take = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < take && c.i < c.events.length; k += 1, c.i += 1) {
          queue.push(c.events[c.i]);
        }
      }
    }
  }

  // Swap adjacent pairs so a slice of traffic genuinely arrives out of order.
  let swaps = 0;
  for (let i = 1; i < queue.length; i += 1) {
    if (chance(0.06)) {
      [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]];
      swaps += 1;
    }
  }

  const send = async (events: unknown[]): Promise<void> => {
    const res = await postJson(base, '/api/events', { events });
    stats.batchesSent += 1;
    stats.eventsSent += events.length;
    stats.accepted += res.accepted ?? 0;
    stats.duplicates += res.duplicates ?? 0;
    stats.rejected += res.rejected ?? 0;
  };

  const BATCH = 25;
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch: unknown[] = queue.slice(i, i + BATCH);

    // A malformed event must not take its siblings down with it.
    if (chance(0.12)) {
      batch.splice(Math.floor(rnd() * batch.length), 0, {
        event_id: randomUUID(),
        session_id: 'session-that-does-not-exist',
        type: 'step_viewed',
      });
    }
    if (chance(0.08)) {
      batch.push({ event_id: randomUUID(), session_id: queue[i]?.session_id, type: 'NOT a valid type' });
    }

    await send(batch);

    // Simulated timeout: the client never saw our 200 and retries the batch.
    if (chance(0.15)) await send(batch);
  }

  console.log(`  reordered ${swaps} adjacent event pairs before sending`);
  return stats;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  getDb();
  const active = getActiveVersionRow(FUNNEL_KEY);
  if (!active) {
    console.error(`No active version for "${FUNNEL_KEY}". Run: npm run seed`);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log(`Generating ${SESSION_COUNT} sessions for "${FUNNEL_KEY}" (active v${active.version}, seed ${SEED})`);

  const stats: Stats = {
    sessions: 0, completed: 0, ctaClicks: 0, backs: 0,
    dropOffs: {}, variants: {}, branchHits: {},
  };
  const perSession: QueuedEvent[][] = [];

  for (let i = 0; i < SESSION_COUNT; i += 1) {
    await runSession(base, stats, perSession);
    if ((i + 1) % 25 === 0) console.log(`  ...${i + 1} sessions walked`);
  }

  console.log('\nDelivering events:');
  const delivery = await deliver(base, perSession);

  server.close();

  console.log('\n--- Traffic summary -------------------------------------');
  console.log(`sessions            ${stats.sessions}`);
  console.log(`  variants          ${Object.entries(stats.variants).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`  reached result    ${stats.completed}`);
  console.log(`  clicked CTA       ${stats.ctaClicks}`);
  console.log(`  pressed Back      ${stats.backs}`);
  console.log(`steps entered       ${Object.entries(stats.branchHits).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`drop-off by step    ${Object.entries(stats.dropOffs).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log('--- Delivery --------------------------------------------');
  console.log(`batches sent        ${delivery.batchesSent}`);
  console.log(`events sent         ${delivery.eventsSent}`);
  console.log(`  accepted          ${delivery.accepted}`);
  console.log(`  duplicates dropped${String(delivery.duplicates).padStart(4)}  (retried batches)`);
  console.log(`  rejected          ${delivery.rejected}  (malformed, siblings still stored)`);
  console.log('---------------------------------------------------------');
  console.log('\nOpen /dashboard to see the aggregates.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
