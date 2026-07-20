/**
 * Permission catalog — the single source of truth for RBAC (docs/03 §3).
 *
 * Format: `resource:action`. The API gates every route with
 * `requirePermission(...)`; the web mirrors with `usePermission(...)`.
 * The DB `role_permissions` table is SEEDED from `DEFAULT_ROLE_PERMISSIONS`
 * below and is admin-editable — but the catalog (valid permission strings)
 * only ever changes in code.
 *
 * Never write an ad-hoc role check in route code. Add a permission here.
 */
import type { Role } from './roles.js';

export const PERMISSIONS = [
  // leads
  'leads:create',
  'leads:read', // scoped
  'leads:read-all',
  'leads:update',
  'leads:convert',
  // customers
  'customers:create',
  'customers:read', // scoped
  'customers:update',
  // NOTE: no 'customers:delete' — customers are deactivated / marked deceased,
  // never hard-deleted (financial record integrity). Deliberately absent.
  'customers:deactivate',
  'customers:correction-request',
  'customers:handover-request',
  // kyc
  'kyc:verify',
  'kyc:reject',
  // applications
  'applications:create',
  'applications:update',
  'applications:confirm-collection',
  'applications:mark-esigned',
  // activations (funded → Active, maker-checker)
  'activations:execute',
  // allotments
  'allotments:execute',
  'allotments:revert',
  // products
  'products:manage',
  // redemptions / payouts
  'redemptions:initiate',
  'payouts:generate',
  'payouts:mark-paid-manual',
  // approvals
  'approvals:check', // generic checker (never own submission)
  'approvals:check-premature', // CXO's single action power (docs/03 §4)
  'approvals:check-handover', // repeat-customer handover: any one of Admin/CXO/BM
  // agents (manual agent admin — LockerHub self-signup is separate)
  'agents:manage',
  // incentives
  'incentives:manage-eligibility',
  'incentives:pay',
  'earnings:read-own',
  // dashboard / reports
  'dashboard:view', // scoped
  'dashboard:drilldown',
  'reports:download', // scoped
  // admin
  'users:manage',
  'users:delete',
  'settings:manage',
  'settings:workflow-config',
  'audit:read',
  'imports:run',
  'notifications:admin',
  // portal
  'portal:self-service',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

/** Convenience groups used in the seed below. */
const ALL: Permission[] = [...PERMISSIONS];

const STAFF_FUNNEL: Permission[] = [
  'leads:create',
  'leads:read',
  'leads:update',
  'leads:convert',
  'customers:create',
  'customers:read',
  'customers:update',
  'customers:correction-request',
  'customers:handover-request',
  'kyc:verify',
  'kyc:reject',
  'applications:create',
  'applications:update',
  'earnings:read-own',
  'dashboard:view',
];

/**
 * Seed map role → permissions (docs/03 §3 matrix). Admin-editable at runtime.
 * super_admin gets everything; admin gets everything except the two delete
 * permissions.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,

  admin: ALL.filter((p) => p !== 'users:delete'),

  cxo: [
    'customers:read',
    'dashboard:view',
    'dashboard:drilldown',
    'reports:download',
    'approvals:check-premature', // the one CXO action (docs/03 §4)
    'approvals:check-handover', // repeat-customer handover (any one of Admin/CXO/BM)
  ],

  ncd_manager: [
    'leads:create',
    'leads:read',
    'leads:read-all',
    'leads:update',
    'leads:convert',
    'customers:create',
    'customers:read',
    'customers:update',
    'customers:correction-request',
    'customers:handover-request',
    'kyc:verify',
    'kyc:reject',
    'applications:create',
    'applications:update',
    'applications:confirm-collection',
    'applications:mark-esigned',
    'activations:execute',
    'allotments:execute',
    'products:manage',
    'redemptions:initiate',
    'payouts:generate',
    'approvals:check',
    'agents:manage',
    'incentives:manage-eligibility',
    'earnings:read-own',
    'dashboard:view',
    'dashboard:drilldown',
    'reports:download',
    'settings:workflow-config',
    'imports:run',
  ],

  branch_manager: [
    ...STAFF_FUNNEL,
    'dashboard:drilldown',
    'reports:download',
    'approvals:check-handover', // repeat-customer handover (any one of Admin/CXO/BM)
  ],

  // Branch staff don't see the company-wide NCD Portfolio dashboard (owner
  // 2026-07-20). Everything they need — what they brought in and what they've
  // been paid — lives on My Earnings, so they keep earnings:read-own and land
  // there instead.
  branch_staff: [...STAFF_FUNNEL.filter((p) => p !== 'dashboard:view')],

  agent: [...STAFF_FUNNEL],

  customer: ['portal:self-service'],
};
