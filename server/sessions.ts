/**
 * Session lifecycle.
 *
 * The server is authoritative for navigation: it validates every answer and
 * decides the next step. The client renders what it is told. That is what makes
 * back / refresh / reopen safe — the browser holds nothing but a session id.
 *
 * Navigation follows the config's own model: the variant's `stepSequence`
 * filtered by each step's `visibleWhen`. Because the visible path is recomputed
 * from the current answers on every request, changing an earlier answer takes
 * effect immediately — a step can appear or disappear without any bookkeeping.
 */
import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './db.ts';
import { assignVariant } from './ab.ts';
import { getActiveVersionRow, getVersionById, parseConfig } from './versions.ts';
import {
  computeProgress,
  firstStepId,
  nextStepId,
  previousStepId,
  resolveResultId,
  resolveVariant,
  stepById,
  summariseAnswer,
  validateAnswer,
  visibleSteps,
  type Answers,
  type AnswerValue,
  type Progress,
  type ResolvedFunnel,
  type ResultDef,
} from '@shared/funnel';

export interface Utm {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export interface SessionRow {
  session_id: string;
  funnel_key: string;
  version_id: number;
  version: number;
  variant: string;
  variant_source: string;
  experiment_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  synthetic: number;
  created_at: string;
}

interface StateRow {
  session_id: string;
  current_step: string | null;
  completed: number;
  result_id: string | null;
  updated_at: string;
}

export interface SessionView {
  sessionId: string;
  funnelId: string;
  version: number;
  versionId: number;
  variant: string;
  variantSource: string;
  experimentId: string;
  /** Config already resolved for this session's variant. */
  funnel: ResolvedFunnel;
  /** Ids of the steps this user will see, given their answers so far. */
  visibleStepIds: string[];
  currentStep: string | null;
  currentStepType: string | null;
  canGoBack: boolean;
  completed: boolean;
  progress: Progress;
  /** The user's own answers, returned so the UI can repopulate its inputs. */
  answers: Answers;
  resultId: string | null;
  result: ResultDef | null;
  utm: Utm;
  expiresAt: string | null;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export function pickUtm(source: Record<string, unknown> | undefined | null): Utm {
  const out: Utm = {};
  if (!source) return out;
  for (const key of UTM_KEYS) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim() !== '') out[key] = raw.trim().slice(0, 200);
  }
  return out;
}

export function getSession(sessionId: string): SessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE session_id = ?')
    .get(sessionId) as SessionRow | undefined;
}

function getState(sessionId: string): StateRow | undefined {
  return getDb()
    .prepare('SELECT * FROM session_state WHERE session_id = ?')
    .get(sessionId) as StateRow | undefined;
}

export function getAnswers(sessionId: string): Answers {
  const rows = getDb()
    .prepare('SELECT step_id, value_json FROM session_answers WHERE session_id = ?')
    .all(sessionId) as { step_id: string; value_json: string }[];
  const answers: Answers = {};
  for (const row of rows) answers[row.step_id] = JSON.parse(row.value_json) as AnswerValue;
  return answers;
}

/** The exact config this session started on, resolved for its variant. */
export function funnelForSession(session: SessionRow): ResolvedFunnel {
  const row = getVersionById(session.version_id);
  if (!row) throw new Error(`Session ${session.session_id} references a missing version.`);
  return resolveVariant(parseConfig(row), session.variant);
}

/**
 * `session.ttlHours` from the config. A session past its TTL is treated as
 * gone rather than silently resumed, so a stale link starts cleanly on the
 * currently active version.
 */
export function sessionExpiry(session: SessionRow, funnel: ResolvedFunnel): Date | null {
  const hours = funnel.session?.ttlHours;
  if (!hours || hours <= 0) return null;
  return new Date(new Date(session.created_at).getTime() + hours * 3_600_000);
}

export function isExpired(session: SessionRow, funnel: ResolvedFunnel, now = new Date()): boolean {
  const expiry = sessionExpiry(session, funnel);
  return expiry !== null && now >= expiry;
}

function saveState(
  sessionId: string,
  currentStep: string | null,
  completed: boolean,
  resultId: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO session_state (session_id, current_step, completed, result_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         current_step = excluded.current_step,
         completed    = excluded.completed,
         result_id    = excluded.result_id,
         updated_at   = excluded.updated_at`,
    )
    .run(sessionId, currentStep, completed ? 1 : 0, resultId, nowIso());
}

export function buildView(session: SessionRow): SessionView {
  const funnel = funnelForSession(session);
  const state = getState(session.session_id);
  const answers = getAnswers(session.session_id);

  const visible = visibleSteps(funnel, answers);
  const currentStep = state?.current_step ?? firstStepId(funnel, answers);
  const step = currentStep ? stepById(funnel, currentStep) : undefined;
  const completed = state ? state.completed === 1 : false;

  // The result is derived from the answers, never stored as the source of
  // truth, so it stays consistent if an answer is edited on the way back.
  const onResultScreen = step?.type === 'result' || completed;
  const resultId = onResultScreen ? resolveResultId(funnel, answers) : null;

  return {
    sessionId: session.session_id,
    funnelId: funnel.funnelId,
    version: session.version,
    versionId: session.version_id,
    variant: session.variant,
    variantSource: session.variant_source,
    experimentId: funnel.experimentId,
    funnel,
    visibleStepIds: visible.map((s) => s.id),
    currentStep,
    currentStepType: step?.type ?? null,
    canGoBack: currentStep ? previousStepId(funnel, currentStep, answers) !== null : false,
    completed,
    progress: computeProgress(funnel, currentStep, answers),
    answers,
    resultId,
    result: resultId ? (funnel.results[resultId] ?? null) : null,
    utm: {
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
    },
    expiresAt: sessionExpiry(session, funnel)?.toISOString() ?? null,
  };
}

export class NoActiveVersionError extends Error {}

/**
 * Start a session on the currently active version, pinning both the version and
 * the variant onto the session row. This is the only place the active pointer
 * is read for a user-facing session.
 */
export function createSession(opts: {
  funnelKey: string;
  utm?: Utm;
  variantOverride?: string | null;
  synthetic?: boolean;
  sessionId?: string;
}): SessionView {
  const activeRow = getActiveVersionRow(opts.funnelKey);
  if (!activeRow) throw new NoActiveVersionError(`No active version for funnel "${opts.funnelKey}".`);

  const config = parseConfig(activeRow);
  const sessionId = opts.sessionId ?? randomUUID();
  const { variant, source } = assignVariant(config, sessionId, opts.variantOverride ?? null);
  const utm = opts.utm ?? {};

  getDb()
    .prepare(
      `INSERT INTO sessions (
         session_id, funnel_key, version_id, version, variant, variant_source, experiment_id,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term, synthetic, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      opts.funnelKey,
      activeRow.id,
      activeRow.version,
      variant,
      source,
      config.experiment?.id ?? null,
      utm.utm_source ?? null,
      utm.utm_medium ?? null,
      utm.utm_campaign ?? null,
      utm.utm_content ?? null,
      utm.utm_term ?? null,
      opts.synthetic ? 1 : 0,
      nowIso(),
    );

  const funnel = resolveVariant(config, variant);
  saveState(sessionId, firstStepId(funnel, {}), false, null);

  return buildView(getSession(sessionId)!);
}

export interface AdvanceResult {
  ok: boolean;
  error?: string;
  view?: SessionView;
  /** Sanitised metadata for the `answer_submitted` event: the kind, nothing more. */
  answerSummary?: Record<string, unknown>;
  /** For the `step_completed` event. */
  nextStepId?: string | null;
  /** For the `back_clicked` event. */
  destinationStepId?: string | null;
  reachedResult?: boolean;
}

/**
 * Validate an answer, persist it, and advance to the next visible step.
 *
 * Submitting a step other than the current one is rejected, so a stale tab
 * cannot corrupt the path. Re-submitting the current step is an edit: the
 * answer is overwritten and the visible path recomputed, which may reveal or
 * hide steps further along.
 */
export function submitAnswer(sessionId: string, stepId: string, value: unknown): AdvanceResult {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session.' };

  const funnel = funnelForSession(session);
  if (isExpired(session, funnel)) return { ok: false, error: 'Session expired.' };

  const state = getState(sessionId);
  const currentStep = state?.current_step ?? firstStepId(funnel, getAnswers(sessionId));
  if (currentStep === null) return { ok: false, error: 'Funnel already completed.' };
  if (stepId !== currentStep) {
    return { ok: false, error: `Step "${stepId}" is not the current step ("${currentStep}").` };
  }

  const step = stepById(funnel, stepId);
  if (!step) return { ok: false, error: `Unknown step "${stepId}".` };
  if (step.type === 'result') return { ok: false, error: 'Funnel already completed.' };

  const validation = validateAnswer(step, value);
  if (!validation.ok) return { ok: false, error: validation.error };

  // Info screens carry no answer, so nothing is written for them.
  if (step.type !== 'info') {
    const stored = validation.value ?? null;
    getDb()
      .prepare(
        `INSERT INTO session_answers (session_id, step_id, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, step_id) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(sessionId, stepId, JSON.stringify(stored), nowIso());
  }

  const answers = getAnswers(sessionId);
  const next = nextStepId(funnel, stepId, answers);
  const nextStep = next ? stepById(funnel, next) : undefined;
  const reachedResult = nextStep?.type === 'result' || next === null;
  const resultId = reachedResult ? resolveResultId(funnel, answers) : null;

  // Reaching the result screen is completion; `next === null` only happens if a
  // variant ends without one, which config validation already refuses.
  saveState(sessionId, next, reachedResult, resultId);

  return {
    ok: true,
    view: buildView(session),
    answerSummary: summariseAnswer(step),
    nextStepId: next,
    reachedResult,
  };
}

/**
 * Step back one screen.
 *
 * The previous step is computed from the visible path rather than from a stored
 * history stack: with a linear sequence plus visibility predicates the backward
 * edge is unambiguous, so there is no history to keep in sync.
 */
export function goBack(sessionId: string): AdvanceResult {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session.' };

  const funnel = funnelForSession(session);
  if (isExpired(session, funnel)) return { ok: false, error: 'Session expired.' };

  const answers = getAnswers(sessionId);
  const state = getState(sessionId);
  const currentStep = state?.current_step;

  // From the result screen, Back returns to the last visible question.
  const visible = visibleSteps(funnel, answers);
  const target = currentStep
    ? previousStepId(funnel, currentStep, answers)
    : (visible[visible.length - 1]?.id ?? null);

  if (target === null) return { ok: false, error: 'Already at the first step.' };

  saveState(sessionId, target, false, null);
  return { ok: true, view: buildView(session), destinationStepId: target };
}
