/**
 * Identity-field validation shared by the web wizard and the API, so both
 * sides enforce the SAME rules (client for immediate feedback, server so the
 * rules can't be bypassed).
 */

/** Standard PAN: 5 uppercase letters, 4 digits, 1 uppercase letter. */
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Occupation / city / district / state: letters plus the punctuation real
 * place names carry, but never digits.
 *
 * Letters-and-spaces-only was too tight for the live book — it rejected
 * Paramathi-velur, V.Sathiram Periyavalasu, Surampatti - PO, Kambam(m),
 * Thindal (Kel) Erode and Krishnagiri. while catching nothing extra: every
 * junk value in the data ("1233344", "45678gda") contains a digit, which is
 * still refused.
 */
export const ALPHA_SPACE_RE = /^[A-Za-z][A-Za-z .'()-]*$/;

export const isAlphaSpace = (v: string): boolean => ALPHA_SPACE_RE.test(v);

/** Type-time guard for these fields — drops anything else as it's typed. */
export const sanitizeAlphaSpace = (v: string): string => v.replace(/[^A-Za-z .'()-]/g, '');

/**
 * Names: no digits, but everything real names carry — dotted initials
 * ("K. Pallavi", the local convention), apostrophes ("D'Souza"), hyphens
 * ("Mary-Anne"), and the ampersand and brackets a NON-INDIVIDUAL customer
 * needs: the book holds "KSPV & CO", "M Pragadeeshkanna (HUF)" and
 * "P A Sports Academy (Madhukshara Rajendran)", and HUF/Trust/Company are
 * first-class investor categories. Must start with a letter.
 *
 * Digits stay refused, which is what actually catches the junk in the data
 * ("9443132741", "993179", "DHN1134").
 */
export const NAME_RE = /^[A-Za-z][A-Za-z .'()&-]*$/;

/** Type-time guard for name fields — drops anything the name rule disallows. */
export const sanitizeName = (v: string): string => v.replace(/[^A-Za-z .'()&-]/g, '');

/**
 * Demat DP ID — exactly 8 characters, in one of the two depository forms:
 * NSDL letter-form (2 uppercase letters + 6 digits, e.g. IN300456) or CDSL
 * numeric-form (8 digits). A letters-only rule would make CDSL accounts
 * un-enterable, so both are accepted.
 */
export const DP_ID_RE = /^([A-Z]{2}[0-9]{6}|[0-9]{8})$/;

/** IFSC: 4 uppercase letters, a literal 0, then 6 alphanumerics (SBIN0001234). */
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Bank account number: digits only (leading zeros are meaningful), min 4. */
export const ACCOUNT_NUMBER_RE = /^[0-9]{4,}$/;

/**
 * Parse a DD/MM/YYYY string to ISO (YYYY-MM-DD). Returns null unless the
 * input is exactly that format AND a real calendar date (rejects 31/02/2024).
 */
export function ddmmyyyyToISO(v: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd), month = Number(mm), year = Number(yyyy);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO (YYYY-MM-DD) → DD/MM/YYYY for display; anything else returned as-is. */
export function isoToDDMMYYYY(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}
