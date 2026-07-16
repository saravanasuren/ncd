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
  allotment_batch: {
    type: 'allotment_batch',
    label: 'Batch Allotment',
    levels: [{ level: 1, checkerPermission: check, label: 'Admin' }],
  },
  premature_redemption: {
    type: 'premature_redemption',
    label: 'Premature Redemption',
    levels: [
      { level: 1, checkerPermission: check, label: 'NCD Manager' },
      { level: 2, checkerPermission: checkPremature, label: 'CXO' },
    ],
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
    levels: [{ level: 1, checkerPermission: check, label: 'NCD Manager / Admin' }],
  },
  agent_registration: {
    type: 'agent_registration',
    label: 'Agent Registration',
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
