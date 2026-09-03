/**
 * Analytics aggregation.
 *
 * Three rules govern every number produced here:
 *
 *  1. **Count sessions, not events.** Every metric is a COUNT(DISTINCT
 *     session_id). A user who re-views a step ten times, or whose client
 *     retries a batch, moves no metric.
 *
 *  2. **Never read events as a sequence.** Nothing below sorts by timestamp to
 *     decide what happened. An event that arrives late, or out of order, lands
 *     in exactly the same set as one that arrived on time.
 *
 *  3. **Per-step conversion is `step_completed / step_viewed`.** The server
 *     only emits `step_completed` when it actually advanced the user, so this
 *     is a true step-to-step conversion that stays correct under branching —
 *     unlike comparing a step against its neighbour in array order, which is
 *     meaningless when users take different paths.
 */
import { getDb } from './db.ts';
import { CORE_EVENT_TYPES, type FunnelConfig, type StepType } from '@shared/funnel';
import { getVersion, getActiveVersionRow, parseConfig } from './versions.ts';

export interface AnalyticsFilters {
  funnelKey: string;
  version?: number | null;
  variant?: string | null;
  campaign?: string | null;
  /** Sessions created by the traffic generator. Included by default. */
  includeSynthetic?: boolean;
  /** Sessions whose variant came from the ?variant= test hatch. Excluded by default. */
  includeOverrides?: boolean;
}

export interface StepMetrics {
  stepId: string;
  title: string;
  /** Unique sessions that saw this step at least once. */
  reached: number;
  /** Unique sessions that answered it and moved on. */
  completed: number;
  /** reached - completed: saw it, never got past it. */
  dropOff: number;
  /** completed / reached — the step-to-step conversion. */
  completionRate: number;
  dropOffRate: number;
  /** reached / startedSessions — cumulative view of the funnel. */
  reachFromStart: number;
  /** Unique sessions that pressed Back on this step. */
  backs: number;
  /** Total step_viewed events / reached — how often a step gets re-seen. */
  viewsPerSession: number;
}

export interface SegmentMetrics {
  label: string;
  version?: number;
  variant?: string;
  startedSessions: number;
  resultSessions: number;
  ctaSessions: number;
  /** Primary metric: unique sessions with cta_clicked / unique sessions started. */
  ctaClickRate: number;
  /** Share of starters that reached the result screen. */
  resultRate: number;
  /** CTR of the CTA among sessions that actually saw the result screen. */
  ctaCtrOnResult: number;
  steps: StepMetrics[];
}

export interface CustomEventMetric {
  type: string;
  events: number;
  sessions: number;
}

/**
 * Two groups, and the split is not cosmetic.
 *
 * `scoped` re-runs under the current filters like every other metric.
 * `allTime` cannot: a suppressed duplicate and a rejected event never became
 * rows, so there is nothing left to attribute to a campaign or a version. They
 * are ingest-wide tallies, and the dashboard labels them as such rather than
 * showing them beside filtered numbers as if they narrowed too.
 */
export interface DataQuality {
  scoped: {
    totalEvents: number;
    distinctSessions: number;
    /** Events whose arrival order disagrees with the client's own sequence number. */
    outOfOrderEvents: number;
    /** step_viewed events beyond the first per (session, step). */
    repeatStepViews: number;
  };
  allTime: {
    /** Duplicate submissions suppressed at write time. */
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
  /** Which recommendation people ended up with, by unique session. */
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
 * Build the shared WHERE clause.
 *
 * `extra` clauses are appended AFTER the filter clauses, so a caller that adds
 * its own placeholder appends its value after `params` and the two stay in
 * step. Getting this order wrong silently mislabels every filtered segment,
 * so the contract is: extras last, always.
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

/** Ids of steps whose type is `result` — measured separately, not as steps. */
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
 * Canonical step order for the versions in scope.
 *
 * Variants order their steps differently, so there is no single true order. We
 * take the first variant's sequence as the backbone and append anything only
 * other variants or older versions ask, so no step's numbers ever vanish.
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

  // The result screen carries a step_id on result_viewed / cta_clicked but is
  // not a question — it has its own metrics on the segment.
  const resultIds = resultStepIds(f.funnelKey);

  // Steps present in the data but not in any known config still get reported,
  // so a config that was edited outside the app cannot silently hide traffic.
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
    return {
      stepId: id,
      title,
      reached,
      completed,
      dropOff: Math.max(0, reached - completed),
      completionRate: safeRate(completed, reached),
      dropOffRate: safeRate(Math.max(0, reached - completed), reached),
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

  // Disagreement between the client's own ordering and our arrival ordering is
  // the honest definition of "arrived out of order".
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
  const rows = getDb()
    .prepare(
      `SELECT e.type AS type, COUNT(*) AS events, COUNT(DISTINCT e.session_id) AS sessions
       ${BASE_FROM}
       WHERE ${w.sql} AND e.type NOT IN (${placeholders})
       GROUP BY e.type ORDER BY events DESC`,
    )
    .all(...w.params, ...CORE_EVENT_TYPES) as CustomEventMetric[];
  return rows;
}

/**
 * Result distribution, read from the `result_id` property the config declares
 * on `result_viewed` and `cta_clicked`. Counted by unique session, so a refresh
 * of the result screen does not inflate a recommendation's share.
 */
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
