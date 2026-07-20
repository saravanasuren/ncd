import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './pages/Login.js';
import { ForgotPasswordPage } from './pages/ForgotPassword.js';
import { SignupPage } from './pages/Signup.js';
import { ResetPasswordPage } from './pages/ResetPassword.js';
import { AppShell } from './layouts/AppShell.js';
// Lazy-loaded: the dashboard pulls in the (heavy) charting library, so it
// code-splits into its own chunk and keeps the initial bundle light.
const Dashboard = lazy(() => import('./pages/Dashboard.js').then((m) => ({ default: m.Dashboard })));
import { SegmentsPage } from './pages/Segments.js';
import { SettingsPage } from './pages/Settings.js';
import { UsersPage } from './pages/Users.js';
import { LeadsPage } from './pages/Leads.js';
import { CustomersPage } from './pages/Customers.js';
import { CustomerDetailPage } from './pages/CustomerDetail.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { ApplicationsPage } from './pages/Applications.js';
import { ApplicationDetailPage } from './pages/ApplicationDetail.js';
import { AgentsPage } from './pages/Agents.js';
import { AllotmentsPage } from './pages/Allotments.js';
import { PayoutsPage } from './pages/Payouts.js';
import { MyEarningsPage } from './pages/MyEarnings.js';
import { RedemptionsPage } from './pages/Redemptions.js';
import { IncentivesPage } from './pages/Incentives.js';
import { ReportsPage } from './pages/Reports.js';
import { SystemPage } from './pages/System.js';
import { MastersPage } from './pages/Masters.js';
import { EventsPage } from './pages/Events.js';
import { PortalLogin } from './portal/PortalLogin.js';
import { PortalHome } from './portal/PortalHome.js';
import type { ReactNode } from 'react';
import type { Permission } from '@new-wealth/shared';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-text-muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'customer') return <Navigate to="/portal/home" replace />;
  return <>{children}</>;
}

function RequirePortal({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-text-muted">Loading…</div>;
  if (!user) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}

/** Land somewhere the user can actually open. Branch staff don't hold
 * dashboard:view — they work the funnel, so Leads is their landing page. */
function HomeRedirect() {
  const { can } = useAuth();
  if (can('dashboard:view')) return <Navigate to="/app/dashboard" replace />;
  if (can('leads:read')) return <Navigate to="/app/leads" replace />;
  return <Navigate to="/app/my-earnings" replace />;
}

/** Guard a route by permission — a stale bookmark or typed URL bounces to the
 * user's own landing page instead of rendering a page that just fails. */
function RequirePerm({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <div className="p-8 text-text-muted">Loading…</div>;
  return can(perm) ? <>{children}</> : <HomeRedirect />;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/portal" element={<PortalLogin />} />
        <Route path="/portal/home" element={<RequirePortal><PortalHome /></RequirePortal>} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route path="dashboard" element={<RequirePerm perm="dashboard:view"><Suspense fallback={<div className="text-text-muted">Loading dashboard…</div>}><Dashboard /></Suspense></RequirePerm>} />
          <Route path="segments" element={<SegmentsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="leads" element={<LeadsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="applications/:id" element={<ApplicationDetailPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="allotments" element={<AllotmentsPage />} />
          <Route path="redemptions" element={<RedemptionsPage />} />
          <Route path="ncd-events" element={<EventsPage />} />
          <Route path="masters" element={<MastersPage />} />
          <Route path="payouts" element={<PayoutsPage />} />
          <Route path="incentives" element={<IncentivesPage />} />
          <Route path="my-earnings" element={<MyEarningsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        {/* Unknown path → /app, which routes each user to a page they can open. */}
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </AuthProvider>
  );
}
