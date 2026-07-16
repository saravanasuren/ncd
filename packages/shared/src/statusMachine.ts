/**
 * Status state machines — single source of truth for every entity lifecycle
 * (docs/01 §4, docs/02). Ported/adapted from the old app's `status.js`.
 *
 * The API's only legal way to change a status is via `assertTransition`.
 * SQL CHECK constraints mirror the vocabularies for DB-level integrity.
 *
 * Vocabulary follows the NEW data model (docs/02 §4): the application
 * collection state is `PendingCollection` (old app called it
 * PendingFundVerification).
 */

export interface StatusNode {
  label: string;
  next: string[];
  terminal?: boolean;
}

export type StatusMap = Record<string, StatusNode>;

export const STATUS_MACHINES = {
  application: {
    Draft: { label: 'Draft', next: ['PendingApproval', 'PendingCollection', 'Cancelled'] },
    PendingApproval: {
      label: 'Pending Approval',
      next: ['PendingCollection', 'PendingEsign', 'PendingAllotment', 'Cancelled', 'Rejected'],
    },
    PendingCollection: {
      label: 'Pending Collection',
      next: ['PendingEsign', 'PendingAllotment', 'Cancelled', 'Rejected'],
    },
    PendingEsign: { label: 'Awaiting eSign', next: ['PendingAllotment', 'Cancelled'] },
    PendingAllotment: { label: 'Pending Allotment', next: ['Active', 'Cancelled'] },
    Active: {
      label: 'Active',
      next: ['Matured', 'Redeemed', 'RolledOver', 'PrematureWithdrawn', 'Transferred'],
    },
    Matured: { label: 'Matured', next: ['Redeemed', 'RolledOver'] },
    Redeemed: { label: 'Redeemed', next: [], terminal: true },
    RolledOver: { label: 'Rolled Over', next: [], terminal: true },
    PrematureWithdrawn: { label: 'Premature Withdrawal', next: [], terminal: true },
    Transferred: { label: 'Transferred', next: [], terminal: true },
    Cancelled: { label: 'Cancelled', next: [], terminal: true },
    Rejected: { label: 'Rejected', next: [], terminal: true },
  },

  application_line: {
    Active: { label: 'Active', next: ['Matured', 'PrematureWithdrawn', 'RolledOver'] },
    Matured: { label: 'Matured', next: [], terminal: true },
    PrematureWithdrawn: { label: 'Premature Withdrawal', next: [], terminal: true },
    RolledOver: { label: 'Rolled Over', next: [], terminal: true },
  },

  disbursement: {
    Scheduled: { label: 'Scheduled', next: ['Paid', 'Failed', 'Skipped'] },
    Paid: { label: 'Paid', next: [], terminal: true },
    Failed: { label: 'Failed', next: ['Scheduled'] },
    Skipped: { label: 'Skipped', next: [], terminal: true },
  },

  payout_batch: {
    Draft: { label: 'Draft', next: ['PendingChecker', 'Cancelled'] },
    PendingChecker: { label: 'Pending Checker', next: ['Approved', 'Failed', 'Cancelled'] },
    Approved: { label: 'Approved', next: ['Downloaded', 'Cancelled'] },
    Downloaded: { label: 'Downloaded', next: ['Reconciled', 'Failed'] },
    Reconciled: { label: 'Reconciled', next: [], terminal: true },
    Failed: { label: 'Failed', next: [], terminal: true },
    Cancelled: { label: 'Cancelled', next: [], terminal: true },
  },

  // Generic maker-checker request. Levels are config-driven (docs/03 §4);
  // this machine only encodes the coarse pending→terminal shape.
  approval_request: {
    Pending: { label: 'Pending', next: ['Approved', 'Rejected'] },
    Approved: { label: 'Approved', next: [], terminal: true },
    Rejected: { label: 'Rejected', next: [], terminal: true },
  },

  series: {
    Open: { label: 'Open', next: ['Closing', 'Allotted', 'Withdrawn'] },
    Closing: { label: 'Closing', next: ['Open', 'Allotted', 'Withdrawn'] },
    Allotted: { label: 'Allotted', next: ['Open', 'Closed', 'Withdrawn'] },
    Closed: { label: 'Closed', next: ['Open', 'Allotted', 'Withdrawn'] },
    Withdrawn: { label: 'Withdrawn', next: [], terminal: true },
  },

  customer_kyc: {
    Pending: { label: 'Pending', next: ['InProgress', 'Verified', 'Rejected'] },
    InProgress: { label: 'In Progress', next: ['Verified', 'Rejected', 'Expired'] },
    Verified: { label: 'Verified', next: ['Rejected'] },
    Rejected: { label: 'Rejected', next: ['Pending'] },
    Expired: { label: 'Expired', next: ['Pending'] },
  },

  redemption: {
    Requested: { label: 'Requested', next: ['Approved', 'Rejected'] },
    Approved: { label: 'Approved', next: ['Paid'] },
    Paid: { label: 'Paid', next: [], terminal: true },
    Rejected: { label: 'Rejected', next: [], terminal: true },
  },
} as const satisfies Record<string, StatusMap>;

export type Entity = keyof typeof STATUS_MACHINES;

export function canTransition(entity: Entity, from: string, to: string): boolean {
  const node = (STATUS_MACHINES[entity] as StatusMap)[from];
  return !!node && node.next.includes(to);
}

export function isTerminal(entity: Entity, status: string): boolean {
  const node = (STATUS_MACHINES[entity] as StatusMap)[status];
  return !!node && (node.terminal === true || node.next.length === 0);
}

export function statusLabel(entity: Entity, status: string): string {
  const node = (STATUS_MACHINES[entity] as StatusMap)[status];
  return node ? node.label : status;
}

export function validTransitions(entity: Entity, from: string): string[] {
  const node = (STATUS_MACHINES[entity] as StatusMap)[from];
  return node ? [...node.next] : [];
}
