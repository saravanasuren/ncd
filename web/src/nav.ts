import type { Permission } from '@new-wealth/shared';

/**
 * Navigation catalog (docs/05 §2). Each item lists the permission(s) that
 * make it visible; the sidebar filters by the user's permissions so UI and
 * API never disagree. Grouped like doc 05. More items land per phase.
 */
export interface NavItem {
  to: string;
  label: string;
  anyOf: Permission[]; // visible if the user holds ANY of these
  group: string;
}

export const NAV: NavItem[] = [
  { to: '/app/dashboard', label: 'Dashboard', anyOf: ['dashboard:view'], group: 'Overview' },
  // Phase 3+ (Leads, Customers, Applications, Approvals) will be added here.
  { to: '/app/settings', label: 'Settings', anyOf: ['settings:manage', 'settings:workflow-config'], group: 'Admin' },
  { to: '/app/users', label: 'Users', anyOf: ['users:manage'], group: 'Admin' },
];

export const NAV_GROUPS = ['Overview', 'Daily', 'Periodic', 'Admin'];
