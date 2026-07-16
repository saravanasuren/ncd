import { Outlet, NavLink } from 'react-router-dom';

/**
 * App shell (docs/05 §2): permission-generated sidebar + topbar with
 * universal search. Phase 0 renders a static nav; Phase 2 wires it to the
 * permission catalog + real search.
 */
const NAV_PLACEHOLDER = [
  { to: '/app/dashboard', label: 'Dashboard' },
  // Phase 2+ items (Leads, Customers, Applications, Approvals, Reports…)
];

export function AppShell() {
  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      <aside className="bg-surface border-r border-border flex flex-col">
        <div className="px-5 py-4 border-b border-border">
          <span className="text-base font-bold text-primary tracking-tight">Dhanam NCD</span>
        </div>
        <nav className="p-2 flex flex-col gap-0.5">
          {NAV_PLACEHOLDER.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `px-3 py-2 rounded text-sm ${
                  isActive
                    ? 'bg-[color:var(--primary-ring)] text-primary font-semibold'
                    : 'text-text-label hover:bg-bg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex flex-col">
        <header className="h-14 bg-surface border-b border-border flex items-center px-6 gap-4">
          <input
            placeholder="Search customers, agents, staff…  (⌘K)"
            className="flex-1 max-w-md px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary"
          />
          <span className="ml-auto text-sm text-text-muted">Signed in</span>
        </header>
        <main className="p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
