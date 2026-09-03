/**
 * Customer profile vocabulary shared by the web UI and the API.
 *
 * ONE definition, both sides. The correction form used to be a hand-written
 * list of five inputs while the server applied its own private allow-list —
 * they drifted, and `pan` ended up offered in the UI but silently dropped on
 * approval (a correction that looked applied but wasn't). Rendering the form
 * and the apply-time allow-list from the same array makes that class of bug
 * structurally impossible.
 */

export type CustomerFieldKind = 'text' | 'email' | 'date' | 'select' | 'boolean';

export interface CustomerField {
  key: string;
  label: string;
  kind: CustomerFieldKind;
  group: 'Identity' | 'Contact' | 'Address' | 'Tax & category' | 'Referral' | 'Demat';
  options?: string[];
  /** Force-uppercase as the user types (PAN, CKYC). */
  uppercase?: boolean;
  maxLength?: number;
  hint?: string;
  /**
   * Format the value must match when non-empty, as a regex SOURCE string (the
   * shared package is consumed by both sides; a source string survives JSON and
   * builds a RegExp wherever it is needed).
   *
   * Checked when the correction is SUBMITTED, not at apply time — a maker who
   * types a malformed DP ID must be told immediately, rather than having a
   * checker approve something that then fails or, worse, saves rubbish.
   */
  pattern?: string;
  /** Shown when `pattern` fails. Says the shape, not "invalid". */
  patternHint?: string;
}

/**
 * Everything a maker-checker correction may change on an existing customer.
 *
 * Deliberately excluded:
 *  - identifiers/state the workflow owns: customer_code, kyc_status,
 *    creation_status, is_active, is_deceased, archived_*, branch/enroller ids;
 *  - the full `aadhaar` column — only the last 4 are ever shown or edited
 *    (Aadhaar Act §29; the LockerHub contract says raw Aadhaar is never returned);
 *  - nominees and joint holders — ROWS in their own tables rather than columns
 *    here, so they cannot be expressed as a column diff. They go through
 *    approval by their own route (customer_nominees).
 *
 * Demat WAS excluded for the same "it has its own endpoint" reason, until the
 * owner asked (2026-08-19) for demat changes to go through approval like
 * everything else on the profile. It is three plain columns, so it simply
 * joins the list.
 */
export const CORRECTABLE_CUSTOMER_FIELDS: CustomerField[] = [
  // Identity
  { key: 'full_name', label: 'Full name', kind: 'text', group: 'Identity' },
  { key: 'father_name', label: "Father's name", kind: 'text', group: 'Identity' },
  { key: 'dob', label: 'Date of birth', kind: 'date', group: 'Identity' },
  { key: 'gender', label: 'Gender', kind: 'select', group: 'Identity', options: ['Male', 'Female', 'Other'] },
  { key: 'pan', label: 'PAN', kind: 'text', group: 'Identity', uppercase: true, maxLength: 10 },
  { key: 'aadhaar_last4', label: 'Aadhaar (last 4)', kind: 'text', group: 'Identity', maxLength: 4, hint: 'Last 4 digits only' },
  { key: 'ckyc_number', label: 'CKYC number', kind: 'text', group: 'Identity', uppercase: true },
  { key: 'occupation', label: 'Occupation', kind: 'text', group: 'Identity' },

  // Contact
  { key: 'phone', label: 'Phone', kind: 'text', group: 'Contact', maxLength: 10 },
  { key: 'phone_secondary', label: 'Alternate phone', kind: 'text', group: 'Contact', maxLength: 10 },
  { key: 'email', label: 'Email', kind: 'email', group: 'Contact' },

  // Address
  { key: 'address', label: 'Address', kind: 'text', group: 'Address' },
  { key: 'city', label: 'City', kind: 'text', group: 'Address' },
  { key: 'district', label: 'District', kind: 'text', group: 'Address' },
  { key: 'state', label: 'State', kind: 'text', group: 'Address' },
  { key: 'pincode', label: 'PIN code', kind: 'text', group: 'Address', maxLength: 6 },

  // Tax & category
  { key: 'investor_category', label: 'Investor category', kind: 'text', group: 'Tax & category' },
  { key: 'is_nri', label: 'NRI', kind: 'boolean', group: 'Tax & category' },
  { key: 'tds_applicable', label: 'TDS applicable', kind: 'boolean', group: 'Tax & category' },

  // Referral — lets staff add or fix the "Referred by" that was missed at
  // enrolment; it goes through the same correction→approval flow as every other
  // field. (Only future investments' attribution reads it; past accruals keep
  // whatever was stamped on their application at the time.)
  { key: 'referred_by_text', label: 'Referred by (code or name)', kind: 'text', group: 'Referral' },

  // Demat (owner 2026-08-19) — where the customer's securities are held. Same
  // shape rule the direct endpoint enforced (shared DP_ID_RE): two letters plus
  // six digits for NSDL, or eight digits for CDSL.
  { key: 'demat_dp_id', label: 'DP ID', kind: 'text', group: 'Demat', uppercase: true, maxLength: 8,
    pattern: '^([A-Z]{2}[0-9]{6}|[0-9]{8})$',
    patternHint: 'DP ID must be 8 characters — two letters + six digits (e.g. IN300456) or eight digits (CDSL)' },
  { key: 'demat_client_id', label: 'Client ID', kind: 'text', group: 'Demat', uppercase: true },
  { key: 'depository', label: 'Depository', kind: 'select', group: 'Demat', options: ['NSDL', 'CDSL'] },
];

export const CORRECTABLE_CUSTOMER_KEYS: string[] = CORRECTABLE_CUSTOMER_FIELDS.map((f) => f.key);

const FIELD_BY_KEY = new Map(CORRECTABLE_CUSTOMER_FIELDS.map((f) => [f.key, f]));

export function isCorrectableCustomerField(key: string): boolean {
  return FIELD_BY_KEY.has(key);
}

/**
 * Normalise a submitted correction value for its column: '' → NULL (so a
 * cleared field actually clears), booleans coerced, PAN/CKYC upper-cased.
 * Unknown keys return undefined — the caller skips them.
 */
/**
 * Why a submitted correction value is unacceptable, or null when it is fine.
 * Empty clears the field, so it is always allowed — a customer may genuinely
 * have no demat account.
 */
export function customerFieldError(key: string, value: unknown): string | null {
  const field = FIELD_BY_KEY.get(key);
  if (!field?.pattern) return null;
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const v = field.uppercase ? s.toUpperCase() : s;
  return new RegExp(field.pattern).test(v) ? null : (field.patternHint ?? `${field.label} is not in the expected format`);
}

export function normaliseCustomerFieldValue(key: string, value: unknown): unknown | undefined {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return undefined;
  if (field.kind === 'boolean') return value === true || value === 'true';
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  return field.uppercase ? s.toUpperCase() : s;
}

/**
 * KYC document types. Keys are the stored `customer_documents.doc_type` and
 * MUST stay in step with the enrolment wizard's DocKey union and the
 * background-verification mapping (api/src/modules/bgv/service.ts), which
 * looks for `customer_photo`, `pan_card`, etc. by exactly these names.
 */
export const KYC_DOCUMENT_TYPES: { key: string; label: string }[] = [
  { key: 'pan_card', label: 'PAN card' },
  { key: 'aadhaar_card', label: 'Aadhaar card' },
  { key: 'customer_photo', label: 'Customer photo' },
  { key: 'customer_signature', label: 'Customer signature' },
  { key: 'address_proof', label: 'Address proof' },
  { key: 'bank_proof', label: 'Cheque / passbook image' },
  { key: 'cml', label: 'CML (demat master)' },
  { key: 'nominee_kyc', label: 'Nominee KYC' },
  { key: 'other', label: 'Other' },
];

/**
 * Relationships offered for a nominee. Shared so the enrolment wizard and the
 * customer profile offer the same list — they drifted apart when the profile
 * had no relationship field at all, and nominees added there landed with a null
 * relationship (two on 2026-09-03 alone).
 *
 * Free text already on record that is not in this list still displays; the
 * pickers keep it as an extra option rather than silently blanking it.
 */
export const NOMINEE_RELATIONSHIPS: string[] = [
  'Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other',
];

/** One nominee, in the shape `PUT /api/customers/:id/nominees` accepts. */
export interface NomineeInput {
  full_name: string;
  relationship?: string | null;
  share_pct?: number;
  dob?: string | null;
  pan?: string | null;
  phone?: string | null;
  address?: string | null;
  guardian_name?: string | null;
  guardian_pan?: string | null;
  kyc_id_type?: string | null;
  kyc_id_number?: string | null;
}

/**
 * A stored nominee row, in the shape the endpoint wants it back.
 *
 * That endpoint REPLACES a customer's whole nominee set, so any field left out
 * of this is deleted. The customer page used to send back nothing but name,
 * relationship and share, which silently wiped the DOB, PAN, phone, address,
 * guardian and KYC id — all captured by the enrolment wizard — off every
 * nominee each time another was added. 171 nominees on the book carry a DOB and
 * 67 a KYC id, so the loss was real rather than theoretical.
 *
 * Anything that resends a nominee it did not itself collect in full must go
 * through here.
 */
export function nomineeToInput(n: Record<string, unknown>): NomineeInput {
  const text = (v: unknown) => { const t = String(v ?? '').trim(); return t === '' ? null : t; };
  const share = Number(n.share_pct);
  return {
    full_name: String(n.full_name ?? '').trim(),
    relationship: text(n.relationship),
    // Omitted, not zero: a missing share reads server-side as "split the rest",
    // where a 0 would be an explicit "this nominee gets nothing".
    ...(share > 0 ? { share_pct: share } : {}),
    // DATE arrives as 'YYYY-MM-DD' already; the slice guards a caller that hands
    // over a full timestamp.
    dob: n.dob ? String(n.dob).slice(0, 10) : null,
    pan: text(n.pan), phone: text(n.phone), address: text(n.address),
    guardian_name: text(n.guardian_name), guardian_pan: text(n.guardian_pan),
    kyc_id_type: text(n.kyc_id_type), kyc_id_number: text(n.kyc_id_number),
  };
}
