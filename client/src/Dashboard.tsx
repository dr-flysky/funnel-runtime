import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

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
  dataQuality: Record<string, number>;
  campaigns: string[];
  versions: number[];
  variants: string[];
  experiment: { key: string; hypothesis: string; primaryMetric: string } | null;
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
  if (!report) return <div className="admin"><p className="muted">Loading…</p></div>;

  const { overall } = report;
  const [a, b] = report.byVariant;
  const lift =
    a && b && a.ctaClickRate > 0 ? (b.ctaClickRate - a.ctaClickRate) / a.ctaClickRate : null;

  return (
    <div className="admin">
      <header className="admin-head">
        <div>
          <h1>Funnel analytics</h1>
          <p className="muted">
            Every number counts <strong>unique sessions</strong>, not events.
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
          Campaign
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">All campaigns</option>
            {report.campaigns.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Version
          <select value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">All versions</option>
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
          Include generated traffic
        </label>
      </section>

      <section className="kpis">
        <Kpi label="Started" value={String(overall.startedSessions)} hint="unique sessions" />
        <Kpi label="Reached result" value={String(overall.resultSessions)} hint={pct(overall.resultRate)} />
        <Kpi label="CTA clicks" value={String(overall.ctaSessions)} hint={pct(overall.ctaCtrOnResult) + ' of results'} />
        <Kpi label="CTA click rate" value={pct(overall.ctaClickRate)} hint="primary metric" accent />
      </section>

      {report.experiment && (
        <section className="panel">
          <h2>Experiment · {report.experiment.key}</h2>
          <p className="muted small">{report.experiment.hypothesis}</p>
          <p className="muted small"><strong>Primary metric:</strong> {report.experiment.primaryMetric}</p>

          <div className="compare">
            {report.byVariant.map((v) => (
              <div key={v.label} className="compare-card">
                <h3>{v.label}</h3>
                <div className="big">{pct(v.ctaClickRate)}</div>
                <p className="muted small">
                  {v.ctaSessions} CTA clicks from {v.startedSessions} sessions
                </p>
                <p className="muted small">Reached result: {pct(v.resultRate)}</p>
              </div>
            ))}
          </div>
          {lift !== null && (
            <p className={`lift ${lift >= 0 ? 'up' : 'down'}`}>
              Variant B is {lift >= 0 ? 'up' : 'down'} {pct(Math.abs(lift))} against A on the primary
              metric.{' '}
              <span className="muted small">
                Directional only — this sample is not powered for significance.
              </span>
            </p>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Step-by-step</h2>
        <p className="muted small">
          Conversion is <code>step_completed / step_viewed</code> per step, so it stays correct when
          users take different branches. Drop-off is the difference.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th className="num">Reached</th>
                <th className="num">Completed</th>
                <th className="num">Drop-off</th>
                <th className="num">Conversion</th>
                <th className="num">Of all starts</th>
                <th className="num">Backs</th>
                <th className="num">Views / session</th>
                <th>Funnel</th>
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

      <section className="panel">
        <h2>Version comparison</h2>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th className="num">Sessions</th>
                <th className="num">Reached result</th>
                <th className="num">Result rate</th>
                <th className="num">CTA click rate</th>
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
          <h2>Events beyond the core set</h2>
          <p className="muted small">
            Introduced by a config version, stored and reported with no schema change.
          </p>
          <table className="table">
            <thead>
              <tr><th>Event</th><th className="num">Events</th><th className="num">Sessions</th></tr>
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
        <h2>Data quality</h2>
        <p className="muted small">
          Evidence that the messy cases actually occurred and were handled, rather than never
          arriving.
        </p>
        <div className="quality">
          {Object.entries(report.dataQuality).map(([k, v]) => (
            <div key={k} className="quality-item">
              <span className="quality-value">{v}</span>
              <span className="quality-label">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
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
