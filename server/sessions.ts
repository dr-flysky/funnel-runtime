/**
 * Жизненный цикл сессии.
 *
 * За навигацию отвечает сервер: он валидирует ответ и решает, какой шаг следующий,
 * а браузер хранит только id сессии — поэтому «назад», обновление и переоткрытие безопасны.
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
  /** Конфиг, уже разрешённый под вариант этой сессии. */
  funnel: ResolvedFunnel;
  /** Шаги, которые пользователь увидит при текущих ответах. */
  visibleStepIds: string[];
  currentStep: string | null;
  currentStepType: string | null;
  canGoBack: boolean;
  completed: boolean;
  progress: Progress;
  /** Ответы пользователя — чтобы UI мог восстановить поля ввода. */
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

/** Тот самый конфиг, на котором сессия стартовала, разрешённый под её вариант. */
export function funnelForSession(session: SessionRow): ResolvedFunnel {
  const row = getVersionById(session.version_id);
  if (!row) throw new Error(`Session ${session.session_id} references a missing version.`);
  return resolveVariant(parseConfig(row), session.variant);
}

/** TTL берётся из `session.ttlHours` конфига; протухшая сессия считается исчезнувшей, а не продолжается. */
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

  // Результат выводится из ответов, а не хранится как источник истины: правка ответа на «назад» его пересчитает.
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

/** Создаёт сессию на активной версии, фиксируя в её строке и версию, и вариант. */
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
  /** Обезличенные данные для события `answer_submitted`. */
  answerSummary?: Record<string, unknown>;
  /** Для события `step_completed`. */
  nextStepId?: string | null;
  /** Для события `back_clicked`. */
  destinationStepId?: string | null;
  reachedResult?: boolean;
}

/**
 * Валидирует ответ, сохраняет его и переходит к следующему видимому шагу.
 *
 * Ответ не на текущий шаг отклоняется, чтобы старая вкладка не портила путь.
 * Повторная отправка текущего шага — это правка: путь пересчитывается заново.
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

  // Информационные экраны ответа не несут, для них ничего не пишем.
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
  // next === null возможен лишь у варианта без экрана результата — валидация такое запрещает.
  const reachedResult = nextStep?.type === 'result' || next === null;
  const resultId = reachedResult ? resolveResultId(funnel, answers) : null;

  saveState(sessionId, next, reachedResult, resultId);

  return {
    ok: true,
    view: buildView(session),
    answerSummary: summariseAnswer(step),
    nextStepId: next,
    reachedResult,
  };
}

/** Шаг назад. Обратное ребро однозначно выводится из видимого пути, поэтому история не хранится. */
export function goBack(sessionId: string): AdvanceResult {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'Unknown session.' };

  const funnel = funnelForSession(session);
  if (isExpired(session, funnel)) return { ok: false, error: 'Session expired.' };

  const answers = getAnswers(sessionId);
  const state = getState(sessionId);
  const currentStep = state?.current_step;

  // С экрана результата «назад» возвращает к последнему видимому вопросу.
  const visible = visibleSteps(funnel, answers);
  const target = currentStep
    ? previousStepId(funnel, currentStep, answers)
    : (visible[visible.length - 1]?.id ?? null);

  if (target === null) return { ok: false, error: 'Already at the first step.' };

  saveState(sessionId, target, false, null);
  return { ok: true, view: buildView(session), destinationStepId: target };
}
