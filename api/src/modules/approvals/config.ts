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
    label: 'Application / Subscription',
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  activation_batch: {
    type: 'activation_batch',
    label: 'Batch Activation',
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
