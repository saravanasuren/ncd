import { useEffect, useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { ROLE_LABELS } from '@new-wealth/shared';
import { useAuth } from '../auth/AuthContext.js';
import { api } from '../api/client.js';
import { NAV } from '../nav.js';

/** App shell (docs/05 §2): permission-generated sidebar + topbar. Responsive:
 * fixed sidebar on desktop (≥ lg), a slide-in drawer with hamburger on smaller
 * screens. */
export function AppShell() {
  const { user, logout, can } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const items = NAV.filter((i) => can(...i.anyOf) && !(user && i.hideForRoles?.includes(user.role)));
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ customers: any[]; agents: any[]; staff: any[] } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer whenever the route changes (e.g. a nav item is tapped).
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  async function onSearch(v: string) {
    setQ(v);
    if (v.trim().length < 2) { setResults(null); return; }
    try { setResults(await api.get(`/api/dashboard/search?q=${encodeURIComponent(v)}`)); } catch { setResults(null); }
  }
  function go(to: string) { setQ(''); setResults(null); nav(to); }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr]">
      {/* Mobile backdrop */}
      {drawerOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setDrawerOpen(false)} aria-hidden />
      )}

      {/* Sidebar: slide-in drawer on mobile, static column on desktop */}
      <aside
        className={`bg-surface border-r border-border flex flex-col fixed inset-y-0 left-0 w-[220px] z-40
          transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:transform-none
          ${drawerOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'}`}
      >
        <div className="px-4 py-4 border-b border-border flex items-center justify-center relative">
          <img src="/dhanam-logo.png" alt="Dhanam Investment and Finance" className="w-36 h-auto" />
          <button onClick={() => setDrawerOpen(false)} aria-label="Close menu"
            className="lg:hidden absolute right-3 top-3 text-text-muted hover:text-text text-lg leading-none">✕</button>
        </div>
        <nav className="p-2 flex flex-col gap-0.5 overflow-y-auto flex-1">
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

      <div className="flex flex-col min-w-0">
        <header className="h-14 bg-surface border-b border-border flex items-center px-3 lg:px-6 gap-2 lg:gap-4">
          <button onClick={() => setDrawerOpen(true)} aria-label="Open menu"
            className="lg:hidden text-text-muted hover:text-text border border-border rounded px-2 py-1 text-lg leading-none">☰</button>
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
          <div className="ml-auto flex items-center gap-2 lg:gap-3 text-sm">
            <div className="text-right leading-tight hidden sm:block">
              <div className="font-semibold">{user?.fullName}</div>
              <div className="text-xs text-text-muted">{user ? ROLE_LABELS[user.role] : ''}</div>
            </div>
            <button onClick={async () => { await logout(); nav('/login'); }}
              className="text-xs text-text-muted hover:text-danger border border-border rounded px-2 py-1 whitespace-nowrap">
              Sign out
            </button>
          </div>
        </header>
        <main className="p-4 lg:p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
