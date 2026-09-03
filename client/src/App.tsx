import { useEffect, useState } from 'react';
import Funnel from './Funnel';
import Admin from './Admin';
import Dashboard from './Dashboard';
import { api } from './api';
import { t } from './strings';

/**
 * Three surfaces, one bundle. A dependency-free router keeps the client small;
 * the server serves index.html for any non-/api path so deep links work.
 *
 * The funnel key is never hardcoded here. `?funnel=` wins if present, otherwise
 * we ask the server what is published — so the default lives in exactly one
 * place (DEFAULT_FUNNEL_KEY on the server) and swapping in a different config
 * needs no client change.
 */
export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [funnelKey, setFunnelKey] = useState<string | null>(
    new URLSearchParams(window.location.search).get('funnel'),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (funnelKey) return;
    let cancelled = false;
    api
      .funnels()
      .then(({ funnels }) => {
        if (cancelled) return;
        const live = funnels.find((f) => f.activeVersion !== null) ?? funnels[0];
        if (live) setFunnelKey(live.key);
        else setError(t.boot.noFunnelPublished);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [funnelKey]);

  const nav = (
    <nav className="topnav">
      <a className={path === '/' ? 'on' : ''} href="/">{t.nav.funnel}</a>
      <a className={path.startsWith('/admin') ? 'on' : ''} href="/admin">{t.nav.versions}</a>
      <a className={path.startsWith('/dashboard') ? 'on' : ''} href="/dashboard">{t.nav.analytics}</a>
    </nav>
  );

  let screen;
  if (error) {
    screen = (
      <div className="shell">
        <div className="card error-card">
          <h2>{t.boot.nothingTitle}</h2>
          <p className="muted">{error}</p>
          <p className="muted small">
            {t.boot.publishHint} <code>npm run seed</code>{t.boot.thenReload}
          </p>
        </div>
      </div>
    );
  } else if (!funnelKey) {
    screen = (
      <div className="shell">
        <div className="card">
          <div className="skeleton" />
          <div className="skeleton short" />
        </div>
      </div>
    );
  } else if (path.startsWith('/admin')) {
    screen = <Admin funnelKey={funnelKey} />;
  } else if (path.startsWith('/dashboard')) {
    screen = <Dashboard funnelKey={funnelKey} />;
  } else {
    screen = <Funnel funnelKey={funnelKey} />;
  }

  return (
    <div className="app">
      {nav}
      {screen}
    </div>
  );
}
