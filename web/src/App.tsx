import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.js';
import { LoginPage } from './pages/Login.js';
import { AppShell } from './layouts/AppShell.js';
import { DashboardPlaceholder } from './pages/DashboardPlaceholder.js';
import { SettingsPage } from './pages/Settings.js';
import { UsersPage } from './pages/Users.js';
import type { ReactNode } from 'react';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-text-muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/app/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPlaceholder />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
