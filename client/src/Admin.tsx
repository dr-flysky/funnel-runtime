import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type VersionSummary } from './api';

interface Activation {
  id: number;
  version: number;
  action: string;
  note: string | null;
  created_at: string;
}

export default function Admin({ funnelKey }: { funnelKey: string }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [files, setFiles] = useState<{ file: string; key: string | null; steps: number }[]>([]);
  const [funnels, setFunnels] = useState<{ key: string; activeVersion: number | null }[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; issues?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [v, f, fn] = await Promise.all([api.versions(funnelKey), api.configFiles(), api.funnels()]);
    setVersions(v.versions);
    setActivations(v.activations);
    setFiles(f.files.filter((x) => x.key === funnelKey));
    setFunnels(fn.funnels);
  }, [funnelKey]);

  useEffect(() => {
    refresh().catch((e) => setMessage({ kind: 'err', text: String(e) }));
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await refresh();
      setMessage({ kind: 'ok', text: ok });
    } catch (err) {
      if (err instanceof ApiError) setMessage({ kind: 'err', text: err.message, issues: err.issues });
      else setMessage({ kind: 'err', text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const active = versions.find((v) => v.isActive);

  return (
    <div className="admin">
      <header className="admin-head">
        <div>
          <h1>Version control</h1>
          <p className="muted">
            Funnel <code>{funnelKey}</code> — active version{' '}
            <strong>v{active?.version ?? '—'}</strong>
          </p>
        </div>
        <nav className="tabs">
          {funnels.map((f) => (
            <a
              key={f.key}
              className={`tab ${f.key === funnelKey ? 'on' : ''}`}
              href={`/admin?funnel=${f.key}`}
            >
              {f.key}
            </a>
          ))}
        </nav>
      </header>

      {message && (
        <div className={`banner ${message.kind}`}>
          <strong>{message.text}</strong>
          {message.issues && (
            <ul>
              {message.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="panel">
        <h2>Publish from the repo</h2>
        <p className="muted small">
          Publishing appends a new immutable version and points new traffic at it. Sessions already
          in flight keep running on the version they started with — no redeploy, no migration.
        </p>
        <div className="file-list">
          {files.length === 0 && <p className="muted">No config files for this funnel.</p>}
          {files.map((f) => (
            <div key={f.file} className="file-row">
              <div>
                <code>{f.file}</code>
                <span className="muted small"> · {f.steps} steps</span>
              </div>
              <button
                className="btn small"
                disabled={busy}
                onClick={() => run(() => api.publishFile(f.file), `Published ${f.file}`)}
              >
                Publish
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Versions</h2>
          <button
            className="btn small danger"
            disabled={busy || versions.length < 2}
            onClick={() => run(() => api.rollback(funnelKey), 'Rolled back to the previous version')}
          >
            Roll back
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Steps</th>
              <th>Variants</th>
              <th>Experiment</th>
              <th>Published</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className={v.isActive ? 'active-row' : ''}>
                <td>
                  <strong>v{v.version}</strong>
                  {v.isActive && <span className="pill ok">active</span>}
                </td>
                <td>{v.stepCount}</td>
                <td>{v.variants.join(' / ')}</td>
                <td className="muted small">{v.experimentKey}</td>
                <td className="muted small">{new Date(v.createdAt).toLocaleString()}</td>
                <td className="muted small">{v.note}</td>
                <td>
                  {!v.isActive && (
                    <button
                      className="btn small ghost"
                      disabled={busy}
                      onClick={() => run(() => api.activate(funnelKey, v.id), `Activated v${v.version}`)}
                    >
                      Activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Activation history</h2>
        <ul className="timeline">
          {activations.map((a) => (
            <li key={a.id}>
              <span className={`pill ${a.action === 'rollback' ? 'warn' : 'ghost'}`}>{a.action}</span>
              <strong>v{a.version}</strong>
              <span className="muted small">{new Date(a.created_at).toLocaleString()}</span>
              {a.note && <span className="muted small">— {a.note}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
