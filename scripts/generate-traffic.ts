/**
 * Генератор синтетического трафика.
 *
 * Поднимает настоящее HTTP-приложение на случайном порту и ходит по нему как браузер,
 * поэтому батчевый эндпоинт, валидация и правила навигации реально задействованы,
 * а не обойдены прямой записью в таблицы.
 *
 * Специально делает «грязный» трафик: оба варианта и несколько кампаний, все ветки
 * и результаты, отвалы на разных шагах, повторные просмотры после «назад»,
 * перепосланные после таймаута батчи, события не по порядку и битые события внутри
 * нормальных батчей. Свойства событий — ровно те, что объявлены в конфиге.
 *
 * Запуск: npm run generate:traffic -- [sessions] [--seed=42] [--funnel=id]
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { getDb } from '../server/db.ts';
import { getActiveVersionRow } from '../server/versions.ts';
import type { ResolvedFunnel, StepDef } from '@shared/funnel';

/** Детерминированный ГПСЧ: одинаковый seed — одинаковый трафик. */
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
const SEED = Number(flag('seed', '20260903'));
const FUNNEL_KEY = flag('funnel', process.env.DEFAULT_FUNNEL_KEY ?? 'workstyle-planner');

const rnd = mulberry32(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number): boolean => rnd() < p;

const CAMPAIGNS = [
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand_search', utm_content: 'headline_a' },
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'remote_work_generic', utm_content: 'headline_b' },
  { utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'managers_q3', utm_content: 'carousel' },
  { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'winback_sep', utm_content: 'plain_text' },
  { utm_source: 'reddit', utm_medium: 'paid_social', utm_campaign: 'r_managers', utm_content: 'video_15s' },
  { utm_source: 'organic', utm_medium: 'referral', utm_campaign: 'comparison_site', utm_content: 'listing' },
];

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

/** Правдоподобный ответ; числа смещены так, чтобы все ветки и результаты получили трафик. */
function synthesiseAnswer(step: StepDef): unknown {
  switch (step.type) {
    case 'info':
    case 'result':
      return null;

    case 'single-select': {
      const options = step.input?.options ?? [];
      if (options.length === 0) return null;
      return pick(options).value;
    }

    case 'multi-select': {
      const options = step.input?.options ?? [];
      const min = Math.max(step.validation?.minSelections ?? 1, 1);
      const max = Math.min(step.validation?.maxSelections ?? options.length, options.length);
      const count = min + Math.floor(rnd() * (max - min + 1));
      const shuffled = [...options].sort(() => rnd() - 0.5);
      return shuffled.slice(0, count).map((o) => o.value);
    }

    case 'number': {
      const min = step.input?.min ?? 0;
      const max = step.input?.max ?? min + 100;
      // Смещение к небольшим командам и малому числу офисных дней.
      const skewed = chance(0.65) ? min + (max - min) * rnd() * 0.35 : min + rnd() * (max - min);
      const increment = step.input?.step ?? 1;
      const value = Math.round(skewed / increment) * increment;
      return Math.min(max, Math.max(min, value));
    }

    default:
      return null;
  }
}

/** Чем дальше шаг, тем реже уходят; сильнее всего теряет свободный ввод числа. */
function dropOffProbability(step: StepDef, depth: number): number {
  const base = step.type === 'number' ? 0.14 : step.type === 'multi-select' ? 0.1 : 0.07;
  const fatigue = Math.max(0, 0.05 - depth * 0.005);
  return Math.min(0.4, base + fatigue);
}

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

interface Stats {
  sessions: number;
  completed: number;
  ctaClicks: number;
  backs: number;
  helpOpens: number;
  dropOffs: Record<string, number>;
  variants: Record<string, number>;
  stepHits: Record<string, number>;
  results: Record<string, number>;
}

/** Один смоделированный посетитель. */
async function runSession(base: string, stats: Stats, allEvents: QueuedEvent[][]): Promise<void> {
  const utm = pick(CAMPAIGNS);
  const created = await postJson(base, '/api/session', {
    funnelKey: FUNNEL_KEY,
    utm,
    synthetic: true,
  });
  if (!created.sessionId) throw new Error(`session creation failed: ${JSON.stringify(created)}`);

  const buf = new SessionBuffer(created.sessionId);
  const funnel = created.funnel as ResolvedFunnel;
  const stepOf = (id: string | null): StepDef | undefined =>
    id ? funnel.steps.find((s) => s.id === id) : undefined;

  stats.sessions += 1;
  stats.variants[created.variant] = (stats.variants[created.variant] ?? 0) + 1;
  buf.emit('session_started');

  let view = created;
  let guard = 0;

  while (view.currentStep && guard < 40) {
    guard += 1;
    const step = stepOf(view.currentStep);
    if (!step) break;

    if (step.type === 'result') {
      stats.completed += 1;
      const resultId = view.resultId;
      stats.results[resultId] = (stats.results[resultId] ?? 0) + 1;

      buf.emit('result_viewed', step.id, { result_id: resultId });
      // Обновление экрана результата не должно ничего задваивать.
      if (chance(0.25)) buf.emit('result_viewed', step.id, { result_id: resultId });
      if (chance(0.42)) {
        stats.ctaClicks += 1;
        const action = view.result?.cta?.action ?? 'expand_recommendation';
        buf.emit('cta_clicked', step.id, { result_id: resultId, action });
        if (chance(0.1)) buf.emit('cta_clicked', step.id, { result_id: resultId, action });
      }
      break;
    }

    stats.stepHits[step.id] = (stats.stepHits[step.id] ?? 0) + 1;
    buf.emit('step_viewed', step.id, {
      step_type: step.type,
      visible_step_index: view.progress.visibleIndex,
      visible_step_count: view.progress.visibleCount,
    });

    // Подсказка — на тех же двух условиях, что и в клиенте: у шага есть текст
    // и версия сессии объявила событие.
    if (step.content?.body && funnel.allowedEvents?.includes('help_opened') && chance(0.2)) {
      stats.helpOpens += 1;
      buf.emit('help_opened', step.id, { surface: 'inline' });
    }

    if (chance(dropOffProbability(step, guard))) {
      stats.dropOffs[step.id] = (stats.dropOffs[step.id] ?? 0) + 1;
      allEvents.push(buf.events);
      return;
    }

    // Часть пользователей возвращается на шаг назад и идёт вперёд снова — отсюда повторные step_viewed.
    if (view.canGoBack && chance(0.18)) {
      const back = await postJson(base, `/api/session/${created.sessionId}/back`, {});
      if (back.currentStep) {
        buf.emit('back_clicked', step.id, { destination_step_id: back.currentStep });
        stats.backs += 1;
        view = back;
        continue;
      }
    }

    const answered = await postJson(base, `/api/session/${created.sessionId}/answer`, {
      stepId: step.id,
      value: synthesiseAnswer(step),
    });

    if (answered.status >= 400) {
      stats.dropOffs[step.id] = (stats.dropOffs[step.id] ?? 0) + 1;
      allEvents.push(buf.events);
      return;
    }

    if (step.type !== 'info') {
      buf.emit('answer_submitted', step.id, answered.answerSummary ?? {});
    }
    buf.emit('step_completed', step.id, { next_step_id: answered.currentStep ?? null });
    view = answered;
  }

  allEvents.push(buf.events);
}

interface Delivery {
  batchesSent: number;
  eventsSent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  reordered: number;
}

/** Доставка: батчи, перестановки, ретраи и битые payload'ы. */
async function deliver(base: string, perSession: QueuedEvent[][]): Promise<Delivery> {
  const stats: Delivery = {
    batchesSent: 0, eventsSent: 0, accepted: 0, duplicates: 0, rejected: 0, reordered: 0,
  };

  // Перемешиваем сессии так, как они приходили бы от одновременных пользователей.
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

  // Меняем местами соседние пары, чтобы часть трафика действительно пришла не по порядку.
  for (let i = 1; i < queue.length; i += 1) {
    if (chance(0.06)) {
      [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]];
      stats.reordered += 1;
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

    // Битое событие не должно утянуть за собой соседей по батчу.
    if (chance(0.12)) {
      batch.splice(Math.floor(rnd() * batch.length), 0, {
        event_id: randomUUID(),
        session_id: 'session-that-does-not-exist',
        type: 'step_viewed',
      });
    }
    if (chance(0.08)) {
      batch.push({ event_id: randomUUID(), session_id: queue[i]?.session_id, type: 'NOT a valid name' });
    }

    await send(batch);

    // Имитация таймаута: клиент не увидел наш 200 и шлёт батч ещё раз.
    if (chance(0.15)) await send(batch);
  }

  return stats;
}

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

  console.log(
    `Generating ${SESSION_COUNT} sessions for "${FUNNEL_KEY}" (active v${active.version}, seed ${SEED})`,
  );

  const stats: Stats = {
    sessions: 0, completed: 0, ctaClicks: 0, backs: 0, helpOpens: 0,
    dropOffs: {}, variants: {}, stepHits: {}, results: {},
  };
  const perSession: QueuedEvent[][] = [];

  for (let i = 0; i < SESSION_COUNT; i += 1) {
    await runSession(base, stats, perSession);
    if ((i + 1) % 25 === 0) console.log(`  ...${i + 1} sessions walked`);
  }

  console.log('\nDelivering events:');
  const delivery = await deliver(base, perSession);
  server.close();

  const fmt = (o: Record<string, number>) =>
    Object.entries(o).map(([k, v]) => `${k}:${v}`).join('  ') || '—';

  console.log('\n--- Traffic summary -------------------------------------');
  console.log(`sessions            ${stats.sessions}`);
  console.log(`  variants          ${fmt(stats.variants)}`);
  console.log(`  reached result    ${stats.completed}`);
  console.log(`  clicked CTA       ${stats.ctaClicks}`);
  console.log(`  pressed Back      ${stats.backs}`);
  console.log(`  opened help       ${stats.helpOpens}  (only on versions declaring help_opened)`);
  console.log(`results             ${fmt(stats.results)}`);
  console.log(`steps entered       ${fmt(stats.stepHits)}`);
  console.log(`drop-off by step    ${fmt(stats.dropOffs)}`);
  console.log('--- Delivery --------------------------------------------');
  console.log(`batches sent        ${delivery.batchesSent}`);
  console.log(`events sent         ${delivery.eventsSent}`);
  console.log(`  accepted          ${delivery.accepted}`);
  console.log(`  duplicates        ${delivery.duplicates}  (retried batches, suppressed)`);
  console.log(`  rejected          ${delivery.rejected}  (malformed, siblings still stored)`);
  console.log(`  reordered pairs   ${delivery.reordered}`);
  console.log('---------------------------------------------------------');
  console.log('\nOpen /dashboard to see the aggregates.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
