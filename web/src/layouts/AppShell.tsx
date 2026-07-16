import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '@new-wealth/shared';
import { useAuth } from '../auth/AuthContext.js';
import { NAV } from '../nav.js';

/** App shell (docs/05 §2): permission-generated sidebar + topbar. */
export function AppShell() {
  const { user, logout, can } = useAuth();
  const nav = useNavigate();
  const items = NAV.filter((i) => can(...i.anyOf));

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
          <input placeholder="Search customers, agents, staff…  (⌘K)"
            className="flex-1 max-w-md px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary" />
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
