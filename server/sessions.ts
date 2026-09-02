/**
 * Session lifecycle.
 *
 * The server is authoritative for navigation: it validates every answer and
 * decides the next step. The client renders what it is told. That is what
 * makes back / refresh / reopen safe — the browser holds no state that matters
 * beyond the session id.
 */
import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './db.ts';
import { assignVariant } from './ab.ts';
import { getActiveVersionRow, getVersionById, parseConfig } from './versions.ts';
import {
  RESULT,
  computeProgress,
  firstStepId,
  nextStepId,
  resolveVariantConfig,
  stepById,
  summariseAnswer,
  validateAnswer,
  type Answers,
  type AnswerValue,
  type FunnelConfig,
  type Progress,
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
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  synthetic: number;
  created_at: string;
}

export interface StateRow {
  session_id: string;
  current_step: string;
  history_json: string;
  completed: number;
  updated_at: string;
}

export interface SessionView {
  sessionId: string;
  funnelKey: string;
  version: number;
  versionId: number;
  variant: string;
  variantSource: string;
  /** Config already resolved for this session's variant. */
  config: FunnelConfig;
  currentStep: string;
  history: string[];
  completed: boolean;
  progress: Progress;
  /** The user's own answers, returned so the UI can repopulate its inputs. */
  answers: Answers;
  utm: Utm;
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
export function configForSession(session: SessionRow): FunnelConfig {
  const row = getVersionById(session.version_id);
  if (!row) throw new Error(`Session ${session.session_id} references a missing version.`);
  return resolveVariantConfig(parseConfig(row), session.variant);
}

function saveState(sessionId: string, currentStep: string, history: string[], completed: boolean) {
  getDb()
    .prepare(
      `INSERT INTO session_state (session_id, current_step, history_json, completed, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         current_step = excluded.current_step,
         history_json = excluded.history_json,
         completed    = excluded.completed,
         updated_at   = excluded.updated_at`,
    )
    .run(sessionId, currentStep, JSON.stringify(history), completed ? 1 : 0, nowIso());
}

export function buildView(session: SessionRow): SessionView {
  const config = configForSession(session);
  const state = getState(session.session_id);
  const answers = getAnswers(session.session_id);
  const currentStep = state?.current_step ?? firstStepId(config);
  const history: string[] = state ? (JSON.parse(state.history_json) as string[]) : [];
  const completed = state ? state.completed === 1 : false;

  return {
    sessionId: session.session_id,
    funnelKey: session.funnel_key,
    version: session.version,
    versionId: session.version_id,
    variant: session.variant,
    variantSource: session.variant_source,
    config,
    currentStep,
    history,
    completed,
    progress: computeProgress(config, currentStep, answers, history),
    answers,
    utm: {
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
    },
  };
}

export class NoActiveVersionError extends Error {}

/**
 * Start a session on the currently active version and pin both the version and
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

  const baseConfig = parseConfig(activeRow);
  const sessionId = opts.sessionId ?? randomUUID();
  const { variant, source } = assignVariant(baseConfig, sessionId, opts.variantOverride ?? null);
  const utm = opts.utm ?? {};

  getDb()
    .prepare(
      `INSERT INTO sessions (
         session_id, funnel_key, version_id, version, variant, variant_source,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term, synthetic, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      opts.funnelKey,
      activeRow.id,
      activeRow.version,
      variant,
      source,
      utm.utm_source ?? null,
      utm.utm_medium ?? null,
      utm.utm_campaign ?? null,
      utm.utm_content ?? null,
      utm.utm_term ?? null,
      opts.synthetic ? 1 : 0,
      nowIso(),
    );

  const resolved = resolveVariantConfig(baseConfig, variant);
  saveState(sessionId, firstStepId(resolved), [], false);

  return buildView(getSession(sessionId)!);
}

export interface AdvanceResult {
  ok: boolean;
  error?: string;
  view?: SessionView;
  /** Sanitised metadata the caller should attach to an `answer_submitted` event. */
  answerSummary?: Record<string, unknown>;
  previousStep?: string;
  reachedResult?: boolean;
}

/**
 * Validate an answer, persist it, and advance to the next step.
 *
 * Re-submitting the step the user is already on is treated as an edit: the
 * answer is overwritten and the branch recomputed. Submitting a step that is
 * not the current one is rejected, so a stale tab cannot corrupt the path.
 */
export function submitAnswer(sessionId: string, stepId: string, value: unknown): AdvanceResult {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session.' };

  const config = configForSession(session);
  const state = getState(sessionId);
  const currentStep = state?.current_step ?? firstStepId(config);
  if (currentStep === RESULT) return { ok: false, error: 'Funnel already completed.' };
  if (stepId !== currentStep) {
    return { ok: false, error: `Step "${stepId}" is not the current step ("${currentStep}").` };
  }

  const step = stepById(config, stepId);
  if (!step) return { ok: false, error: `Unknown step "${stepId}".` };

  const validation = validateAnswer(step, value);
  if (!validation.ok) return { ok: false, error: validation.error };

  const stored = validation.value ?? null;
  getDb()
    .prepare(
      `INSERT INTO session_answers (session_id, step_id, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, step_id) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(sessionId, stepId, JSON.stringify(stored), nowIso());

  const answers = getAnswers(sessionId);
  const next = nextStepId(config, stepId, answers);
  const history: string[] = state ? (JSON.parse(state.history_json) as string[]) : [];
  const newHistory = [...history.filter((h) => h !== stepId), stepId];
  const completed = next === RESULT;
  saveState(sessionId, next, newHistory, completed);

  return {
    ok: true,
    view: buildView(session),
    answerSummary: summariseAnswer(step, stored),
    previousStep: stepId,
    reachedResult: completed,
  };
}

/**
 * Step back one screen.
 *
 * We pop the history rather than recomputing backwards, because with
 * conditional branches the reverse edge is not unique — history is the only
 * honest record of where the user actually came from.
 */
export function goBack(sessionId: string): AdvanceResult {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session.' };

  const state = getState(sessionId);
  if (!state) return { ok: false, error: 'Session has no state.' };

  const history: string[] = JSON.parse(state.history_json) as string[];
  if (history.length === 0) return { ok: false, error: 'Already at the first step.' };

  const target = history[history.length - 1];
  const newHistory = history.slice(0, -1);
  saveState(sessionId, target, newHistory, false);

  return { ok: true, view: buildView(session), previousStep: state.current_step };
}

/** Mark an info step as seen and move on; info screens carry no answer. */
export function continueFromInfo(sessionId: string, stepId: string): AdvanceResult {
  return submitAnswer(sessionId, stepId, null);
}
