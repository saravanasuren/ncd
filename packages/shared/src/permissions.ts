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
  // Super-admin-only power tool: archive (recoverable) OR permanently purge a
  // customer and their whole record. Normal correction is deactivate / deceased;
  // this exists for cleaning up erroneous or duplicate records. super_admin ONLY.
  'customers:delete',
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
  // Super-admin-only: archive (recoverable) OR permanently purge an investment
  // and everything hanging off it (schedule, collections, incentives, redemptions).
  // super_admin ONLY.
  'applications:delete',
  // locker enrollment (staff enroll a customer for a LockerHub locker; contract Part A)
  'lockers:enroll',
  // Record a deposit waiver/exception on a locker tenancy — NCD Manager+ makes,
  // Admin/CXO approves (approvals:check-premature).
  'lockers:waive',
  // Manually link a LockerHub tenant row to an NCD customer (Locker Tenants
  // page). Split OUT of lockers:waive (owner 2026-08-29) so branch staff, who
  // now hold lockers:waive for the enrolment waiver/premium buttons, do NOT also
  // get this cross-page data-linking power. Stays with NCD Manager+.
  'lockers:link-tenant',
  // Allot a locker with rent/deposit still outstanding (§A20). LockerHub asked
  // us to gate their override to a senior role — the tenancy is created against
  // money not received, so this sits with the same people who approve a waiver.
  'lockers:allot-override',
  // Remove a locker tenancy from NCD's roster view. super_admin ONLY — it hides
  // OUR row; the locker itself stays allotted on LockerHub, which owns it.
  'lockers:remove-tenant',
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
  // One-time addition/deduction on an investment's next interest payout —
  // NCD Manager and up MAKE them; Admin/CXO approve (approvals:check-premature).
  'payouts:adjust',
  // escrow reconciliation — ingest the SBI escrow statement, match inbound
  // subscription credits to enrolled investors, confirm/assign the proposals.
  'escrow:reconcile',
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
 * super_admin gets everything; admin gets everything except the destructive
 * delete permissions (users / customers / applications) — only the Super Admin
 * may delete or purge people and money records.
 */
const SUPER_ADMIN_ONLY: Permission[] = ['users:delete', 'customers:delete', 'applications:delete', 'lockers:remove-tenant'];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,

  admin: ALL.filter((p) => !SUPER_ADMIN_ONLY.includes(p)),

  cxo: [
    'customers:read',
    'dashboard:view',
    'dashboard:drilldown',
    'reports:download',
    'approvals:check-premature', // the one CXO action (docs/03 §4)
    'approvals:check-handover', // repeat-customer handover (any one of Admin/CXO/BM)
    // Allotting against unpaid money has no second approver, so it sits with
    // the people who APPROVE a waiver, not the ones who request one. An NCD
    // Manager can ask for a fee to be written off but cannot grant it; letting
    // them hand over a locker for the same money unilaterally would be the
    // weaker control for the identical outcome.
    'lockers:allot-override',
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
    'payouts:adjust',
    'escrow:reconcile',
    'approvals:check',
    'agents:manage',
    'incentives:manage-eligibility',
    'earnings:read-own',
    'dashboard:view',
    'dashboard:drilldown',
    'reports:download',
    'settings:workflow-config',
    'imports:run',
    'lockers:enroll',
    'lockers:waive',
    // Cross-page tenant→customer linking (Locker Tenants) stays with NCD Manager+.
    'lockers:link-tenant',
  ],

  branch_manager: [
    ...STAFF_FUNNEL,
    'dashboard:drilldown',
    'reports:download',
    'approvals:check-handover', // repeat-customer handover (any one of Admin/CXO/BM)
    'lockers:enroll',
    // Rent/full-rent waiver + premium-customer buttons in locker enrolment
    // (owner 2026-08-29: those buttons across all levels that enrol lockers).
    // Maker-only — Admin/CXO still approve. NOT lockers:link-tenant.
    'lockers:waive',
  ],

  // Branch staff don't see the company-wide NCD Portfolio dashboard (owner
  // 2026-07-20). Everything they need — what they brought in and what they've
  // been paid — lives on My Earnings, so they keep earnings:read-own and land
  // there instead.
  //
  // lockers:waive lets branch staff use the enrolment waiver buttons (owner
  // 2026-08-29: standard rent waiver → 6k/12k/20k, full-rent waiver, and Premium
  // customer — across all levels that enrol lockers). Maker-only: each still
  // settles only after an Admin/CXO approves it (approvals/config.ts), so the
  // two-person control holds — staff request, Admin/CXO grant. Deliberately NOT
  // lockers:link-tenant (the cross-page tenant-linking override stays manager+).
  branch_staff: [...STAFF_FUNNEL.filter((p) => p !== 'dashboard:view'), 'lockers:enroll', 'lockers:waive'],

  // Agents source leads and enrol, but must NOT approve KYC on customers they
  // enrolled — that is a segregation-of-duties break on a regulated control
  // (an external agent self-approving their own customer's verification). KYC
  // verification stays with internal staff/managers. (Review 2026-07-21.)
  // No `dashboard:view` either (owner 2026-08-05): an agent is external, and
  // the NCD Portfolio page is the company's book — outstanding, cost of funds,
  // branch and series performance. Scoping already meant they saw only their
  // own rows there, so this is about what the page IS rather than a leak. They
  // keep the funnel (leads → customer → application) and My Earnings, and land
  // on Leads like branch staff, who are filtered the same way just below.
  agent: STAFF_FUNNEL.filter((p) => p !== 'kyc:verify' && p !== 'kyc:reject' && p !== 'dashboard:view'),

  customer: ['portal:self-service'],
};
