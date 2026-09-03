import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type SessionView } from './api';
import { tracker } from './tracker';
import type { AnswerValue, StepDef } from '@shared/funnel';

const SESSION_KEY = (funnelKey: string) => `funnel_runtime.session.${funnelKey}`;

function readUtm(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = params.get(key);
    if (value) utm[key] = value;
  }
  return utm;
}

function currentStep(view: SessionView): StepDef | null {
  if (!view.currentStep) return null;
  return view.funnel.steps.find((s) => s.id === view.currentStep) ?? null;
}

export default function Funnel({ funnelKey }: { funnelKey: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<AnswerValue>(null);
  const [busy, setBusy] = useState(false);
  const viewedRef = useRef<string | null>(null);

  /**
   * A session the server will no longer accept writes for — past its TTL, or
   * from a wiped database. Both are recoverable in exactly one way: drop the
   * stored id and start again.
   */
  const isGone = (err: unknown): boolean =>
    err instanceof ApiError && (err.status === 404 || err.status === 410);

  // ---- start a brand-new session ------------------------------------------
  const startFresh = useCallback(async (): Promise<SessionView> => {
    localStorage.removeItem(SESSION_KEY(funnelKey));
    const params = new URLSearchParams(window.location.search);
    const created = await api.startSession(funnelKey, readUtm(), params.get('variant'));
    localStorage.setItem(SESSION_KEY(funnelKey), created.sessionId);
    tracker.track(created.sessionId, 'session_started');
    viewedRef.current = null;
    return created;
  }, [funnelKey]);

  // ---- boot: resume the stored session, or start a new one -----------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = localStorage.getItem(SESSION_KEY(funnelKey));
      try {
        if (stored) {
          try {
            const resumed = await api.resumeSession(stored);
            if (!cancelled) setView(resumed);
            return;
          } catch (err) {
            // Expired, or a session from a wiped database: start fresh.
            if (!isGone(err)) throw err;
            if (!cancelled && err instanceof ApiError && err.status === 410) {
              setNotice('Your last visit expired, so this is a fresh start.');
            }
          }
        }

        const created = await startFresh();
        if (!cancelled) setView(created);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [funnelKey, startFresh]);

  // ---- one step_viewed / result_viewed per arrival ------------------------
  useEffect(() => {
    if (!view) return;
    const marker = `${view.sessionId}:${view.currentStep ?? 'result'}:${view.completed}`;
    if (viewedRef.current === marker) return;
    viewedRef.current = marker;

    const step = currentStep(view);
    if (view.completed || step?.type === 'result') {
      // Declared properties for result_viewed: result_id.
      tracker.track(view.sessionId, 'result_viewed', view.currentStep, {
        result_id: view.resultId,
      });
    } else if (step) {
      // Declared properties for step_viewed: step_type, visible_step_index,
      // visible_step_count.
      tracker.track(view.sessionId, 'step_viewed', step.id, {
        step_type: step.type,
        visible_step_index: view.progress.visibleIndex,
        visible_step_count: view.progress.visibleCount,
      });
    }
  }, [view?.sessionId, view?.currentStep, view?.completed]);

  // ---- seed the input from whatever the user already answered -------------
  useEffect(() => {
    if (!view) return;
    setFieldError(null);
    const step = currentStep(view);
    const existing = step ? view.answers[step.id] : undefined;
    setDraft(existing ?? (step?.type === 'multi-select' ? [] : null));
  }, [view?.currentStep, view?.sessionId]);

  const step = view ? currentStep(view) : null;

  const submit = useCallback(async () => {
    if (!view || !step || busy) return;
    setBusy(true);
    setFieldError(null);
    try {
      const next = await api.answer(view.sessionId, step.id, draft);

      if (step.type !== 'info') {
        // Declared property for answer_submitted: answer_kind, and nothing
        // else — the config sets events.privacy.storeRawAnswers to false.
        tracker.track(view.sessionId, 'answer_submitted', step.id, next.answerSummary ?? {});
      }
      // Declared property for step_completed: next_step_id.
      tracker.track(view.sessionId, 'step_completed', step.id, {
        next_step_id: next.currentStep ?? null,
      });
      setView(next);
    } catch (err) {
      // A tab left open past the TTL: the answer is refused, so rather than
      // stranding the user on a funnel that can no longer be submitted, start
      // them over and say why.
      if (isGone(err)) {
        setNotice('That session expired while this tab was open, so we started a new one.');
        setView(await startFresh());
      } else if (err instanceof ApiError && err.status === 400) {
        setFieldError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [view, step, draft, busy, startFresh]);

  const goBack = useCallback(async () => {
    if (!view || busy) return;
    setBusy(true);
    try {
      const back = await api.back(view.sessionId);
      // Declared property for back_clicked: destination_step_id.
      tracker.track(view.sessionId, 'back_clicked', view.currentStep, {
        destination_step_id: back.currentStep,
      });
      setView(back);
    } catch (err) {
      if (isGone(err)) {
        setNotice('That session expired while this tab was open, so we started a new one.');
        setView(await startFresh());
      } else if (!(err instanceof ApiError && err.status === 400)) {
        // A 400 here just means "already at the first step" — not worth a message.
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [view, busy, startFresh]);

  const restart = useCallback(async () => {
    setNotice(null);
    setFieldError(null);
    setView(await startFresh());
  }, [startFresh]);

  if (error) {
    return (
      <div className="shell">
        <div className="card error-card">
          <h2>Something went wrong</h2>
          <p className="muted">{error}</p>
          <p className="muted small">
            If no funnel is published yet, run <code>npm run seed</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="shell">
        <div className="card">
          <div className="skeleton" />
          <div className="skeleton short" />
        </div>
      </div>
    );
  }

  const done = view.completed || step?.type === 'result';

  return (
    <div className="shell">
      <div className="meta-bar">
        <span className="pill">v{view.version}</span>
        <span className={`pill variant-${view.variant}`}>Variant {view.variant}</span>
        {view.variantSource === 'override' && <span className="pill warn">forced</span>}
        {view.utm.utm_campaign && <span className="pill ghost">{view.utm.utm_campaign}</span>}
      </div>

      {notice && (
        <div className="session-notice" role="status">
          {notice}
          <button type="button" className="notice-dismiss" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {!done && view.progress.total > 0 && (
        <div
          className="progress"
          aria-label={`Question ${view.progress.position} of ${view.progress.total}`}
        >
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${view.progress.percent}%` }} />
          </div>
          <span className="progress-label">
            Question {view.progress.position} of {view.progress.total}
          </span>
        </div>
      )}

      <div className="card">
        {done ? (
          <ResultScreen view={view} onRestart={restart} onBack={goBack} />
        ) : (
          step && (
            <>
              {step.content.eyebrow && <div className="eyebrow">{step.content.eyebrow}</div>}
              <h1>{step.content.title}</h1>
              {step.content.helperText && <p className="subtitle">{step.content.helperText}</p>}

              <StepInput step={step} value={draft} onChange={setDraft} onSubmit={submit} />

              <StepHelp key={step.id} step={step} view={view} />

              {fieldError && <p className="field-error">{fieldError}</p>}

              <div className="actions">
                {view.canGoBack && (
                  <button type="button" className="btn ghost" onClick={goBack} disabled={busy}>
                    Back
                  </button>
                )}
                <button type="button" className="btn primary" onClick={submit} disabled={busy}>
                  {step.content.primaryActionLabel ?? 'Continue'}
                </button>
              </div>
            </>
          )
        )}
      </div>

      <p className="footnote">
        Answers are saved on the server — refresh or close this tab and you will pick up where you
        left off.
      </p>
    </div>
  );
}

/**
 * CTA behaviour is named by the config, not chosen by the client.
 *
 * `expand_recommendation` is what funnel-v1.json asks for on every result, so
 * the action list is withheld until the CTA is pressed — that is what makes the
 * click a real signal rather than a decorative one, and it is what the primary
 * metric (cta_click_rate) is measuring.
 *
 * An action the client does not recognise still records the click and reveals
 * whatever detail the result carries, so a future config naming a new action
 * degrades to something sensible instead of a dead button.
 */
const KNOWN_CTA_ACTIONS = new Set(['expand_recommendation']);

function ResultScreen({
  view,
  onRestart,
  onBack,
}: {
  view: SessionView;
  onRestart: () => void;
  onBack: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const result = view.result;

  // A new result means a fresh, un-expanded screen.
  useEffect(() => {
    setExpanded(false);
  }, [view.resultId, view.sessionId]);

  if (!result) {
    const step = view.funnel.steps.find((s) => s.type === 'result');
    return (
      <>
        <h1>{step?.content.errorTitle ?? 'We could not build the recommendation'}</h1>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onRestart}>
            {step?.content.retryLabel ?? 'Try again'}
          </button>
        </div>
      </>
    );
  }

  const recommendations = result.recommendations ?? [];

  const onCta = () => {
    // Declared properties for cta_clicked: result_id, action.
    tracker.track(view.sessionId, 'cta_clicked', view.currentStep, {
      result_id: result.id,
      action: result.cta.action,
    });

    if (!KNOWN_CTA_ACTIONS.has(result.cta.action)) {
      console.warn(
        `[funnel] unrecognised cta action "${result.cta.action}"; expanding the recommendation as a fallback.`,
      );
    }
    setExpanded(true);
  };

  return (
    <>
      <div className="result-badge">Your recommendation</div>
      <h1>{result.title}</h1>
      {result.summary && <p className="subtitle">{result.summary}</p>}

      {expanded && recommendations.length > 0 && (
        <div className="action-list">
          <h2>What to do next</h2>
          <ol>
            {recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="actions">
        {view.canGoBack && (
          <button type="button" className="btn ghost" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onRestart}>
          Start again
        </button>
        {!expanded && (
          <button type="button" className="btn primary" onClick={onCta}>
            {result.cta.label}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Optional inline help for a question, drawn from the step's own `content.body`
 * — a field info screens render directly but questions otherwise ignore.
 *
 * Two independent switches, deliberately:
 *   - the *affordance* appears when the step supplies help copy;
 *   - the *event* fires only when the session's version declares `help_opened`.
 *
 * So a config can add help text to a step without inventing an event, or
 * declare the event and start measuring, and neither needs a client release.
 * Emitting an undeclared event would be rejected by ingest anyway.
 */
function StepHelp({ step, view }: { step: StepDef; view: SessionView }) {
  const [open, setOpen] = useState(false);
  const body = step.content.body;

  // Info screens already render `body` as their main copy.
  if (!body || step.type === 'info') return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Declared property for help_opened: surface.
    if (next && view.funnel.allowedEvents.includes('help_opened')) {
      tracker.track(view.sessionId, 'help_opened', step.id, { surface: 'inline' });
    }
  };

  return (
    <div className="help">
      <button type="button" className="link" onClick={toggle} aria-expanded={open}>
        {open ? 'Hide help' : 'What does this mean?'}
      </button>
      {open && <p className="help-body">{body}</p>}
    </div>
  );
}

function StepInput({
  step,
  value,
  onChange,
  onSubmit,
}: {
  step: StepDef;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  onSubmit: () => void;
}) {
  if (step.type === 'info') {
    return step.content.body ? <p className="body">{step.content.body}</p> : null;
  }

  if (step.type === 'number') {
    const input = step.input;
    return (
      <div className="number-field">
        <input
          type="number"
          inputMode="numeric"
          value={value === null || value === undefined ? '' : String(value)}
          min={input?.min}
          max={input?.max}
          step={input?.step}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
          autoFocus
        />
        {input?.unit && <span className="unit">{input.unit}</span>}
      </div>
    );
  }

  const options = step.input?.options ?? [];
  const isMulti = step.type === 'multi-select';
  const selected = Array.isArray(value) ? value : value === null ? [] : [String(value)];
  const max = step.validation?.maxSelections;

  return (
    <div className="options" role={isMulti ? 'group' : 'radiogroup'}>
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`option ${isSelected ? 'selected' : ''}`}
            aria-pressed={isSelected}
            onClick={() => {
              if (!isMulti) {
                onChange(option.value);
                return;
              }
              if (isSelected) onChange(selected.filter((v) => v !== option.value));
              else if (max === undefined || selected.length < max) {
                onChange([...selected, option.value]);
              }
            }}
          >
            <span className="option-label">{option.label}</span>
            <span className="option-mark" aria-hidden="true" />
          </button>
        );
      })}
      {isMulti && max !== undefined && (
        <p className="muted small">
          Choose up to {max}. Selected {selected.length}.
        </p>
      )}
    </div>
  );
}
