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
  group: 'Identity' | 'Contact' | 'Address' | 'Tax & category';
  options?: string[];
  /** Force-uppercase as the user types (PAN, CKYC). */
  uppercase?: boolean;
  maxLength?: number;
  hint?: string;
}

/**
 * Everything a maker-checker correction may change on an existing customer.
 *
 * Deliberately excluded:
 *  - identifiers/state the workflow owns: customer_code, kyc_status,
 *    creation_status, is_active, is_deceased, archived_*, branch/enroller ids;
 *  - the full `aadhaar` column — only the last 4 are ever shown or edited
 *    (Aadhaar Act §29; the LockerHub contract says raw Aadhaar is never returned);
 *  - demat, nominees and joint holders — those have their own endpoints and
 *    edit controls on the customer page.
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
