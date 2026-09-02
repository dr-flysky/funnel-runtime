/**
 * Funnel Runtime — shared, dependency-free funnel engine.
 *
 * This module is imported by the server, the client and the tests. It is pure:
 * no I/O, no globals. Everything about "what screen comes next" lives here so
 * that the server can enforce it and the client can render it without the two
 * drifting apart.
 */

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type StepType = 'info' | 'single_select' | 'multi_select' | 'number';

export interface Option {
  id: string;
  label: string;
  hint?: string;
}

export interface StepBase {
  id: string;
  type: StepType;
  title: string;
  subtitle?: string;
  /** Optional inline help copy; opening it emits the `help_opened` event. */
  help?: string;
  /** Explicit transitions. When omitted the engine falls back to array order. */
  next?: NextRule[] | string;
}

export interface InfoStep extends StepBase {
  type: 'info';
  body?: string;
  bullets?: string[];
  continueLabel?: string;
}

export interface SelectStep extends StepBase {
  type: 'single_select' | 'multi_select';
  options: Option[];
  required?: boolean;
  minSelected?: number;
  maxSelected?: number;
}

export interface NumberStep extends StepBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  required?: boolean;
}

export type Step = InfoStep | SelectStep | NumberStep;

export type ConditionOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'includes' | 'answered' | 'not_answered';

export interface Condition {
  /** Step id whose answer is being tested. */
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionGroup {
  all?: Condition[];
  any?: Condition[];
}

export interface NextRule {
  /** Omitted `when` means "always" — use as the final default rule. */
  when?: ConditionGroup;
  /** A step id, or the RESULT sentinel. */
  goto: string;
}

export interface ResultScreen {
  id: string;
  title: string;
  body?: string;
  bullets?: string[];
  cta: { id: string; label: string; href?: string };
}

export interface VariantDef {
  label?: string;
  /** Relative weight for assignment. Defaults to 1. */
  weight?: number;
  /** Step ids removed for this variant. Transitions are re-pointed automatically. */
  removeSteps?: string[];
  /** Optional explicit ordering of the remaining step ids. */
  stepOrder?: string[];
  /** Per-step shallow patch, e.g. new title/next/options. */
  patch?: Record<string, Partial<Step>>;
  /** Shallow patch of the result screen. */
  result?: Partial<ResultScreen>;
}

export interface ExperimentDef {
  key: string;
  hypothesis: string;
  primaryMetric: string;
  variants: Record<string, VariantDef>;
}

export interface FunnelConfig {
  key: string;
  name: string;
  /** Extra event types this version is allowed to emit, beyond the core set. */
  extraEvents?: string[];
  experiment: ExperimentDef;
  steps: Step[];
  result: ResultScreen;
}

/** Sentinel `goto` target meaning "leave the step graph and show the result". */
export const RESULT = '@result';

export type AnswerValue = string | string[] | number | null;
export type Answers = Record<string, AnswerValue>;

// ---------------------------------------------------------------------------
// Core event catalogue
// ---------------------------------------------------------------------------

export const CORE_EVENT_TYPES = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number];

/**
 * Event types are open by design: a new config version may introduce a new
 * event without a database migration or a server code change. We only enforce
 * a naming shape so the analytics layer stays predictable.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export function isValidEventType(type: string): boolean {
  return EVENT_TYPE_PATTERN.test(type);
}

// ---------------------------------------------------------------------------
// Variant resolution
// ---------------------------------------------------------------------------

function shallowPatchStep(step: Step, patch: Partial<Step>): Step {
  return { ...step, ...patch } as Step;
}

/** The target a step falls through to when no rule matches: explicit or array order. */
function defaultTargetOf(step: Step, order: string[], byId: Map<string, Step>): string {
  if (typeof step.next === 'string') return step.next;
  if (Array.isArray(step.next) && step.next.length > 0) {
    const fallback = step.next.find((r) => !r.when);
    if (fallback) return fallback.goto;
    return step.next[step.next.length - 1].goto;
  }
  const idx = order.indexOf(step.id);
  if (idx >= 0 && idx + 1 < order.length) {
    const nextId = order[idx + 1];
    if (byId.has(nextId)) return nextId;
  }
  return RESULT;
}

/**
 * Rewrite a `goto` that points at a removed step so it lands on the first
 * surviving step reachable from it. Guards against cycles among removed steps.
 */
function reroute(
  target: string,
  removed: Set<string>,
  byId: Map<string, Step>,
  order: string[],
): string {
  let cursor = target;
  const seen = new Set<string>();
  while (cursor !== RESULT && removed.has(cursor)) {
    if (seen.has(cursor)) return RESULT;
    seen.add(cursor);
    const step = byId.get(cursor);
    if (!step) return RESULT;
    cursor = defaultTargetOf(step, order, byId);
  }
  return cursor;
}

/**
 * Produce the concrete config a given variant sees: patches applied, removed
 * steps dropped, transitions repaired, result screen merged.
 *
 * Unknown variant keys fall back to an unmodified config rather than throwing,
 * so a session pinned to an old version can never be bricked by a config that
 * no longer defines its variant.
 */
export function resolveVariantConfig(config: FunnelConfig, variant: string): FunnelConfig {
  const def = config.experiment?.variants?.[variant];
  if (!def) return config;

  const originalOrder = config.steps.map((s) => s.id);
  const originalById = new Map(config.steps.map((s) => [s.id, s]));
  const removed = new Set(def.removeSteps ?? []);

  // 1. drop removed steps, 2. apply per-step patches
  let steps = config.steps
    .filter((s) => !removed.has(s.id))
    .map((s) => (def.patch?.[s.id] ? shallowPatchStep(s, def.patch![s.id]) : s));

  // 3. optional explicit reordering (ids not listed keep their relative order at the end)
  if (def.stepOrder?.length) {
    const rank = new Map(def.stepOrder.map((id, i) => [id, i]));
    steps = [...steps].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return originalOrder.indexOf(a.id) - originalOrder.indexOf(b.id);
    });
  }

  // 4. repair every transition that pointed at a removed step
  if (removed.size > 0) {
    const survivingOrder = steps.map((s) => s.id);
    steps = steps.map((s) => {
      if (typeof s.next === 'string') {
        return { ...s, next: reroute(s.next, removed, originalById, originalOrder) } as Step;
      }
      if (Array.isArray(s.next)) {
        const rules = s.next.map((r) => ({
          ...r,
          goto: reroute(r.goto, removed, originalById, originalOrder),
        }));
        return { ...s, next: rules } as Step;
      }
      // Implicit array-order transition: verify it still resolves inside the
      // surviving set, otherwise pin it explicitly.
      const implicit = defaultTargetOf(s, originalOrder, originalById);
      const repaired = reroute(implicit, removed, originalById, originalOrder);
      const idx = survivingOrder.indexOf(s.id);
      const naturalNext =
        idx >= 0 && idx + 1 < survivingOrder.length ? survivingOrder[idx + 1] : RESULT;
      if (repaired === naturalNext) return s;
      return { ...s, next: repaired } as Step;
    });
  }

  const result: ResultScreen = def.result
    ? { ...config.result, ...def.result, cta: { ...config.result.cta, ...(def.result.cta ?? {}) } }
    : config.result;

  return { ...config, steps, result };
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function evaluateCondition(cond: Condition, answers: Answers): boolean {
  const actual = answers[cond.field];
  switch (cond.op) {
    case 'answered':
      return (
        actual !== undefined && actual !== null && actual !== '' &&
        !(Array.isArray(actual) && actual.length === 0)
      );
    case 'not_answered':
      return (
        actual === undefined || actual === null || actual === '' ||
        (Array.isArray(actual) && actual.length === 0)
      );
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'in':
      return Array.isArray(cond.value) && (cond.value as unknown[]).includes(actual as unknown);
    case 'not_in':
      return Array.isArray(cond.value) && !(cond.value as unknown[]).includes(actual as unknown);
    case 'includes':
      return Array.isArray(actual) && (actual as string[]).includes(cond.value as string);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(cond.value);
      if (a === null || b === null) return false;
      if (cond.op === 'gt') return a > b;
      if (cond.op === 'gte') return a >= b;
      if (cond.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

export function evaluateGroup(group: ConditionGroup | undefined, answers: Answers): boolean {
  if (!group) return true;
  if (group.all?.length && !group.all.every((c) => evaluateCondition(c, answers))) return false;
  if (group.any?.length && !group.any.some((c) => evaluateCondition(c, answers))) return false;
  return true;
}

/** True when every condition in the group can be decided from the answers we have. */
function groupIsDecidable(group: ConditionGroup | undefined, answers: Answers): boolean {
  if (!group) return true;
  const all = [...(group.all ?? []), ...(group.any ?? [])];
  return all.every((c) => {
    if (c.op === 'answered' || c.op === 'not_answered') return true;
    const v = answers[c.field];
    return v !== undefined && v !== null && v !== '';
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export function stepById(config: FunnelConfig, id: string): Step | undefined {
  return config.steps.find((s) => s.id === id);
}

export function firstStepId(config: FunnelConfig): string {
  return config.steps.length > 0 ? config.steps[0].id : RESULT;
}

/**
 * The next step id after `currentId` given `answers`.
 * Returns RESULT when the funnel is finished.
 */
export function nextStepId(config: FunnelConfig, currentId: string, answers: Answers): string {
  const step = stepById(config, currentId);
  if (!step) return RESULT;
  const order = config.steps.map((s) => s.id);
  const byId = new Map(config.steps.map((s) => [s.id, s]));

  if (typeof step.next === 'string') return byId.has(step.next) ? step.next : RESULT;

  if (Array.isArray(step.next)) {
    for (const rule of step.next) {
      if (evaluateGroup(rule.when, answers)) {
        return rule.goto === RESULT || byId.has(rule.goto) ? rule.goto : RESULT;
      }
    }
    return RESULT;
  }

  const idx = order.indexOf(currentId);
  return idx >= 0 && idx + 1 < order.length ? order[idx + 1] : RESULT;
}

/**
 * Forward-looking list of steps the user will see, starting at `fromId`.
 *
 * Where a branch cannot yet be decided (the deciding answer has not been given)
 * we take the first rule as a deterministic estimate, so the progress bar is
 * stable rather than jumping between renders.
 */
export function reachablePath(config: FunnelConfig, fromId: string, answers: Answers): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor = fromId;

  while (cursor !== RESULT && !seen.has(cursor)) {
    const step = stepById(config, cursor);
    if (!step) break;
    seen.add(cursor);
    path.push(cursor);

    if (typeof step.next === 'string') {
      cursor = step.next;
      continue;
    }
    if (Array.isArray(step.next)) {
      let picked: string | null = null;
      for (const rule of step.next) {
        if (!groupIsDecidable(rule.when, answers)) {
          // Undecided branch: estimate with this rule's target.
          picked = rule.goto;
          break;
        }
        if (evaluateGroup(rule.when, answers)) {
          picked = rule.goto;
          break;
        }
      }
      cursor = picked ?? RESULT;
      continue;
    }
    cursor = nextStepId(config, cursor, answers);
  }
  return path;
}

export interface Progress {
  /** 1-based position of the current step among the steps this user will see. */
  position: number;
  /** Estimated total number of steps on this user's path. */
  total: number;
  percent: number;
}

/**
 * Progress counts only the steps *this* user can reach: history already walked
 * plus the forward-looking estimate. It never counts branches the user's own
 * answers have ruled out.
 */
export function computeProgress(
  config: FunnelConfig,
  currentId: string,
  answers: Answers,
  history: string[],
): Progress {
  if (currentId === RESULT) {
    const total = Math.max(history.length, 1);
    return { position: total, total, percent: 100 };
  }
  const ahead = reachablePath(config, currentId, answers);
  const behind = history.filter((id) => id !== currentId).length;
  const total = Math.max(behind + ahead.length, 1);
  const position = Math.min(behind + 1, total);
  const percent = Math.round((behind / total) * 100);
  return { position, total, percent };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** The coerced value to persist (e.g. numeric strings become numbers). */
  value?: AnswerValue;
}

export function validateAnswer(step: Step, raw: unknown): ValidationResult {
  switch (step.type) {
    case 'info':
      return { ok: true, value: null };

    case 'single_select': {
      const required = step.required !== false;
      if (raw === undefined || raw === null || raw === '') {
        return required
          ? { ok: false, error: 'Please choose an option.' }
          : { ok: true, value: null };
      }
      if (typeof raw !== 'string') return { ok: false, error: 'Invalid selection.' };
      if (!step.options.some((o) => o.id === raw)) return { ok: false, error: 'Unknown option.' };
      return { ok: true, value: raw };
    }

    case 'multi_select': {
      const required = step.required !== false;
      const arr = Array.isArray(raw)
        ? (raw as unknown[])
        : raw === undefined || raw === null
          ? []
          : null;
      if (arr === null) return { ok: false, error: 'Invalid selection.' };
      const ids = arr.map(String);
      if (ids.some((id) => !step.options.some((o) => o.id === id))) {
        return { ok: false, error: 'Unknown option.' };
      }
      if (new Set(ids).size !== ids.length) return { ok: false, error: 'Duplicate selection.' };
      const min = step.minSelected ?? (required ? 1 : 0);
      if (ids.length < min) {
        return { ok: false, error: `Please choose at least ${min} option${min === 1 ? '' : 's'}.` };
      }
      if (step.maxSelected !== undefined && ids.length > step.maxSelected) {
        return { ok: false, error: `Please choose no more than ${step.maxSelected}.` };
      }
      return { ok: true, value: ids };
    }

    case 'number': {
      const required = step.required !== false;
      if (raw === undefined || raw === null || raw === '') {
        return required ? { ok: false, error: 'Please enter a value.' } : { ok: true, value: null };
      }
      const n = toNumber(raw);
      if (n === null) return { ok: false, error: 'Please enter a number.' };
      if (step.min !== undefined && n < step.min) {
        return { ok: false, error: `Must be at least ${step.min}.` };
      }
      if (step.max !== undefined && n > step.max) {
        return { ok: false, error: `Must be no more than ${step.max}.` };
      }
      return { ok: true, value: n };
    }

    default:
      return { ok: false, error: 'Unsupported step type.' };
  }
}

// ---------------------------------------------------------------------------
// Analytics-safe answer summaries
// ---------------------------------------------------------------------------

/** Coarse, order-preserving bucket label for a numeric answer. */
export function numericBucket(step: NumberStep, value: number | null): string {
  if (value === null) return 'unknown';
  const min = step.min ?? 0;
  const max = step.max ?? Math.max(min + 1, value);
  if (max <= min) return 'all';
  const bands = 5;
  const width = (max - min) / bands;
  const idx = Math.min(bands - 1, Math.max(0, Math.floor((value - min) / width)));
  const lo = Math.round(min + idx * width);
  const hi = Math.round(min + (idx + 1) * width);
  return `${lo}-${hi}`;
}

/**
 * Raw answers stay in their own table. What an `answer_submitted` event carries
 * is only config-defined, non-identifying metadata: which option ids were
 * chosen (they come from the config, not from the user) and, for free numeric
 * input, a coarse bucket rather than the exact figure.
 */
export function summariseAnswer(step: Step, value: AnswerValue): Record<string, unknown> {
  switch (step.type) {
    case 'single_select':
      return { answer_kind: 'single_select', option_id: value ?? null };
    case 'multi_select': {
      const ids = Array.isArray(value) ? value : [];
      return { answer_kind: 'multi_select', option_ids: ids, option_count: ids.length };
    }
    case 'number':
      return {
        answer_kind: 'number',
        bucket: numericBucket(step, typeof value === 'number' ? value : null),
      };
    default:
      return { answer_kind: 'info' };
  }
}

// ---------------------------------------------------------------------------
// Config validation (used when publishing a version)
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Structural checks run at publish time. A version that fails with errors is
 * rejected, so a broken config can never become active and strand live traffic.
 */
export function validateConfig(config: FunnelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (level: ConfigIssue['level'], message: string) => issues.push({ level, message });

  if (!config?.key) push('error', 'config.key is required.');
  if (!config?.name) push('error', 'config.name is required.');
  if (!Array.isArray(config?.steps) || config.steps.length === 0) {
    push('error', 'config.steps must be a non-empty array.');
    return issues;
  }
  if (config.steps.length < 6) {
    push('error', `config.steps must contain at least 6 screens (found ${config.steps.length}).`);
  }
  if (!config.result?.cta?.id) push('error', 'config.result.cta.id is required.');

  const ids = new Set<string>();
  for (const step of config.steps) {
    if (!step.id) push('error', 'every step needs an id.');
    if (ids.has(step.id)) push('error', `duplicate step id "${step.id}".`);
    ids.add(step.id);
    if (!['info', 'single_select', 'multi_select', 'number'].includes(step.type)) {
      push('error', `step "${step.id}" has unsupported type "${step.type}".`);
    }
    if (step.type === 'single_select' || step.type === 'multi_select') {
      const opts = (step as SelectStep).options;
      if (!Array.isArray(opts) || opts.length === 0) {
        push('error', `step "${step.id}" needs options.`);
      } else if (new Set(opts.map((o) => o.id)).size !== opts.length) {
        push('error', `step "${step.id}" has duplicate option ids.`);
      }
    }
  }

  // Every goto must resolve
  let branchCount = 0;
  for (const step of config.steps) {
    const targets: string[] = [];
    if (typeof step.next === 'string') targets.push(step.next);
    else if (Array.isArray(step.next)) {
      if (step.next.length > 1) branchCount += 1;
      for (const rule of step.next) targets.push(rule.goto);
      if (!step.next.some((r) => !r.when)) {
        push(
          'warning',
          `step "${step.id}" has no default transition; unmatched answers end the funnel.`,
        );
      }
    }
    for (const t of targets) {
      if (t !== RESULT && !ids.has(t)) {
        push('error', `step "${step.id}" points at unknown step "${t}".`);
      }
    }
  }
  if (branchCount < 1) push('error', 'config must contain at least one conditional branch.');

  // Experiment sanity + per-variant resolution must stay reachable
  const variants = Object.keys(config.experiment?.variants ?? {});
  if (variants.length < 2) {
    push('error', 'config.experiment.variants must define at least two variants.');
  }
  if (!config.experiment?.hypothesis) push('warning', 'config.experiment.hypothesis is empty.');
  if (!config.experiment?.primaryMetric) push('warning', 'config.experiment.primaryMetric is empty.');

  for (const v of variants) {
    const resolved = resolveVariantConfig(config, v);
    if (resolved.steps.length === 0) {
      push('error', `variant "${v}" resolves to zero steps.`);
      continue;
    }
    const resolvedIds = new Set(resolved.steps.map((s) => s.id));
    for (const step of resolved.steps) {
      const targets: string[] = [];
      if (typeof step.next === 'string') targets.push(step.next);
      else if (Array.isArray(step.next)) for (const r of step.next) targets.push(r.goto);
      for (const t of targets) {
        if (t !== RESULT && !resolvedIds.has(t)) {
          push('error', `variant "${v}": step "${step.id}" points at "${t}" which the variant removed.`);
        }
      }
    }
  }

  for (const e of config.extraEvents ?? []) {
    if (!isValidEventType(e)) push('error', `extraEvents contains invalid event type "${e}".`);
  }

  return issues;
}

export function configErrors(config: FunnelConfig): string[] {
  return validateConfig(config).filter((i) => i.level === 'error').map((i) => i.message);
}
