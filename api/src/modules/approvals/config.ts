/**
 * Approval chain configuration (docs/03 §4). Each request type maps to an
 * ordered list of levels; each level names the permission a checker must
 * hold. Defaults mirror the owner-confirmed matrix. (Later these can be
 * overridden from settings; the shape is settings-ready.)
 */
import type { Permission } from '@new-wealth/shared';

export interface ChainLevel {
  level: number;
  checkerPermission: Permission;
  label: string;
}

export interface ApprovalTypeDef {
  type: string;
  label: string;
  levels: ChainLevel[];
}

const check: Permission = 'approvals:check';
const checkPremature: Permission = 'approvals:check-premature';

export const APPROVAL_TYPES: Record<string, ApprovalTypeDef> = {
  subscription: {
    type: 'subscription',
    label: 'Investment approval',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // App/LockerHub investment that already went live for the customer — this is a
  // notice, not a gate. It surfaces on the Approvals page so the admin knows app
  // money landed and can assign a staff/agent when the referral code is missing.
  // "Approving" it just acknowledges/clears the notice (no side-effect handler).
  app_investment: {
    type: 'app_investment',
    label: 'App investment (live)',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  allotment_batch: {
    type: 'allotment_batch',
    label: 'Batch Allotment',
    levels: [{ level: 1, checkerPermission: check, label: 'Admin' }],
  },
  interest_batch: {
    type: 'interest_batch',
    label: 'Interest NEFT Batch',
    levels: [{ level: 1, checkerPermission: check, label: 'Admin' }],
  },
  // Old-app parity: maker → single CXO checker (not a 2-checker chain).
  premature_redemption: {
    type: 'premature_redemption',
    label: 'Premature Redemption',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'CXO' }],
  },
  // Maturity redemption — maker → single checker (old-app parity).
  redemption: {
    type: 'redemption',
    label: 'Maturity Redemption',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // A new series cannot take investments until a checker approves it, and an
  // edit to a live one needs the same second pair of eyes (owner 2026-08-19) —
  // its deemed date and face value are printed on documents and feed interest.
  series_creation: {
    type: 'series_creation',
    label: 'New Series',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  series_change: {
    type: 'series_change',
    label: 'Series Change',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  customer_creation: {
    type: 'customer_creation',
    label: 'New Customer',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  customer_correction: {
    type: 'customer_correction',
    label: 'Customer Correction',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // Owner 2026-08-19: a nominee change goes through approval like any other
  // profile change. Its own type rather than customer_correction because
  // nominees are ROWS in their own table — the correction applier writes a
  // column diff and cannot express "replace this customer's nominee set".
  customer_nominees: {
    type: 'customer_nominees',
    label: 'Nominee Change',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  customer_reassignment: {
    type: 'customer_reassignment',
    label: 'Customer Handover',
    // Owner 2026-07-18: any ONE of Admin / CXO / Branch Manager approves.
    levels: [{ level: 1, checkerPermission: 'approvals:check-handover', label: 'Admin / CXO / Branch Manager' }],
  },
  agent_registration: {
    type: 'agent_registration',
    label: 'Agent Registration',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // Self-signup review — Admin or CXO verifies the new staff/agent.
  user_verification: {
    type: 'user_verification',
    label: 'User Verification',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  rollover: {
    type: 'rollover',
    label: 'NCD Rollover',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // Old-app parity: single checker (maker → checker), not a 2-checker chain.
  ncd_transfer: {
    type: 'ncd_transfer',
    label: 'NCD Transfer',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  ncd_transformation: {
    type: 'ncd_transformation',
    label: 'NCD Transformation (Nominee)',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  commission_eligibility: {
    type: 'commission_eligibility',
    label: 'Agent Commission Eligibility',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  // Correcting an investment's money-received / interest-start date — it rebuilds
  // the schedule and shifts the first period, so it is maker/checker (owner
  // 2026-08-27). Maker: NCD Manager+. Checker: Admin/CXO.
  investment_date_change: {
    type: 'investment_date_change',
    label: 'Investment Date Change',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // Correcting ONE credit's date on a clubbed investment. Exactly the same kind
  // of change as investment_date_change above — it rebuilds the schedule and
  // shifts that credit's first period — so it carries the same maker/checker
  // (owner 2026-08-27). A separate type only because it names a single credit
  // rather than the whole investment.
  credit_date_change: {
    type: 'credit_date_change',
    label: 'Credit Date Change',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // One-time addition/deduction on an investment's next interest payout.
  // Maker: NCD Manager+ (payouts:adjust). Checker: Admin/CXO (owner 2026-07-23).
  payout_adjustment: {
    type: 'payout_adjustment',
    label: 'Payout Adjustment',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // A locker tenancy holding with NO NCD backing, by deliberate exception.
  // Maker: NCD Manager+ (lockers:waive). Checker: Admin/CXO (owner 2026-07-24).
  locker_deposit_waiver: {
    type: 'locker_deposit_waiver',
    label: 'Locker Deposit Waiver',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // Waiving rent/deposit OWED on an application — real money, unlike the
  // informational deposit waiver above. LockerHub applies it approved-on-
  // arrival, so this checker IS the control.
  locker_fee_waiver: {
    type: 'locker_fee_waiver',
    label: 'Locker Fee Waiver',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // A locker cheque cleared the bank — a maker marks it, a checker confirms, and
  // only then does the leg settle on LockerHub. Real money against paper that
  // could have bounced, so the checker is the control: Admin / CXO.
  locker_cheque_clearance: {
    type: 'locker_cheque_clearance',
    label: 'Locker Cheque Clearance',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  locker_offline_payment: {
    type: 'locker_offline_payment',
    label: 'Locker Rent Payment',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // Clubbing a new credit into an ALREADY-LIVE investment is real money added to
  // an approved NCD — it inflates the principal and rebuilds the live interest
  // schedule. Same Admin/CXO gate as other post-go-live money events (owner
  // 2026-08-24). The maker records the tranche; the checker takes it live.
  club_into_active: {
    type: 'club_into_active',
    label: 'Club into Active Investment',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
  // Customer crossed the ₹30L outstanding threshold → becomes TDS-applicable and
  // TDS on already-paid interest is recovered once. Tax control → Admin/CXO.
  tds_threshold: {
    type: 'tds_threshold',
    label: 'TDS Applicability (₹30L crossed)',
    levels: [{ level: 1, checkerPermission: checkPremature, label: 'Admin / CXO' }],
  },
};

export function typeDef(type: string): ApprovalTypeDef {
  return (
    APPROVAL_TYPES[type] ?? {
      type,
      label: type,
      levels: [{ level: 1, checkerPermission: check, label: 'Checker' }],
    }
  );
}
