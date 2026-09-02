import { useEffect, useState } from 'react';
import Funnel from './Funnel';
import Admin from './Admin';
import Dashboard from './Dashboard';

/**
 * Three surfaces, one bundle. A dependency-free router keeps the client small;
 * the server serves index.html for any non-/api path so deep links work.
 */
export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const params = new URLSearchParams(window.location.search);
  const funnelKey = params.get('funnel') ?? 'quickcash';

  const nav = (
    <nav className="topnav">
      <a className={path === '/' ? 'on' : ''} href="/">Funnel</a>
      <a className={path.startsWith('/admin') ? 'on' : ''} href="/admin">Versions</a>
      <a className={path.startsWith('/dashboard') ? 'on' : ''} href="/dashboard">Analytics</a>
    </nav>
  );

  let screen;
  if (path.startsWith('/admin')) screen = <Admin funnelKey={funnelKey} />;
  else if (path.startsWith('/dashboard')) screen = <Dashboard funnelKey={funnelKey} />;
  else screen = <Funnel funnelKey={funnelKey} />;

  return (
    <div className="app">
      {nav}
      {screen}
    </div>
  );
}
