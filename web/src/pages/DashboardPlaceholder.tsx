import { useEffect, useState } from 'react';

/**
 * Phase 0 placeholder — confirms the shell renders and the API is reachable
 * via the dev proxy (/api/health). The real "NCD Portfolio" dashboard with
 * KPI tiles + drill popups lands in Phase 5 (docs/06).
 */
export function DashboardPlaceholder() {
  const [health, setHealth] = useState<string>('checking…');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => setHealth(j.status === 'ok' ? 'API reachable ✓' : 'API error'))
      .catch(() => setHealth('API unreachable (start the api workspace)'));
  }, []);

  return (
    <div>
      <h1 className="text-xl font-bold tracking-tight m-0">Dashboard</h1>
      <p className="text-sm text-text-muted mt-1">
        Scaffold in place. The NCD Portfolio dashboard is built in Phase 5.
      </p>
      <div className="mt-5 bg-surface border border-border rounded-lg shadow-card p-5 max-w-sm">
        <div className="text-xs font-semibold text-text-label uppercase tracking-wide">
          API health
        </div>
        <div className="mt-1 text-sm">{health}</div>
      </div>
    </div>
  );
}
