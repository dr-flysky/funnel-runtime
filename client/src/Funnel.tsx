import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type SessionView } from './api';
import { tracker } from './tracker';
import { RESULT, type AnswerValue, type SelectStep, type Step } from '@shared/funnel';

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

export default function Funnel({ funnelKey }: { funnelKey: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AnswerValue>(null);
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const viewedRef = useRef<string | null>(null);

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
            // A session from a wiped database: fall through and start fresh.
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
          }
        }

        const params = new URLSearchParams(window.location.search);
        const created = await api.startSession(funnelKey, readUtm(), params.get('variant'));
        localStorage.setItem(SESSION_KEY(funnelKey), created.sessionId);
        tracker.track(created.sessionId, 'session_started', null, {
          variant: created.variant,
          version: created.version,
        });
        if (!cancelled) setView(created);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [funnelKey]);

  // ---- one step_viewed per (session, step) arrival ------------------------
  useEffect(() => {
    if (!view) return;
    const marker = `${view.sessionId}:${view.currentStep}`;
    if (viewedRef.current === marker) return;
    viewedRef.current = marker;

    if (view.currentStep === RESULT || view.completed) {
      tracker.track(view.sessionId, 'result_viewed', view.config.result.id, {
        result_id: view.config.result.id,
      });
    } else {
      tracker.track(view.sessionId, 'step_viewed', view.currentStep);
    }
  }, [view?.sessionId, view?.currentStep, view?.completed]);

  // ---- seed the input from whatever the user already answered -------------
  useEffect(() => {
    if (!view) return;
    setFieldError(null);
    setHelpOpen(false);
    const existing = view.answers[view.currentStep];
    setDraft(existing ?? (currentStep(view)?.type === 'multi_select' ? [] : null));
  }, [view?.currentStep, view?.sessionId]);

  const step = view ? currentStep(view) : null;

  const submit = useCallback(async () => {
    if (!view || !step || busy) return;
    setBusy(true);
    setFieldError(null);
    try {
      const next = await api.answer(view.sessionId, step.id, draft);
      tracker.track(view.sessionId, 'answer_submitted', step.id, next.answerSummary ?? {});
      tracker.track(view.sessionId, 'step_completed', step.id);
      setView(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setFieldError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [view, step, draft, busy]);

  const goBack = useCallback(async () => {
    if (!view || busy) return;
    setBusy(true);
    try {
      tracker.track(view.sessionId, 'back_clicked', view.currentStep);
      setView(await api.back(view.sessionId));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [view, busy]);

  const restart = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY(funnelKey));
    const params = new URLSearchParams(window.location.search);
    const created = await api.startSession(funnelKey, readUtm(), params.get('variant'));
    localStorage.setItem(SESSION_KEY(funnelKey), created.sessionId);
    tracker.track(created.sessionId, 'session_started', null, { restart: true });
    viewedRef.current = null;
    setView(created);
  }, [funnelKey]);

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

  const done = view.completed || view.currentStep === RESULT;

  return (
    <div className="shell">
      <div className="meta-bar">
        <span className="pill">v{view.version}</span>
        <span className={`pill variant-${view.variant}`}>Variant {view.variant}</span>
        {view.variantSource === 'override' && <span className="pill warn">forced</span>}
        {view.utm.utm_campaign && <span className="pill ghost">{view.utm.utm_campaign}</span>}
      </div>

      {!done && (
        <div className="progress" aria-label={`Step ${view.progress.position} of ${view.progress.total}`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${view.progress.percent}%` }} />
          </div>
          <span className="progress-label">
            Step {view.progress.position} of {view.progress.total}
          </span>
        </div>
      )}

      <div className="card">
        {done ? (
          <ResultScreen view={view} onRestart={restart} />
        ) : (
          step && (
            <>
              <h1>{step.title}</h1>
              {step.subtitle && <p className="subtitle">{step.subtitle}</p>}

              {step.help && (
                <div className="help">
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const opening = !helpOpen;
                      setHelpOpen(opening);
                      // A new event type, introduced by a config version alone.
                      if (opening) tracker.track(view.sessionId, 'help_opened', step.id, { surface: 'inline_help' });
                    }}
                  >
                    {helpOpen ? 'Hide help' : 'Need help with this?'}
                  </button>
                  {helpOpen && <p className="help-body">{step.help}</p>}
                </div>
              )}

              <StepInput step={step} value={draft} onChange={setDraft} onSubmit={submit} />

              {fieldError && <p className="field-error">{fieldError}</p>}

              <div className="actions">
                {view.history.length > 0 && (
                  <button type="button" className="btn ghost" onClick={goBack} disabled={busy}>
                    Back
                  </button>
                )}
                <button type="button" className="btn primary" onClick={submit} disabled={busy}>
                  {step.type === 'info' ? (step.continueLabel ?? 'Continue') : 'Continue'}
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

function currentStep(view: SessionView): Step | null {
  return view.config.steps.find((s) => s.id === view.currentStep) ?? null;
}

function ResultScreen({ view, onRestart }: { view: SessionView; onRestart: () => void }) {
  const result = view.config.result;
  return (
    <>
      <div className="result-badge">Done</div>
      <h1>{result.title}</h1>
      {result.body && <p className="subtitle">{result.body}</p>}
      {result.bullets && (
        <ul className="bullets">
          {result.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onRestart}>
          Start again
        </button>
        <a
          className="btn primary"
          href={result.cta.href ?? '#'}
          onClick={() =>
            tracker.track(view.sessionId, 'cta_clicked', result.id, { cta_id: result.cta.id })
          }
        >
          {result.cta.label}
        </a>
      </div>
    </>
  );
}

function StepInput({
  step,
  value,
  onChange,
  onSubmit,
}: {
  step: Step;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  onSubmit: () => void;
}) {
  if (step.type === 'info') {
    return (
      <>
        {step.body && <p className="body">{step.body}</p>}
        {step.bullets && (
          <ul className="bullets">
            {step.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </>
    );
  }

  if (step.type === 'number') {
    return (
      <div className="number-field">
        {step.unit && <span className="unit">{step.unit}</span>}
        <input
          type="number"
          inputMode="numeric"
          value={value === null || value === undefined ? '' : String(value)}
          min={step.min}
          max={step.max}
          step={step.step}
          placeholder={step.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
          autoFocus
        />
      </div>
    );
  }

  const select = step as SelectStep;
  const selected = Array.isArray(value) ? value : value === null ? [] : [String(value)];

  return (
    <div className="options" role={step.type === 'single_select' ? 'radiogroup' : 'group'}>
      {select.options.map((option) => {
        const isSelected = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={`option ${isSelected ? 'selected' : ''}`}
            aria-pressed={isSelected}
            onClick={() => {
              if (step.type === 'single_select') {
                onChange(option.id);
                return;
              }
              const max = select.maxSelected ?? select.options.length;
              if (isSelected) onChange(selected.filter((id) => id !== option.id));
              else if (selected.length < max) onChange([...selected, option.id]);
            }}
          >
            <span className="option-label">{option.label}</span>
            {option.hint && <span className="option-hint">{option.hint}</span>}
            <span className="option-mark" aria-hidden="true" />
          </button>
        );
      })}
      {step.type === 'multi_select' && select.maxSelected && (
        <p className="muted small">
          Choose up to {select.maxSelected}. Selected {selected.length}.
        </p>
      )}
    </div>
  );
}
