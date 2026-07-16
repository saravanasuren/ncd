/**
 * Settings registry catalog (docs/07). The single source of truth for every
 * configurable business value. Defaults mirror production / owner-confirmed
 * rules. The DB `app_settings` table is seeded from this and is the only
 * place these values live at runtime — NO hardcoded business values in code.
 */

export type SettingType = 'number' | 'string' | 'boolean' | 'rate' | 'enum' | 'list' | 'json' | 'date';
export type EditableBy = 'admin' | 'workflow' | 'super_admin';

/** Flat-or-percent rate value used across incentives/penalties (docs/07 §2). */
export interface RateValue {
  mode: 'pct' | 'flat';
  value: number;
}

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  description: string;
  type: SettingType;
  default: unknown;
  editableBy: EditableBy;
  options?: string[]; // for enum
}

export const SETTINGS_CATALOG: SettingDef[] = [
  // ── Interest engine (owner-confirmed 2026-07-16) ──
  {
    key: 'interest.payout_day_of_month',
    group: 'Interest',
    label: 'Interest payout day',
    description: 'Day of month interest is paid (holiday-adjusted backward).',
    type: 'number',
    default: 28,
    editableBy: 'workflow',
  },
  {
    key: 'interest.day_count_convention',
    group: 'Interest',
    label: 'Day-count convention',
    description: 'Actual365 = actual days ÷ 365 every period (29th→28th).',
    type: 'enum',
    options: ['Actual365', 'Thirty360', 'Actual360', 'ActualActual'],
    default: 'Actual365',
    editableBy: 'workflow',
  },
  {
    key: 'interest.cutover_from',
    group: 'Interest',
    label: 'New-convention cutover date',
    description: 'From this date all investments use the new rule; earlier paid interest is frozen.',
    type: 'date',
    default: '2026-07-01',
    editableBy: 'super_admin',
  },

  // ── Incentives (4-cell matrix, flat-or-pct) ──
  {
    key: 'incentive.staff_new_no_referrer',
    group: 'Incentives',
    label: 'Staff % — new customer, no referrer',
    description: 'Enroller incentive when the customer is brand-new and no referrer is named.',
    type: 'rate',
    default: { mode: 'pct', value: 2.0 } as RateValue,
    editableBy: 'workflow',
  },
  {
    key: 'incentive.staff_existing_with_referrer',
    group: 'Incentives',
    label: 'Staff % — existing customer, with referrer',
    description: 'Enroller incentive when the customer already existed and a referrer is named.',
    type: 'rate',
    default: { mode: 'pct', value: 0.25 } as RateValue,
    editableBy: 'workflow',
  },
  {
    key: 'incentive.referrer_new_with_referrer_staff',
    group: 'Incentives',
    label: 'Staff % — new customer, with referrer',
    description: 'Enroller incentive when the customer is new and a referrer is named (usually 0).',
    type: 'rate',
    default: { mode: 'pct', value: 0 } as RateValue,
    editableBy: 'workflow',
  },
  {
    key: 'incentive.referrer_new_with_referrer',
    group: 'Incentives',
    label: 'Referrer % — new customer, with referrer',
    description: 'Referrer incentive when they bring a brand-new customer.',
    type: 'rate',
    default: { mode: 'pct', value: 2.0 } as RateValue,
    editableBy: 'workflow',
  },
  {
    key: 'incentive.agent_commission_cap_pct',
    group: 'Incentives',
    label: 'Agent commission cap %',
    description: 'Maximum approvable agent commission rate.',
    type: 'number',
    default: 2.0,
    editableBy: 'admin',
  },

  // ── Redemptions ──
  {
    key: 'redemption.premature_penalty',
    group: 'Redemptions',
    label: 'Premature redemption penalty',
    description: 'Penalty on premature withdrawal (flat ₹ or % of principal). Net = Principal − Penalty.',
    type: 'rate',
    default: { mode: 'pct', value: 1.0 } as RateValue,
    editableBy: 'workflow',
  },

  // ── Numbering ──
  {
    key: 'numbering.customer_format',
    group: 'Numbering',
    label: 'Customer code format',
    description: 'Tokens: {seq:N}, {yyyy}.',
    type: 'string',
    default: 'DHN{seq:6}',
    editableBy: 'super_admin',
  },
  {
    key: 'numbering.application_format',
    group: 'Numbering',
    label: 'Application no. format',
    description: 'Tokens: {seq:N}, {yyyy}.',
    type: 'string',
    default: 'APP-{yyyy}-{seq:6}',
    editableBy: 'super_admin',
  },

  // ── Customers ──
  {
    key: 'customers.max_joint_holders',
    group: 'Customers',
    label: 'Max joint holders',
    description: 'Maximum joint holders per customer.',
    type: 'number',
    default: 2,
    editableBy: 'admin',
  },
  {
    key: 'customers.lead_sources',
    group: 'Customers',
    label: 'Lead sources',
    description: 'Selectable lead source values.',
    type: 'list',
    default: ['Social Media', 'Walk-IN', 'Agent', 'DhanamFin App', 'Others'],
    editableBy: 'admin',
  },
  {
    key: 'customers.lead_statuses',
    group: 'Customers',
    label: 'Lead statuses',
    description: 'Lead pipeline statuses.',
    type: 'list',
    default: ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Lost'],
    editableBy: 'admin',
  },
  {
    key: 'customers.collection_methods',
    group: 'Customers',
    label: 'Collection methods',
    description: 'Accepted money-collection methods.',
    type: 'list',
    default: ['NEFT', 'IMPS', 'RTGS', 'Cheque', 'Cash', 'Other'],
    editableBy: 'admin',
  },

  // ── Portal ──
  {
    key: 'portal.statement_display_cutoff',
    group: 'Portal',
    label: 'Statement display cutoff',
    description: 'Customer-facing lists show rows on/after this date; aggregates stay full.',
    type: 'date',
    default: '2026-06-19',
    editableBy: 'admin',
  },
  {
    key: 'portal.otp_ttl_minutes',
    group: 'Portal',
    label: 'OTP validity (minutes)',
    description: 'How long a portal OTP stays valid.',
    type: 'number',
    default: 10,
    editableBy: 'admin',
  },

  // ── Approvals ──
  {
    key: 'approvals.premature_l2_role',
    group: 'Approvals',
    label: 'Premature redemption L2 approver',
    description: 'Role that approves premature redemptions at level 2 (owner: CXO).',
    type: 'enum',
    options: ['cxo', 'admin'],
    default: 'cxo',
    editableBy: 'super_admin',
  },

  // ── System ──
  {
    key: 'system.api_page_limit_max',
    group: 'System',
    label: 'Max page size',
    description: 'Upper bound on list page size.',
    type: 'number',
    default: 500,
    editableBy: 'admin',
  },
];

export function settingDefaults(): Record<string, unknown> {
  return Object.fromEntries(SETTINGS_CATALOG.map((s) => [s.key, s.default]));
}
