import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/Login.js';
import { AppShell } from './layouts/AppShell.js';
import { DashboardPlaceholder } from './pages/DashboardPlaceholder.js';

/**
 * Router skeleton (Phase 0). Real auth guards + role-scoped routes land in
 * Phase 2. For now: /login and a shell with a placeholder dashboard.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Navigate to="/app/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPlaceholder />} />
      </Route>
      <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
    </Routes>
  );
}
