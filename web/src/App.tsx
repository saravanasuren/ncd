import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './pages/Login.js';
import { AppShell } from './layouts/AppShell.js';
import { Dashboard } from './pages/Dashboard.js';
import { SegmentsPage } from './pages/Segments.js';
import { SettingsPage } from './pages/Settings.js';
import { UsersPage } from './pages/Users.js';
import { LeadsPage } from './pages/Leads.js';
import { CustomersPage } from './pages/Customers.js';
import { CustomerDetailPage } from './pages/CustomerDetail.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { ApplicationsPage } from './pages/Applications.js';
import { ApplicationDetailPage } from './pages/ApplicationDetail.js';
import { AllotmentsPage } from './pages/Allotments.js';
import { PayoutsPage } from './pages/Payouts.js';
import { MyEarningsPage } from './pages/MyEarnings.js';
import { RedemptionsPage } from './pages/Redemptions.js';
import { IncentivesPage } from './pages/Incentives.js';
import { ReportsPage } from './pages/Reports.js';
import { SystemPage } from './pages/System.js';
import { PortalLogin } from './portal/PortalLogin.js';
import { PortalHome } from './portal/PortalHome.js';
import type { ReactNode } from 'react';

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

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
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
          <Route index element={<Navigate to="/app/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="segments" element={<SegmentsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="leads" element={<LeadsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:id" element={<CustomerDetailPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="applications/:id" element={<ApplicationDetailPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="allotments" element={<AllotmentsPage />} />
          <Route path="redemptions" element={<RedemptionsPage />} />
          <Route path="payouts" element={<PayoutsPage />} />
          <Route path="incentives" element={<IncentivesPage />} />
          <Route path="my-earnings" element={<MyEarningsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
