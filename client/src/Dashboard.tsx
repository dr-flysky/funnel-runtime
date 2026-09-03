import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { t } from './strings';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface StepMetrics {
  stepId: string;
  title: string;
  reached: number;
  completed: number;
  dropOff: number;
  completionRate: number;
  dropOffRate: number;
  reachFromStart: number;
  backs: number;
  viewsPerSession: number;
}

interface Segment {
  label: string;
  version?: number;
  variant?: string;
  startedSessions: number;
  resultSessions: number;
  ctaSessions: number;
  ctaClickRate: number;
  resultRate: number;
  ctaCtrOnResult: number;
  steps: StepMetrics[];
}

interface Report {
  funnelKey: string;
  overall: Segment;
  byVariant: Segment[];
  byVersion: Segment[];
  customEvents: { type: string; events: number; sessions: number }[];
  dataQuality: {
    scoped: Record<string, number>;
    allTime: Record<string, number>;
  };
  campaigns: string[];
  versions: number[];
  variants: string[];
  experiment: { id: string; variants: string[]; assignment: string } | null;
  results: {
    resultId: string;
    title: string;
    sessions: number;
    share: number;
    ctaSessions: number;
    ctaRate: number;
  }[];
}

export default function Dashboard({ funnelKey }: { funnelKey: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [campaign, setCampaign] = useState('');
  const [version, setVersion] = useState('');
  const [includeSynthetic, setIncludeSynthetic] = useState(true);
  const [funnels, setFunnels] = useState<{ key: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = { funnelKey };
      if (campaign) params.campaign = campaign;
      if (version) params.version = version;
      if (!includeSynthetic) params.includeSynthetic = 'false';
      setReport(await api.analytics(params));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [funnelKey, campaign, version, includeSynthetic]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.funnels().then((f) => setFunnels(f.funnels)).catch(() => undefined);
  }, []);

  if (error) return <div className="admin"><div className="banner err">{error}</div></div>;
  if (!report) return <div className="admin"><p className="muted">{t.common.loading}</p></div>;

  const { overall } = report;
  const [a, b] = report.byVariant;
  const lift =
    a && b && a.ctaClickRate > 0 ? (b.ctaClickRate - a.ctaClickRate) / a.ctaClickRate : null;

  return (
    <div className="admin">
      <header className="admin-head">
        <div>
          <h1>{t.dashboard.title}</h1>
          <p className="muted">
            {t.dashboard.subtitlePrefix} <strong>{t.dashboard.subtitle}</strong>
            {t.dashboard.subtitleSuffix}
          </p>
        </div>
        <nav className="tabs">
          {funnels.map((f) => (
            <a
              key={f.key}
              className={`tab ${f.key === funnelKey ? 'on' : ''}`}
              href={`/dashboard?funnel=${f.key}`}
            >
              {f.key}
            </a>
          ))}
        </nav>
      </header>

      <section className="filters">
        <label>
          {t.dashboard.filters.campaign}
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">{t.dashboard.filters.allCampaigns}</option>
            {report.campaigns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          {t.dashboard.filters.version}
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">{t.dashboard.filters.allVersions}</option>
            {report.versions.map((v) => (
              <option key={v} value={String(v)}>v{v}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeSynthetic}
            onChange={(e) => setIncludeSynthetic(e.target.checked)}
          />
          {t.dashboard.filters.includeSynthetic}
        </label>
      </section>

      <section className="kpis">
        <Kpi label={t.dashboard.kpi.started} value={String(overall.startedSessions)} hint={t.dashboard.kpi.uniqueSessions} />
        <Kpi label={t.dashboard.kpi.reachedResult} value={String(overall.resultSessions)} hint={pct(overall.resultRate)} />
        <Kpi label={t.dashboard.kpi.ctaClicks} value={String(overall.ctaSessions)} hint={`${pct(overall.ctaCtrOnResult)} ${t.dashboard.kpi.ofResults}`} />
        <Kpi label={t.dashboard.kpi.ctaClickRate} value={pct(overall.ctaClickRate)} hint={t.dashboard.kpi.primaryMetric} accent />
      </section>

      {report.experiment && (
        <section className="panel">
          <h2>
            {t.dashboard.experiment.heading} · {report.experiment.id}
          </h2>
          <p className="muted small">
            {t.dashboard.experiment.description}
          </p>
          <p className="muted small">
            <strong>{t.dashboard.experiment.primaryMetricLabel}</strong>{' '}
            {t.dashboard.experiment.primaryMetricBody('cta_clicked', 'session_started')}
          </p>

          <div className="compare">
            {report.byVariant.map((v) => (
              <div key={v.label} className="compare-card">
                <h3>{v.label}</h3>
                <div className="big">{pct(v.ctaClickRate)}</div>
                <p className="muted small">
                  {t.dashboard.experiment.ctaFrom(v.ctaSessions, v.startedSessions)}
                </p>
                <p className="muted small">
                  {t.dashboard.experiment.reachedResult} {pct(v.resultRate)}
                </p>
              </div>
            ))}
          </div>
          {lift !== null && (
            <p className={`lift ${lift >= 0 ? 'up' : 'down'}`}>
              {t.dashboard.experiment.lift(
                lift >= 0 ? t.dashboard.experiment.liftUp : t.dashboard.experiment.liftDown,
                pct(Math.abs(lift)),
              )}{' '}
              <span className="muted small">{t.dashboard.experiment.liftCaveat}</span>
            </p>
          )}
        </section>
      )}

      <section className="panel">
        <h2>{t.dashboard.steps.heading}</h2>
        <p className="muted small">
          {t.dashboard.steps.note}
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t.dashboard.steps.columns.step}</th>
                <th className="num">{t.dashboard.steps.columns.reached}</th>
                <th className="num">{t.dashboard.steps.columns.completed}</th>
                <th className="num">{t.dashboard.steps.columns.dropOff}</th>
                <th className="num">{t.dashboard.steps.columns.conversion}</th>
                <th className="num">{t.dashboard.steps.columns.ofAllStarts}</th>
                <th className="num">{t.dashboard.steps.columns.backs}</th>
                <th className="num">{t.dashboard.steps.columns.viewsPerSession}</th>
                <th>{t.dashboard.steps.columns.funnel}</th>
              </tr>
            </thead>
            <tbody>
              {overall.steps.map((s) => (
                <tr key={s.stepId}>
                  <td>
                    <strong>{s.title}</strong>
                    <div className="muted small"><code>{s.stepId}</code></div>
                  </td>
                  <td className="num">{s.reached}</td>
                  <td className="num">{s.completed}</td>
                  <td className="num warn-text">{s.dropOff}</td>
                  <td className="num">{pct(s.completionRate)}</td>
                  <td className="num muted">{pct(s.reachFromStart)}</td>
                  <td className="num muted">{s.backs}</td>
                  <td className="num muted">{s.viewsPerSession.toFixed(2)}</td>
                  <td className="bar-cell">
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${s.reachFromStart * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {report.results.length > 0 && (
        <section className="panel">
          <h2>{t.dashboard.results.heading}</h2>
          <p className="muted small">
            {t.dashboard.results.note}
          </p>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t.dashboard.results.columns.result}</th>
                  <th className="num">{t.dashboard.results.columns.sessions}</th>
                  <th className="num">{t.dashboard.results.columns.share}</th>
                  <th className="num">{t.dashboard.results.columns.ctaClicks}</th>
                  <th className="num">{t.dashboard.results.columns.ctaRate}</th>
                  <th>{t.dashboard.results.columns.share}</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.resultId}>
                    <td>
                      <strong>{r.title}</strong>
                      <div className="muted small"><code>{r.resultId}</code></div>
                    </td>
                    <td className="num">{r.sessions}</td>
                    <td className="num">{pct(r.share)}</td>
                    <td className="num">{r.ctaSessions}</td>
                    <td className="num">{pct(r.ctaRate)}</td>
                    <td className="bar-cell">
                      <div className="bar">
                        <div className="bar-fill" style={{ width: `${r.share * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>{t.dashboard.versions.heading}</h2>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t.dashboard.versions.columns.version}</th>
                <th className="num">{t.dashboard.versions.columns.sessions}</th>
                <th className="num">{t.dashboard.versions.columns.reachedResult}</th>
                <th className="num">{t.dashboard.versions.columns.resultRate}</th>
                <th className="num">{t.dashboard.versions.columns.ctaClickRate}</th>
              </tr>
            </thead>
            <tbody>
              {report.byVersion.map((v) => (
                <tr key={v.label}>
                  <td><strong>{v.label}</strong></td>
                  <td className="num">{v.startedSessions}</td>
                  <td className="num">{v.resultSessions}</td>
                  <td className="num">{pct(v.resultRate)}</td>
                  <td className="num">{pct(v.ctaClickRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {report.customEvents.length > 0 && (
        <section className="panel">
          <h2>{t.dashboard.customEvents.heading}</h2>
          <p className="muted small">
            {t.dashboard.customEvents.note}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>{t.dashboard.customEvents.columns.event}</th>
                <th className="num">{t.dashboard.customEvents.columns.events}</th>
                <th className="num">{t.dashboard.customEvents.columns.sessions}</th>
              </tr>
            </thead>
            <tbody>
              {report.customEvents.map((c) => (
                <tr key={c.type}>
                  <td><code>{c.type}</code></td>
                  <td className="num">{c.events}</td>
                  <td className="num">{c.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2>{t.dashboard.quality.heading}</h2>
        <p className="muted small">
          {t.dashboard.quality.note}
        </p>

        <h3 className="quality-head">{t.dashboard.quality.scopedHeading}</h3>
        <div className="quality">
          {Object.entries(report.dataQuality.scoped).map(([k, v]) => (
            <div key={k} className="quality-item">
              <span className="quality-value">{v}</span>
              <span className="quality-label">{t.dashboard.quality.labels[k] ?? k}</span>
            </div>
          ))}
        </div>

        <h3 className="quality-head">{t.dashboard.quality.allTimeHeading}</h3>
        <p className="muted small">
          {t.dashboard.quality.allTimeNote}
        </p>
        <div className="quality">
          {Object.entries(report.dataQuality.allTime).map(([k, v]) => (
            <div key={k} className="quality-item">
              <span className="quality-value">{v}</span>
              <span className="quality-label">{t.dashboard.quality.labels[k] ?? k}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={`kpi ${accent ? 'accent' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}
