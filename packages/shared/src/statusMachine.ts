/**
 * Status state machines — single source of truth for every entity lifecycle
 * (docs/01 §4, docs/02). Ported/adapted from the old app's `status.js`.
 *
 * The API's only legal way to change a status is via `assertTransition`.
 * SQL CHECK constraints mirror the vocabularies for DB-level integrity.
 *
 * Vocabulary follows the NEW data model (docs/02 §4): the application
 * collection state is `PendingFundVerification` (old app called it
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
    Draft: { label: 'Draft', next: ['PendingApproval', 'PendingFundVerification', 'Cancelled'] },
    PendingApproval: {
      label: 'Pending Approval',
      next: ['PendingFundVerification', 'PendingEsign', 'PendingActivation', 'PendingAllotment', 'Cancelled', 'Rejected'],
    },
    PendingFundVerification: {
      label: 'Pending Fund Verification',
      next: ['PendingEsign', 'PendingActivation', 'PendingAllotment', 'Cancelled', 'Rejected'],
    },
    PendingEsign: { label: 'Awaiting eSign', next: ['PendingActivation', 'PendingAllotment', 'Cancelled'] },
    // Funded, awaiting the maker-checker activation approval. Activation (not
    // allotment) is what turns money-in-the-account into a live NCD.
    PendingActivation: { label: 'Pending Activation', next: ['Active', 'Cancelled', 'Rejected'] },
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

/**
 * Application statuses that count as a live, outstanding NCD on the book — the
 * "Active (net)" figure the old app reports. Byte-compatible with the legacy
 * rule (see integration/shared.ts `customerFacingStatus`): funded money reads
 * as outstanding from the moment it lands, wherever it currently sits in the
 * approval/allotment pipeline, until it exits (Matured/Redeemed/RolledOver/
 * PrematureWithdrawn/Transferred) or is killed (Cancelled/Rejected). `Draft`
 * is pre-funding and excluded — that is the "raised minus cancelled" gap seen
 * on an open series (e.g. NCD 27: raised ₹7.59 Cr vs active-net ₹7.58 Cr).
 *
 * Consequence: money subscribed to a still-Open series (pre-allotment) is part
 * of the outstanding book, so the dashboard/export match the old app rather
 * than showing ₹0 for an open series.
 */
export const OUTSTANDING_APPLICATION_STATUSES = [
  'PendingApproval',
  'PendingFundVerification',
  'PendingEsign',
  'PendingActivation',
  'PendingAllotment',
  'Active',
] as const;

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
