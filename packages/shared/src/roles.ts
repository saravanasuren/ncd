/** The 8 roles — owner-confirmed 2026-07-16 (docs/03). No legacy roles. */
export const ROLES = [
  'super_admin',
  'admin',
  'cxo',
  'ncd_manager',
  'branch_manager',
  'branch_staff',
  'agent',
  'customer',
] as const;

export type Role = (typeof ROLES)[number];

/** Human labels for UI. */
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  cxo: 'CXO',
  ncd_manager: 'NCD Manager',
  branch_manager: 'Branch Manager',
  branch_staff: 'Branch Staff',
  agent: 'Agent',
  customer: 'Customer',
};

/**
 * Cumulative seniority level — used only for coarse UI ordering and
 * "admin-tier" style checks. Authorization itself is permission-based
 * (see permissions.ts), never level-based.
 */
export const ROLE_LEVEL: Record<Role, number> = {
  super_admin: 7,
  admin: 6,
  cxo: 5,
  ncd_manager: 5,
  branch_manager: 3,
  branch_staff: 2,
  agent: 2,
  customer: 0,
};

/** Roles that are internal staff (get the AppShell, not the customer portal). */
export const STAFF_ROLES: Role[] = ROLES.filter((r) => r !== 'customer');

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}
