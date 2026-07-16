import type { Permission } from '@new-wealth/shared';

/**
 * Navigation catalog (docs/05 §2). Each item lists the permission(s) that
 * make it visible; the sidebar filters by the user's permissions so UI and
 * API never disagree.
 */
export interface NavItem {
  to: string;
  label: string;
  anyOf: Permission[];
  group: string;
}

export const NAV: NavItem[] = [
  { to: '/app/dashboard', label: 'Dashboard', anyOf: ['dashboard:view'], group: 'Overview' },
  { to: '/app/segments', label: 'Segments', anyOf: ['reports:download', 'dashboard:drilldown'], group: 'Overview' },
  { to: '/app/leads', label: 'Leads', anyOf: ['leads:read'], group: 'Daily' },
  { to: '/app/customers', label: 'Customers', anyOf: ['customers:read'], group: 'Daily' },
  { to: '/app/applications', label: 'Applications', anyOf: ['customers:read'], group: 'Daily' },
  { to: '/app/approvals', label: 'Approvals', anyOf: ['approvals:check', 'approvals:check-premature'], group: 'Daily' },
  { to: '/app/allotments', label: 'Allotments', anyOf: ['allotments:execute'], group: 'Periodic' },
  { to: '/app/payouts', label: 'Payouts', anyOf: ['payouts:generate'], group: 'Periodic' },
  { to: '/app/my-earnings', label: 'My Earnings', anyOf: ['earnings:read-own'], group: 'Periodic' },
  { to: '/app/settings', label: 'Settings', anyOf: ['settings:manage', 'settings:workflow-config'], group: 'Admin' },
  { to: '/app/users', label: 'Users', anyOf: ['users:manage'], group: 'Admin' },
];

export const NAV_GROUPS = ['Overview', 'Daily', 'Periodic', 'Admin'];
