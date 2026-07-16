import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '@new-wealth/shared';
import { useAuth } from '../auth/AuthContext.js';
import { api } from '../api/client.js';
import { NAV } from '../nav.js';

/** App shell (docs/05 §2): permission-generated sidebar + topbar. */
export function AppShell() {
  const { user, logout, can } = useAuth();
  const nav = useNavigate();
  const items = NAV.filter((i) => can(...i.anyOf));
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ customers: any[]; agents: any[]; staff: any[] } | null>(null);

  async function onSearch(v: string) {
    setQ(v);
    if (v.trim().length < 2) { setResults(null); return; }
    try { setResults(await api.get(`/api/dashboard/search?q=${encodeURIComponent(v)}`)); } catch { setResults(null); }
  }
  function go(to: string) { setQ(''); setResults(null); nav(to); }

  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      <aside className="bg-surface border-r border-border flex flex-col">
        <div className="px-4 py-4 border-b border-border flex items-center justify-center">
          <img src="/dhanam-logo.png" alt="Dhanam Investment and Finance" className="w-36 h-auto" />
        </div>
        <nav className="p-2 flex flex-col gap-0.5">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to}
              className={({ isActive }) =>
                `px-3 py-2 rounded text-sm ${
                  isActive ? 'bg-[color:var(--primary-ring)] text-primary font-semibold' : 'text-text-label hover:bg-bg'
                }`
              }>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex flex-col">
        <header className="h-14 bg-surface border-b border-border flex items-center px-6 gap-4">
          <div className="relative flex-1 max-w-md">
            <input placeholder="Search customers, agents, staff…" value={q} onChange={(e) => onSearch(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary" />
            {results && (q.trim().length >= 2) && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-card z-10 max-h-80 overflow-auto">
                {results.customers.map((c) => (
                  <button key={`c${c.id}`} onClick={() => go(`/app/customers/${c.id}`)} className="w-full text-left px-3 py-2 text-sm hover:bg-bg flex items-center gap-2">
                    <span className="font-medium">{c.full_name}</span><span className="text-xs text-text-muted font-mono ml-auto">{c.customer_code}</span>
                  </button>
                ))}
                {results.agents.map((a) => <div key={`a${a.id}`} className="px-3 py-2 text-sm text-text-muted">Agent: {a.full_name} <span className="font-mono text-xs">{a.agent_code}</span></div>)}
                {results.staff.map((s) => <div key={`s${s.id}`} className="px-3 py-2 text-sm text-text-muted">Staff: {s.full_name} ({s.role})</div>)}
                {!results.customers.length && !results.agents.length && !results.staff.length && <div className="px-3 py-3 text-sm text-text-muted">No matches.</div>}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <div className="text-right leading-tight">
              <div className="font-semibold">{user?.fullName}</div>
              <div className="text-xs text-text-muted">{user ? ROLE_LABELS[user.role] : ''}</div>
            </div>
            <button onClick={async () => { await logout(); nav('/login'); }}
              className="text-xs text-text-muted hover:text-danger border border-border rounded px-2 py-1">
              Sign out
            </button>
          </div>
        </header>
        <main className="p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
