/**
 * Агрегация аналитики. Три правила действуют для каждого числа ниже:
 *
 *  1. Считаем сессии, а не события: везде COUNT(DISTINCT session_id), поэтому
 *     повторный просмотр и ретрай батча не двигают ни одну метрику.
 *  2. Никогда не читаем события как последовательность — опоздавшее событие
 *     попадает ровно в то же множество, что и пришедшее вовремя.
 *  3. Конверсия шага — это `step_completed / step_viewed`, поэтому она остаётся
 *     верной при ветвлении, в отличие от сравнения с соседом по массиву.
 */
import { getDb } from './db.ts';
import { CORE_EVENT_TYPES, type FunnelConfig, type StepType } from '@shared/funnel';
import { getVersion, getActiveVersionRow, parseConfig } from './versions.ts';

export interface AnalyticsFilters {
  funnelKey: string;
  version?: number | null;
  variant?: string | null;
  campaign?: string | null;
  /** Сессии генератора трафика; включены по умолчанию. */
  includeSynthetic?: boolean;
  /** Сессии с вариантом из тестового `?variant=`; по умолчанию исключены. */
  includeOverrides?: boolean;
}

export interface StepMetrics {
  stepId: string;
  title: string;
  /** Уникальные сессии, видевшие шаг хотя бы раз. */
  reached: number;
  /** Уникальные сессии, ответившие и прошедшие дальше. */
  completed: number;
  dropOff: number;
  /** completed / reached — конверсия шага в шаг. */
  completionRate: number;
  dropOffRate: number;
  /** reached / startedSessions — накопительный вид воронки. */
  reachFromStart: number;
  backs: number;
  /** Всего step_viewed / reached — как часто шаг пересматривают. */
  viewsPerSession: number;
}

export interface SegmentMetrics {
  label: string;
  version?: number;
  variant?: string;
  startedSessions: number;
  resultSessions: number;
  ctaSessions: number;
  /** Основная метрика: уникальные сессии с cta_clicked / уникальные начавшие. */
  ctaClickRate: number;
  resultRate: number;
  /** CTR по CTA среди дошедших до экрана результата. */
  ctaCtrOnResult: number;
  steps: StepMetrics[];
}

export interface CustomEventMetric {
  type: string;
  events: number;
  sessions: number;
}

/**
 * Две группы, и деление не косметическое: `scoped` пересчитывается под фильтрами,
 * а `allTime` не может — подавленный дубль и отклонённое событие не стали строками,
 * поэтому их не к чему отнести ни к кампании, ни к версии.
 */
export interface DataQuality {
  scoped: {
    totalEvents: number;
    distinctSessions: number;
    /** События, чей порядок прихода расходится с client_seq. */
    outOfOrderEvents: number;
    /** step_viewed сверх первого на пару (сессия, шаг). */
    repeatStepViews: number;
  };
  allTime: {
    duplicatesSuppressed: number;
    rejectedEvents: number;
  };
}

export interface AnalyticsReport {
  funnelKey: string;
  filters: AnalyticsFilters;
  overall: SegmentMetrics;
  byVariant: SegmentMetrics[];
  byVersion: SegmentMetrics[];
  customEvents: CustomEventMetric[];
  dataQuality: DataQuality;
  campaigns: string[];
  versions: number[];
  variants: string[];
  experiment: { id: string; variants: string[]; assignment: string } | null;
  results: ResultBreakdown[];
}

export interface ResultBreakdown {
  resultId: string;
  title: string;
  sessions: number;
  share: number;
  ctaSessions: number;
  ctaRate: number;
}

interface Where {
  sql: string;
  params: (string | number)[];
}

/**
 * Общий WHERE. Контракт: `extra` всегда добавляется ПОСЛЕ фильтров, чтобы
 * вызывающий мог дописать своё значение в конец params. Нарушение порядка молча
 * искажает каждый отфильтрованный сегмент.
 */
function buildWhere(f: AnalyticsFilters, extra: string[] = []): Where {
  const clauses = ['e.funnel_key = ?'];
  const params: (string | number)[] = [f.funnelKey];

  if (f.version != null) {
    clauses.push('e.version = ?');
    params.push(f.version);
  }
  if (f.variant) {
    clauses.push('e.variant = ?');
    params.push(f.variant);
  }
  if (f.campaign) {
    clauses.push('e.utm_campaign = ?');
    params.push(f.campaign);
  }
  if (f.includeSynthetic === false) clauses.push('e.synthetic = 0');
  if (f.includeOverrides !== true) clauses.push(`s.variant_source = 'assigned'`);

  clauses.push(...extra);
  return { sql: clauses.join(' AND '), params };
}

const BASE_FROM = `FROM events e JOIN sessions s ON s.session_id = e.session_id`;

function distinctSessions(f: AnalyticsFilters, type: string): number {
  const w = buildWhere(f, ['e.type = ?']);
  const row = getDb()
    .prepare(`SELECT COUNT(DISTINCT e.session_id) AS n ${BASE_FROM} WHERE ${w.sql}`)
    .get(...w.params, type) as { n: number };
  return row.n;
}

/** Id шагов типа `result`: они меряются отдельно, а не как вопросы. */
function resultStepIds(funnelKey: string): Set<string> {
  const ids = new Set<string>();
  for (const cfg of configsFor(funnelKey)) {
    for (const [id, step] of Object.entries(cfg.steps ?? {})) {
      if (step.type === 'result') ids.add(id);
    }
  }
  return ids;
}

function configsFor(funnelKey: string, version?: number | null): FunnelConfig[] {
  const versions = version != null ? [version] : listVersionNumbers(funnelKey);
  const out: FunnelConfig[] = [];
  for (const v of [...versions].sort((a, b) => b - a)) {
    const row = getVersion(funnelKey, v);
    if (row) out.push(parseConfig(row));
  }
  if (out.length === 0) {
    const active = getActiveVersionRow(funnelKey);
    if (active) out.push(parseConfig(active));
  }
  return out;
}

/**
 * Единого «истинного» порядка шагов нет: варианты упорядочивают их по-разному.
 * Берём первый вариант как основу и дописываем всё, что просят только другие
 * варианты или старые версии, чтобы ничьи цифры не пропали.
 */
function stepOrderFor(f: AnalyticsFilters): { id: string; title: string; type: StepType }[] {
  const ordered: { id: string; title: string; type: StepType }[] = [];
  const seen = new Set<string>();

  for (const cfg of configsFor(f.funnelKey, f.version)) {
    const variants = Object.values(cfg.experiment?.variants ?? {});
    const sequences = f.variant && cfg.experiment?.variants?.[f.variant]
      ? [cfg.experiment.variants[f.variant].stepSequence ?? []]
      : variants.map((v) => v.stepSequence ?? []);

    const ids = [...sequences.flat(), ...Object.keys(cfg.steps ?? {})];
    for (const id of ids) {
      const step = cfg.steps?.[id];
      if (!step || seen.has(id)) continue;
      seen.add(id);
      ordered.push({ id, title: step.content?.title ?? id, type: step.type });
    }
  }
  return ordered;
}

function listVersionNumbers(funnelKey: string): number[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT version FROM funnel_versions WHERE funnel_key = ? ORDER BY version')
    .all(funnelKey) as { version: number }[];
  return rows.map((r) => r.version);
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function stepMetrics(f: AnalyticsFilters, startedSessions: number): StepMetrics[] {
  const db = getDb();
  const order = stepOrderFor(f);

  const w = buildWhere(f, [`e.step_id IS NOT NULL`]);
  const rows = db
    .prepare(
      `SELECT e.step_id AS step_id,
              COUNT(DISTINCT CASE WHEN e.type = 'step_viewed'    THEN e.session_id END) AS reached,
              COUNT(DISTINCT CASE WHEN e.type = 'step_completed' THEN e.session_id END) AS completed,
              COUNT(DISTINCT CASE WHEN e.type = 'back_clicked'   THEN e.session_id END) AS backs,
              SUM(CASE WHEN e.type = 'step_viewed' THEN 1 ELSE 0 END)                   AS views
       ${BASE_FROM}
       WHERE ${w.sql}
       GROUP BY e.step_id`,
    )
    .all(...w.params) as {
    step_id: string;
    reached: number;
    completed: number;
    backs: number;
    views: number;
  }[];

  const byId = new Map(rows.map((r) => [r.step_id, r]));
  const resultIds = resultStepIds(f.funnelKey);

  // Шаги, которые есть в данных, но не в известных конфигах, тоже показываем:
  // правка конфига мимо приложения не должна молча прятать трафик.
  const extras = rows.filter(
    (r) => !order.some((o) => o.id === r.step_id) && !resultIds.has(r.step_id),
  );
  const allSteps = [
    ...order.filter((o) => !resultIds.has(o.id)),
    ...extras.map((r) => ({ id: r.step_id, title: r.step_id, type: 'info' as StepType })),
  ];

  return allSteps.map(({ id, title }) => {
    const r = byId.get(id);
    const reached = r?.reached ?? 0;
    const completed = r?.completed ?? 0;
    const dropOff = Math.max(0, reached - completed);
    return {
      stepId: id,
      title,
      reached,
      completed,
      dropOff,
      completionRate: safeRate(completed, reached),
      dropOffRate: safeRate(dropOff, reached),
      reachFromStart: safeRate(reached, startedSessions),
      backs: r?.backs ?? 0,
      viewsPerSession: safeRate(r?.views ?? 0, reached),
    };
  });
}

function segment(f: AnalyticsFilters, label: string): SegmentMetrics {
  const startedSessions = distinctSessions(f, 'session_started');
  const resultSessions = distinctSessions(f, 'result_viewed');
  const ctaSessions = distinctSessions(f, 'cta_clicked');

  return {
    label,
    version: f.version ?? undefined,
    variant: f.variant ?? undefined,
    startedSessions,
    resultSessions,
    ctaSessions,
    ctaClickRate: safeRate(ctaSessions, startedSessions),
    resultRate: safeRate(resultSessions, startedSessions),
    ctaCtrOnResult: safeRate(ctaSessions, resultSessions),
    steps: stepMetrics(f, startedSessions),
  };
}

function dataQuality(f: AnalyticsFilters): DataQuality {
  const db = getDb();
  const w = buildWhere(f);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT e.session_id) AS sessions
       ${BASE_FROM} WHERE ${w.sql}`,
    )
    .get(...w.params) as { events: number; sessions: number };

  // «Пришло не по порядку» — это расхождение порядка клиента с порядком нашего приёма.
  const ooo = db
    .prepare(
      `WITH scoped AS (
         SELECT e.event_id, e.session_id, e.client_seq, e.server_ts, e.rowid AS rid
         ${BASE_FROM} WHERE ${w.sql} AND e.client_seq IS NOT NULL
       ), ranked AS (
         SELECT session_id,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY client_seq, rid)  AS r_client,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY server_ts, rid)   AS r_server
         FROM scoped
       )
       SELECT COUNT(*) AS n FROM ranked WHERE r_client <> r_server`,
    )
    .get(...w.params) as { n: number };

  const repeats = db
    .prepare(
      `WITH per_step AS (
         SELECT e.session_id, e.step_id, COUNT(*) AS c
         ${BASE_FROM} WHERE ${w.sql} AND e.type = 'step_viewed' AND e.step_id IS NOT NULL
         GROUP BY e.session_id, e.step_id
       )
       SELECT COALESCE(SUM(c - 1), 0) AS n FROM per_step`,
    )
    .get(...w.params) as { n: number };

  const suppressed = db
    .prepare(`SELECT COALESCE(SUM(value), 0) AS n FROM ingest_counters WHERE key = 'duplicates'`)
    .get() as { n: number };

  const rejected = db
    .prepare('SELECT COUNT(*) AS n FROM event_rejections')
    .get() as { n: number };

  return {
    scoped: {
      totalEvents: totals.events,
      distinctSessions: totals.sessions,
      outOfOrderEvents: ooo.n,
      repeatStepViews: repeats.n,
    },
    allTime: {
      duplicatesSuppressed: suppressed.n,
      rejectedEvents: rejected.n,
    },
  };
}

function customEvents(f: AnalyticsFilters): CustomEventMetric[] {
  const w = buildWhere(f);
  const placeholders = CORE_EVENT_TYPES.map(() => '?').join(', ');
  return getDb()
    .prepare(
      `SELECT e.type AS type, COUNT(*) AS events, COUNT(DISTINCT e.session_id) AS sessions
       ${BASE_FROM}
       WHERE ${w.sql} AND e.type NOT IN (${placeholders})
       GROUP BY e.type ORDER BY events DESC`,
    )
    .all(...w.params, ...CORE_EVENT_TYPES) as CustomEventMetric[];
}

/** Распределение результатов по свойству `result_id`, которое конфиг объявляет на result_viewed и cta_clicked. */
function resultBreakdown(f: AnalyticsFilters, total: number): ResultBreakdown[] {
  const w = buildWhere(f, [`e.type IN ('result_viewed', 'cta_clicked')`]);
  const rows = getDb()
    .prepare(
      `SELECT json_extract(e.props_json, '$.result_id') AS result_id,
              COUNT(DISTINCT CASE WHEN e.type = 'result_viewed' THEN e.session_id END) AS sessions,
              COUNT(DISTINCT CASE WHEN e.type = 'cta_clicked'   THEN e.session_id END) AS cta
       ${BASE_FROM}
       WHERE ${w.sql} AND json_extract(e.props_json, '$.result_id') IS NOT NULL
       GROUP BY result_id
       ORDER BY sessions DESC`,
    )
    .all(...w.params) as { result_id: string; sessions: number; cta: number }[];

  const titles = new Map<string, string>();
  for (const cfg of configsFor(f.funnelKey, f.version)) {
    for (const [id, r] of Object.entries(cfg.results ?? {})) {
      if (!titles.has(id)) titles.set(id, r.title ?? id);
    }
  }

  return rows.map((r) => ({
    resultId: r.result_id,
    title: titles.get(r.result_id) ?? r.result_id,
    sessions: r.sessions,
    share: safeRate(r.sessions, total),
    ctaSessions: r.cta,
    ctaRate: safeRate(r.cta, r.sessions),
  }));
}

export function listCampaigns(funnelKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT utm_campaign AS c FROM events
       WHERE funnel_key = ? AND utm_campaign IS NOT NULL ORDER BY utm_campaign`,
    )
    .all(funnelKey) as { c: string }[];
  return rows.map((r) => r.c);
}

function listVariants(funnelKey: string): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT variant AS v FROM sessions WHERE funnel_key = ? ORDER BY variant')
    .all(funnelKey) as { v: string }[];
  return rows.map((r) => r.v);
}

export function buildReport(filters: AnalyticsFilters): AnalyticsReport {
  const f: AnalyticsFilters = { includeSynthetic: true, includeOverrides: false, ...filters };

  const versions = listVersionNumbers(f.funnelKey);
  const variants = listVariants(f.funnelKey);

  const activeRow = getActiveVersionRow(f.funnelKey);
  const activeConfig = activeRow ? parseConfig(activeRow) : null;
  const overall = segment(f, 'All traffic');

  return {
    funnelKey: f.funnelKey,
    filters: f,
    overall,
    byVariant: variants.map((v) => segment({ ...f, variant: v }, `Variant ${v}`)),
    byVersion: versions.map((v) => segment({ ...f, version: v }, `v${v}`)),
    customEvents: customEvents(f),
    dataQuality: dataQuality(f),
    campaigns: listCampaigns(f.funnelKey),
    versions,
    variants,
    experiment: activeConfig
      ? {
          id: activeConfig.experiment?.id ?? '',
          variants: Object.keys(activeConfig.experiment?.variants ?? {}),
          assignment: activeConfig.experiment?.assignment ?? 'server',
        }
      : null,
    results: resultBreakdown(f, overall.resultSessions),
  };
}
