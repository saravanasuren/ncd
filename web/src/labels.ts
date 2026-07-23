/**
 * Human-readable labels for internal enum tokens. Raw tokens like
 * `PendingFundVerification` or lowercase `premature` should never reach a user;
 * these maps translate the known ones and `humanize()` is a safe fallback for
 * anything not explicitly listed (splits camelCase / snake_case, capitalizes).
 */

/** Split camelCase / snake_case / kebab-case and capitalize each word. */
export function humanize(token: string): string {
  if (!token) return '';
  const spaced = token
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Application + customer creation statuses. */
export const STATUS_LABELS: Record<string, string> = {
  Draft: 'Draft',
  Approved: 'Approved',
  PendingApproval: 'Pending approval',
  PendingFundVerification: 'Pending fund verification',
  PendingEsign: 'Pending e-sign',
  PendingAllotment: 'Pending allotment',
  PendingActivation: 'Pending activation',
  Active: 'Active',
  Redeemed: 'Redeemed',
  Matured: 'Matured',
  PrematureWithdrawn: 'Premature withdrawn',
  RolledOver: 'Rolled over',
  Transferred: 'Transferred',
};

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? humanize(s);
}

/** Redemption type tokens. */
export const REDEMPTION_TYPE_LABELS: Record<string, string> = {
  premature: 'Premature',
  maturity: 'Maturity',
};

export function redemptionTypeLabel(t: string): string {
  return REDEMPTION_TYPE_LABELS[t] ?? humanize(t);
}

/** Approval request types (shown as section headers / card titles). */
export const APPROVAL_TYPE_LABELS: Record<string, string> = {
  customer_creation: 'New Customer',
  customer_correction: 'Customer Correction',
  customer_reassignment: 'Customer Handover',
  subscription: 'Investment',
  premature_redemption: 'Premature Redemption',
  redemption: 'Redemption',
  rollover: 'Rollover',
  ncd_transfer: 'Holder Transfer',
  ncd_transformation: 'Transformation',
  agent_registration: 'Agent Registration',
  activation_batch: 'Activation',
  allotment_batch: 'Allotment',
  user_verification: 'User Verification',
  app_investment: 'App investment (live)',
  commission_eligibility: 'Agent Commission',
  interest_batch: 'Interest Payout',
  payout_adjustment: 'Payout Adjustment',
};

export function approvalTypeLabel(t: string): string {
  return APPROVAL_TYPE_LABELS[t] ?? humanize(t);
}
