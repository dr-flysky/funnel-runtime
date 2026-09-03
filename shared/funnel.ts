/**
 * Движок воронки: чистые функции без I/O, общие для сервера, клиента и тестов.
 *
 * Навигация — это `stepSequence` варианта, отфильтрованный предикатами
 * `visibleWhen`. Ветвление через видимость, а не через рёбра графа, поэтому
 * недостижимый шаг или висящий переход невозможны в принципе.
 */

// --- Типы конфига ----------------------------------------------------------

export type StepType = 'info' | 'number' | 'single-select' | 'multi-select' | 'result';

export interface StepContent {
  eyebrow?: string;
  title?: string;
  body?: string;
  helperText?: string;
  primaryActionLabel?: string;
  loadingTitle?: string;
  errorTitle?: string;
  retryLabel?: string;
}

export interface OptionDef {
  value: string;
  label: string;
}

export interface StepInput {
  name: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: OptionDef[];
}

export interface StepValidation {
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  /** Тексты ошибок из конфига по имени правила; движок ничего не выдумывает. */
  messages?: Record<string, string>;
}

export type Operator =
  | 'eq' | 'ne'
  | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains'
  | 'answered' | 'not_answered';

/** Лист предиката: сравнение одного прошлого ответа со значением. */
export interface ConditionLeaf {
  answer: string;
  operator: Operator;
  value?: unknown;
}

export type ConditionNode =
  | ConditionLeaf
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode };

export interface StepDef {
  id: string;
  type: StepType;
  content: StepContent;
  input?: StepInput;
  validation?: StepValidation;
  visibleWhen?: ConditionNode;
  resultSource?: string;
}

export interface ResultCta {
  label: string;
  action: string;
}

export interface ResultDef {
  id: string;
  title: string;
  summary?: string;
  recommendations?: string[];
  cta: ResultCta;
}

export interface ResultRule {
  resultId: string;
  when: ConditionNode;
}

export interface VariantDef {
  weight?: number;
  stepSequence: string[];
  stepOverrides?: Record<string, DeepPartial<StepDef>>;
  resultOverrides?: Record<string, DeepPartial<ResultDef>>;
}

export interface ExperimentDef {
  id: string;
  assignment?: 'server' | 'client';
  sticky?: boolean;
  overrideQueryParam?: string;
  variants: Record<string, VariantDef>;
}

export interface SessionPolicy {
  ttlHours?: number;
  persistAnswers?: boolean;
  pinVersion?: boolean;
  pinExperimentVariant?: boolean;
}

export interface ProgressPolicy {
  countVisibleOnly?: boolean;
  excludeTypes?: StepType[];
}

export interface EventDef {
  name: string;
  trigger?: string;
  properties?: string[];
}

export interface EventsPolicy {
  baseProperties?: string[];
  allowed?: EventDef[];
  privacy?: {
    storeRawAnswers?: boolean;
    allowAnswerKinds?: boolean;
  };
}

export interface FunnelConfig {
  schemaVersion: string;
  funnelId: string;
  version?: number;
  status?: string;
  locale?: string;
  title: string;
  description?: string;
  session?: SessionPolicy;
  progress?: ProgressPolicy;
  experiment: ExperimentDef;
  steps: Record<string, StepDef>;
  resultRules?: ResultRule[];
  defaultResultId: string;
  results: Record<string, ResultDef>;
  events?: EventsPolicy;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type AnswerValue = string | string[] | number | null;
export type Answers = Record<string, AnswerValue>;

/** Конфиг с уже применёнными последовательностью и оверрайдами варианта: клиент не знает о вариантах. */
export interface ResolvedFunnel {
  funnelId: string;
  version: number;
  title: string;
  locale?: string;
  variant: string;
  experimentId: string;
  steps: StepDef[];
  results: Record<string, ResultDef>;
  resultRules: ResultRule[];
  defaultResultId: string;
  progress: ProgressPolicy;
  session: SessionPolicy;
  /** Подсказка клиенту, какие события объявлены версией; приём событий проверяет тот же список сам. */
  allowedEvents: string[];
}

// --- Каталог событий -------------------------------------------------------

export const CORE_EVENT_TYPES = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

/** Имена событий проверяются по форме, а не по списку: новое событие не требует миграции схемы. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export function isValidEventName(name: string): boolean {
  return EVENT_NAME_PATTERN.test(name);
}

export function allowedEventNames(config: FunnelConfig): Set<string> {
  const names = new Set<string>(CORE_EVENT_TYPES);
  for (const e of config.events?.allowed ?? []) {
    if (e?.name) names.add(e.name);
  }
  return names;
}

// --- Слияние оверрайдов ----------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Рекурсивное слияние; массивы заменяются целиком, а не склеиваются. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  if (!isPlainObject(base)) return patch as T;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

// --- Разрешение варианта ---------------------------------------------------

/** Неизвестный вариант откатывается к первому объявленному: сессия на старой версии не должна ломаться. */
export function resolveVariant(config: FunnelConfig, variant: string): ResolvedFunnel {
  const variants = config.experiment?.variants ?? {};
  const key = variants[variant] ? variant : Object.keys(variants).sort()[0];
  const def: VariantDef | undefined = variants[key];

  const sequence = def?.stepSequence?.length
    ? def.stepSequence
    : Object.keys(config.steps ?? {});

  const steps: StepDef[] = [];
  for (const id of sequence) {
    const base = config.steps?.[id];
    if (!base) continue; // неизвестный шаг в последовательности просто пропускаем
    const override = def?.stepOverrides?.[id];
    steps.push(override ? deepMerge(base, override) : base);
  }

  const results: Record<string, ResultDef> = {};
  for (const [id, result] of Object.entries(config.results ?? {})) {
    const override = def?.resultOverrides?.[id];
    results[id] = override ? deepMerge(result, override) : result;
  }

  return {
    funnelId: config.funnelId,
    version: config.version ?? 1,
    title: config.title,
    locale: config.locale,
    variant: key ?? 'A',
    experimentId: config.experiment?.id ?? '',
    steps,
    results,
    resultRules: config.resultRules ?? [],
    defaultResultId: config.defaultResultId,
    progress: config.progress ?? {},
    session: config.session ?? {},
    allowedEvents: [...allowedEventNames(config)],
  };
}

// --- Вычисление условий ----------------------------------------------------

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isAnswered(v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function evaluateLeaf(cond: ConditionLeaf, answers: Answers): boolean {
  const actual = answers[cond.answer];

  switch (cond.operator) {
    case 'answered':
      return isAnswered(actual);
    case 'not_answered':
      return !isAnswered(actual);
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'in':
      return Array.isArray(cond.value) && (cond.value as unknown[]).includes(actual as unknown);
    case 'not_in':
      return Array.isArray(cond.value) && !(cond.value as unknown[]).includes(actual as unknown);
    case 'contains':
      return Array.isArray(actual) && (actual as string[]).includes(cond.value as string);
    case 'not_contains':
      return Array.isArray(actual) && !(actual as string[]).includes(cond.value as string);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(cond.value);
      if (a === null || b === null) return false;
      if (cond.operator === 'gt') return a > b;
      if (cond.operator === 'gte') return a >= b;
      if (cond.operator === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

/** Вычисляет дерево условий; отсутствующий узел означает «всегда истина». */
export function evaluateCondition(node: ConditionNode | undefined, answers: Answers): boolean {
  if (!node) return true;

  if ('all' in node && Array.isArray(node.all)) {
    return node.all.every((child) => evaluateCondition(child, answers));
  }
  if ('any' in node && Array.isArray(node.any)) {
    return node.any.some((child) => evaluateCondition(child, answers));
  }
  if ('not' in node && node.not) {
    return !evaluateCondition(node.not, answers);
  }
  if ('answer' in node && 'operator' in node) {
    return evaluateLeaf(node as ConditionLeaf, answers);
  }
  return true;
}

/** Все id ответов, которые читает дерево условий; нужно валидации конфига. */
export function conditionDependencies(node: ConditionNode | undefined, out: Set<string> = new Set()): Set<string> {
  if (!node) return out;
  if ('all' in node && Array.isArray(node.all)) node.all.forEach((c) => conditionDependencies(c, out));
  else if ('any' in node && Array.isArray(node.any)) node.any.forEach((c) => conditionDependencies(c, out));
  else if ('not' in node && node.not) conditionDependencies(node.not, out);
  else if ('answer' in node) out.add((node as ConditionLeaf).answer);
  return out;
}

// --- Навигация -------------------------------------------------------------

export function stepById(funnel: ResolvedFunnel, id: string): StepDef | undefined {
  return funnel.steps.find((s) => s.id === id);
}

/** Шаги, которые пользователь реально видит: последовательность варианта с применёнными visibleWhen. */
export function visibleSteps(funnel: ResolvedFunnel, answers: Answers): StepDef[] {
  return funnel.steps.filter((s) => evaluateCondition(s.visibleWhen, answers));
}

export function firstStepId(funnel: ResolvedFunnel, answers: Answers = {}): string | null {
  const visible = visibleSteps(funnel, answers);
  return visible.length > 0 ? visible[0].id : null;
}

/** Путь пересчитывается по текущим ответам, поэтому правка ответа сразу скрывает или открывает шаги. */
export function nextStepId(funnel: ResolvedFunnel, currentId: string, answers: Answers): string | null {
  const visible = visibleSteps(funnel, answers);
  const idx = visible.findIndex((s) => s.id === currentId);
  if (idx === -1) {
    // Текущий шаг только что стал невидимым — уходим вперёд к ближайшему видимому.
    const seqIdx = funnel.steps.findIndex((s) => s.id === currentId);
    if (seqIdx === -1) return visible[0]?.id ?? null;
    const after = funnel.steps.slice(seqIdx + 1).map((s) => s.id);
    return visible.find((s) => after.includes(s.id))?.id ?? null;
  }
  return idx + 1 < visible.length ? visible[idx + 1].id : null;
}

export function previousStepId(funnel: ResolvedFunnel, currentId: string, answers: Answers): string | null {
  const visible = visibleSteps(funnel, answers);
  const idx = visible.findIndex((s) => s.id === currentId);
  if (idx <= 0) return null;
  return visible[idx - 1].id;
}

// --- Прогресс --------------------------------------------------------------

export interface Progress {
  /** Позиция среди шагов, попадающих в прогресс (с единицы). */
  position: number;
  total: number;
  percent: number;
  /** Индекс и количество среди всех видимых шагов — для события step_viewed. */
  visibleIndex: number;
  visibleCount: number;
}

/**
 * Прогресс считается по политике конфига: `countVisibleOnly` сужает знаменатель до достижимых
 * шагов, `excludeTypes` убирает не-вопросы, чтобы шкала мерила работу, а не экраны.
 */
export function computeProgress(
  funnel: ResolvedFunnel,
  currentId: string | null,
  answers: Answers,
): Progress {
  const policy = funnel.progress ?? {};
  const excluded = new Set<StepType>(policy.excludeTypes ?? []);

  const pool = policy.countVisibleOnly === false ? funnel.steps : visibleSteps(funnel, answers);
  const visible = visibleSteps(funnel, answers);
  const counted = pool.filter((s) => !excluded.has(s.type));

  const visibleIndex = currentId ? visible.findIndex((s) => s.id === currentId) : visible.length;
  const countedIdx = currentId ? counted.findIndex((s) => s.id === currentId) : -1;
  const total = Math.max(counted.length, 1);

  // На исключённом экране (интро, результат) позиции в counted нет — берём границу.
  const done = countedIdx >= 0 ? countedIdx : countedBefore(counted, visible, currentId);

  return {
    position: Math.min(done + 1, total),
    total,
    percent: Math.max(0, Math.min(100, Math.round((done / total) * 100))),
    visibleIndex: visibleIndex === -1 ? 0 : visibleIndex,
    visibleCount: visible.length,
  };
}

/** Сколько учитываемых шагов стоит перед `currentId` в видимом порядке. */
function countedBefore(counted: StepDef[], visible: StepDef[], currentId: string | null): number {
  if (!currentId) return counted.length;
  const pos = visible.findIndex((s) => s.id === currentId);
  if (pos === -1) return 0;
  const before = new Set(visible.slice(0, pos).map((s) => s.id));
  return counted.filter((s) => before.has(s.id)).length;
}

// --- Валидация ответов -----------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
  /** Значение для сохранения; числовые строки приводятся к числу. */
  value?: AnswerValue;
}

/** Берёт первый существующий ключ — от частного к общему, чтобы победила формулировка автора конфига. */
function message(step: StepDef, keys: string | string[], fallback: string): string {
  const messages = step.validation?.messages;
  if (messages) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const text = messages[key];
      if (text) return text;
    }
  }
  return fallback;
}

export function validateAnswer(step: StepDef, raw: unknown): ValidationResult {
  const required = step.validation?.required === true;

  switch (step.type) {
    case 'info':
    case 'result':
      return { ok: true, value: null };

    case 'single-select': {
      if (!isAnswered(raw as AnswerValue)) {
        return required
          ? { ok: false, error: message(step, 'required', 'Select an option.') }
          : { ok: true, value: null };
      }
      if (typeof raw !== 'string') {
        return { ok: false, error: message(step, 'invalid', 'Invalid selection.') };
      }
      const options = step.input?.options ?? [];
      if (!options.some((o) => o.value === raw)) {
        return { ok: false, error: message(step, 'invalid', 'Unknown option.') };
      }
      return { ok: true, value: raw };
    }

    case 'multi-select': {
      const arr = Array.isArray(raw) ? (raw as unknown[]) : raw == null ? [] : null;
      if (arr === null) {
        return { ok: false, error: message(step, 'invalid', 'Invalid selection.') };
      }
      const values = arr.map(String);
      const options = step.input?.options ?? [];
      if (values.some((v) => !options.some((o) => o.value === v))) {
        return { ok: false, error: message(step, 'invalid', 'Unknown option.') };
      }
      if (new Set(values).size !== values.length) {
        return { ok: false, error: message(step, 'invalid', 'Duplicate selection.') };
      }

      const min = step.validation?.minSelections ?? (required ? 1 : 0);
      if (values.length < min) {
        return { ok: false, error: message(step, ['minSelections', 'required'], `Choose at least ${min}.`) };
      }
      const max = step.validation?.maxSelections;
      if (max !== undefined && values.length > max) {
        return { ok: false, error: message(step, 'maxSelections', `Choose no more than ${max}.`) };
      }
      return { ok: true, value: values };
    }

    case 'number': {
      if (raw === undefined || raw === null || raw === '') {
        return required
          ? { ok: false, error: message(step, 'required', 'Enter a value.') }
          : { ok: true, value: null };
      }
      const n = toNumber(raw);
      if (n === null) {
        return { ok: false, error: message(step, 'invalid', 'Enter a number.') };
      }
      const { min, max, step: increment } = step.input ?? {};
      if (min !== undefined && n < min) {
        return { ok: false, error: message(step, 'min', `Enter a value of at least ${min}.`) };
      }
      if (max !== undefined && n > max) {
        return { ok: false, error: message(step, 'max', `Enter a value up to ${max}.`) };
      }
      if (increment && increment > 0 && min !== undefined) {
        const offset = (n - min) % increment;
        if (Math.abs(offset) > 1e-9 && Math.abs(offset - increment) > 1e-9) {
          return { ok: false, error: message(step, 'step', `Enter a value in increments of ${increment}.`) };
        }
      }
      return { ok: true, value: n };
    }

    default:
      return { ok: false, error: 'Unsupported step type.' };
  }
}

// --- Выбор результата ------------------------------------------------------

/** Выигрывает первое подошедшее правило, поэтому порядок в конфиге значим; иначе `defaultResultId`. */
export function resolveResultId(funnel: ResolvedFunnel, answers: Answers): string {
  for (const rule of funnel.resultRules) {
    if (evaluateCondition(rule.when, answers)) return rule.resultId;
  }
  return funnel.defaultResultId;
}

// --- Безопасная для аналитики сводка ответа --------------------------------

export type AnswerKind = 'single_select' | 'multi_select' | 'number' | 'none';

function answerKind(step: StepDef): AnswerKind {
  switch (step.type) {
    case 'single-select': return 'single_select';
    case 'multi-select': return 'multi_select';
    case 'number': return 'number';
    default: return 'none';
  }
}

/**
 * Всё, что вправе нести `answer_submitted`, — только вид ответа.
 * Сырые ответы живут лишь в хранилище сессий: конфиг ставит `storeRawAnswers: false`.
 */
export function summariseAnswer(step: StepDef): Record<string, unknown> {
  return { answer_kind: answerKind(step) };
}

// --- Валидация конфига (на публикации) -------------------------------------

export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
}

const VALID_TYPES: StepType[] = ['info', 'number', 'single-select', 'multi-select', 'result'];

/** Действия CTA, которые умеет выполнять клиент; тот же список используется в Funnel.tsx. */
export const KNOWN_CTA_ACTIONS = ['expand_recommendation'];

/** Конфиг с ошибками не публикуется, поэтому сломанная версия не может стать активной. */
export function validateConfig(config: FunnelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (m: string) => issues.push({ level: 'error', message: m });
  const warn = (m: string) => issues.push({ level: 'warning', message: m });

  if (!config?.funnelId) err('funnelId is required.');
  if (!config?.title) warn('title is empty.');
  if (config?.schemaVersion && config.schemaVersion !== '1.0') {
    warn(`unknown schemaVersion "${config.schemaVersion}"; expected "1.0".`);
  }

  const steps = config?.steps;
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
    err('steps must be an object keyed by step id.');
    return issues;
  }

  const stepIds = Object.keys(steps);
  if (stepIds.length < 6) {
    err(`the funnel must define at least 6 screens (found ${stepIds.length}).`);
  }

  for (const [id, step] of Object.entries(steps)) {
    if (step.id !== id) err(`step "${id}" has mismatched inner id "${step.id}".`);
    if (!VALID_TYPES.includes(step.type)) {
      err(`step "${id}" has unsupported type "${step.type}".`);
    }
    if (step.type === 'single-select' || step.type === 'multi-select') {
      const options = step.input?.options;
      if (!Array.isArray(options) || options.length === 0) {
        err(`step "${id}" needs input.options.`);
      } else if (new Set(options.map((o) => o.value)).size !== options.length) {
        err(`step "${id}" has duplicate option values.`);
      }
    }
    if (step.type === 'number' && !step.input) {
      err(`step "${id}" needs an input block.`);
    }
    // Другой resultSource молча провалился бы в результат по умолчанию.
    if (step.type === 'result' && step.resultSource && step.resultSource !== 'resultRules') {
      err(`step "${id}" declares unsupported resultSource "${step.resultSource}".`);
    }
    if (step.type === 'multi-select') {
      const { minSelections, maxSelections } = step.validation ?? {};
      if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
        err(`step "${id}" has minSelections greater than maxSelections.`);
      }
    }
  }

  const resultIds = new Set(Object.keys(config.results ?? {}));
  if (resultIds.size === 0) err('results must define at least one result.');
  if (!config.defaultResultId) err('defaultResultId is required.');
  else if (!resultIds.has(config.defaultResultId)) {
    err(`defaultResultId "${config.defaultResultId}" is not defined in results.`);
  }
  for (const rule of config.resultRules ?? []) {
    if (!resultIds.has(rule.resultId)) {
      err(`resultRules references unknown result "${rule.resultId}".`);
    }
  }
  for (const [id, result] of Object.entries(config.results ?? {})) {
    if (!result.cta?.label || !result.cta?.action) {
      err(`result "${id}" needs a cta with a label and an action.`);
    } else if (!KNOWN_CTA_ACTIONS.includes(result.cta.action)) {
      // Не ошибка: клиент откатится к раскрытию рекомендации, поведение деградирует, а не ломается.
      warn(`result "${id}" uses cta action "${result.cta.action}", which the client does not implement.`);
    }
  }

  const variants = Object.entries(config.experiment?.variants ?? {});
  if (variants.length < 2) err('experiment.variants must define at least two variants.');
  if (!config.experiment?.id) warn('experiment.id is empty.');
  if (config.experiment?.assignment && config.experiment.assignment !== 'server') {
    warn('experiment.assignment is not "server"; this runtime always assigns on the server.');
  }

  const hasBranch = Object.values(steps).some((step) => step.visibleWhen);
  if (!hasBranch && (config.resultRules ?? []).length === 0) {
    err('the config must contain at least one conditional branch (visibleWhen or resultRules).');
  }

  for (const [key, variant] of variants) {
    const sequence = variant.stepSequence ?? [];
    if (sequence.length === 0) {
      err(`variant "${key}" has an empty stepSequence.`);
      continue;
    }
    const seen = new Set<string>();
    for (const id of sequence) {
      if (!steps[id]) err(`variant "${key}" sequences unknown step "${id}".`);
      if (seen.has(id)) err(`variant "${key}" lists step "${id}" more than once.`);
      seen.add(id);
    }
    if (!sequence.some((id) => steps[id]?.type === 'result')) {
      err(`variant "${key}" has no result step in its sequence.`);
    }

    for (const id of Object.keys(variant.stepOverrides ?? {})) {
      if (!steps[id]) warn(`variant "${key}" overrides unknown step "${id}".`);
      else if (!seen.has(id)) warn(`variant "${key}" overrides step "${id}", which its sequence omits.`);
    }
    for (const id of Object.keys(variant.resultOverrides ?? {})) {
      if (!resultIds.has(id)) warn(`variant "${key}" overrides unknown result "${id}".`);
    }

    // visibleWhen обязан зависеть от ответа, собранного раньше в этом же варианте,
    // иначе предикат считается по отсутствующему ответу и шаг исчезает у всех.
    const position = new Map(sequence.map((id, i) => [id, i]));
    for (const id of sequence) {
      const step = steps[id];
      if (!step?.visibleWhen) continue;
      for (const dep of conditionDependencies(step.visibleWhen)) {
        const depPos = position.get(dep);
        if (depPos === undefined) {
          err(`variant "${key}": step "${id}" is gated on "${dep}", which the sequence never asks.`);
        } else if (depPos >= position.get(id)!) {
          err(`variant "${key}": step "${id}" is gated on "${dep}", which comes later in the sequence.`);
        }
      }
    }
  }

  for (const e of config.events?.allowed ?? []) {
    if (!isValidEventName(e.name)) err(`events.allowed contains invalid event name "${e.name}".`);
  }
  const declared = new Set((config.events?.allowed ?? []).map((e) => e.name));
  for (const core of CORE_EVENT_TYPES) {
    if (declared.size > 0 && !declared.has(core)) {
      warn(`events.allowed does not declare the core event "${core}".`);
    }
  }

  return issues;
}

export function configErrors(config: FunnelConfig): string[] {
  return validateConfig(config).filter((i) => i.level === 'error').map((i) => i.message);
}
