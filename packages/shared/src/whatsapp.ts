/**
 * WhatsApp template configuration (owner 2026-08-25). WhatsApp Business templates
 * are approved by Meta inside WappCloud — this app only references one BY NAME and
 * fills its {{n}} body variables. So what is configurable from our UI is: which
 * approved template each message uses, whether the message type is on, and which
 * data field feeds each {{n}} — NOT the message wording (that lives in WappCloud).
 *
 * This registry is the single source of truth for the message types and the data
 * fields each one can offer as variables. The per-type config (name / enabled /
 * variable order) is stored in app_settings under `whatsapp.tpl.<type>` and the
 * send path reads it; a blank name falls back to the env default then the hardcoded
 * one, so a missing setting never stops a send.
 */

export interface WhatsappField {
  key: string;    // payload key produced at enqueue time
  label: string;  // human label for the mapping UI
}

export interface WhatsappTypeDef {
  type: string;                 // internal message type — matches the queue `template`
  label: string;
  fields: WhatsappField[];      // data fields available to map onto {{1}},{{2}}…
  hasDocument?: boolean;        // carries a PDF header (acknowledgement) rather than only body vars
  defaultTemplateName: string;  // the current approved template name
  defaultVariables: string[];   // ordered field keys → {{1}},{{2}}… (must be a subset of `fields`)
  defaultEnabled: boolean;
}

export interface WhatsappTypeConfig {
  template_name: string;   // approved WappCloud template name (blank = fall back to env/default)
  enabled: boolean;        // off = this message type is not sent
  variables: string[];     // ordered field keys, one per {{n}}
}

export const WHATSAPP_TYPES: WhatsappTypeDef[] = [
  {
    type: 'acknowledgment',
    label: 'Investment acknowledgement',
    hasDocument: true,
    fields: [{ key: 'name', label: 'Customer name' }],
    defaultTemplateName: 'ncd_akn',
    defaultVariables: ['name'],
    defaultEnabled: true,
  },
  {
    type: 'interest_paid',
    label: 'Interest credited',
    fields: [
      { key: 'name', label: 'Customer name' },
      { key: 'amount', label: 'Interest amount' },
      { key: 'month', label: 'Month' },
      { key: 'date', label: 'Credit date' },
      { key: 'application_no', label: 'Application no.' },
    ],
    defaultTemplateName: 'ncd_interest_final',
    defaultVariables: ['name', 'amount', 'month', 'date'],
    defaultEnabled: true,
  },
  {
    type: 'portal_otp',
    label: 'Login OTP',
    fields: [{ key: 'otp', label: 'OTP code' }],
    defaultTemplateName: '',
    defaultVariables: ['otp'],
    defaultEnabled: true,
  },
  {
    type: 'locker_booked',
    label: 'Locker booked',
    fields: [
      { key: 'name', label: 'Customer name' },
      { key: 'locker_no', label: 'Locker no.' },
      { key: 'branch', label: 'Branch' },
    ],
    defaultTemplateName: '',
    defaultVariables: ['name', 'locker_no', 'branch'],
    defaultEnabled: false,   // inert until an approved template name is set
  },
];

export const WHATSAPP_SETTING_PREFIX = 'whatsapp.tpl.';
export const whatsappSettingKey = (type: string) => `${WHATSAPP_SETTING_PREFIX}${type}`;

export function defaultWhatsappConfig(def: WhatsappTypeDef): WhatsappTypeConfig {
  return { template_name: def.defaultTemplateName, enabled: def.defaultEnabled, variables: [...def.defaultVariables] };
}

/** Placeholder values used to fill {{n}} on a "send test" (owner 2026-08-25).
 *  Falls back to the field label so a test always shows SOMETHING in each slot. */
export const WHATSAPP_SAMPLE: Record<string, string> = {
  name: 'Test Customer',
  amount: '1,234',
  month: 'August',
  date: '25-Aug-2026',
  application_no: 'APP-2026-000000',
  otp: '123456',
  locker_no: 'A-101',
  branch: 'Coimbatore',
};
export function sampleWhatsappPayload(def: WhatsappTypeDef): Record<string, string> {
  const p: Record<string, string> = {};
  for (const f of def.fields) p[f.key] = WHATSAPP_SAMPLE[f.key] ?? f.label;
  return p;
}

/** Validate a stored per-type config against its registry entry (used on save). */
export function validateWhatsappConfig(def: WhatsappTypeDef, cfg: unknown): string | null {
  const c = cfg as Partial<WhatsappTypeConfig> | null;
  if (!c || typeof c !== 'object') return 'Expected a WhatsApp template config object';
  if (typeof c.template_name !== 'string') return 'template_name must be a string';
  if (typeof c.enabled !== 'boolean') return 'enabled must be a boolean';
  if (!Array.isArray(c.variables)) return 'variables must be a list of field keys';
  const known = new Set(def.fields.map((f) => f.key));
  for (const v of c.variables) {
    if (typeof v !== 'string' || !known.has(v)) return `Unknown variable field "${String(v)}" for ${def.label}`;
  }
  return null;
}
