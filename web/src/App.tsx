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
import { LockerEnrollmentPage } from './pages/LockerEnrollment.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { ApplicationsPage } from './pages/Applications.js';
import { ApplicationDetailPage } from './pages/ApplicationDetail.js';
import { AgentsPage } from './pages/Agents.js';
import { PersonDetailPage } from './pages/PersonDetail.js';
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
 * user's own landing page instead of rendering a page that just fails. Accepts
 * a single permission or a list (nav items are `anyOf`); access is granted when
 * the user holds ANY of them. */
function RequirePerm({ perm, children }: { perm: Permission | Permission[]; children: ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <div className="p-8 text-text-muted">Loading…</div>;
  const perms = Array.isArray(perm) ? perm : [perm];
  return can(...perms) ? <>{children}</> : <HomeRedirect />;
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
          <Route path="segments" element={<RequirePerm perm={['reports:download', 'dashboard:drilldown']}><SegmentsPage /></RequirePerm>} />
          <Route path="reports" element={<RequirePerm perm="reports:download"><ReportsPage /></RequirePerm>} />
          <Route path="system" element={<RequirePerm perm={['audit:read', 'notifications:admin']}><SystemPage /></RequirePerm>} />
          <Route path="leads" element={<RequirePerm perm="leads:read"><LeadsPage /></RequirePerm>} />
          <Route path="customers" element={<RequirePerm perm="customers:read"><CustomersPage /></RequirePerm>} />
          <Route path="customers/:id" element={<RequirePerm perm="customers:read"><CustomerDetailPage /></RequirePerm>} />
          <Route path="people/:type/:id" element={<RequirePerm perm="dashboard:drilldown"><PersonDetailPage /></RequirePerm>} />
          <Route path="locker-enrollment" element={<RequirePerm perm="lockers:enroll"><LockerEnrollmentPage /></RequirePerm>} />
          <Route path="applications" element={<RequirePerm perm="customers:read"><ApplicationsPage /></RequirePerm>} />
          <Route path="applications/:id" element={<RequirePerm perm="customers:read"><ApplicationDetailPage /></RequirePerm>} />
          <Route path="approvals" element={<RequirePerm perm={['approvals:check', 'approvals:check-premature', 'approvals:check-handover']}><ApprovalsPage /></RequirePerm>} />
          <Route path="agents" element={<RequirePerm perm="agents:manage"><AgentsPage /></RequirePerm>} />
          <Route path="allotments" element={<RequirePerm perm="allotments:execute"><AllotmentsPage /></RequirePerm>} />
          <Route path="redemptions" element={<RequirePerm perm="redemptions:initiate"><RedemptionsPage /></RequirePerm>} />
          <Route path="ncd-events" element={<RequirePerm perm="redemptions:initiate"><EventsPage /></RequirePerm>} />
          <Route path="masters" element={<RequirePerm perm="products:manage"><MastersPage /></RequirePerm>} />
          <Route path="payouts" element={<RequirePerm perm="payouts:generate"><PayoutsPage /></RequirePerm>} />
          <Route path="incentives" element={<RequirePerm perm="incentives:manage-eligibility"><IncentivesPage /></RequirePerm>} />
          <Route path="my-earnings" element={<RequirePerm perm="earnings:read-own"><MyEarningsPage /></RequirePerm>} />
          <Route path="settings" element={<RequirePerm perm={['settings:manage', 'settings:workflow-config']}><SettingsPage /></RequirePerm>} />
          <Route path="users" element={<RequirePerm perm="users:manage"><UsersPage /></RequirePerm>} />
        </Route>
        {/* Unknown path → /app, which routes each user to a page they can open. */}
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </AuthProvider>
  );
}
