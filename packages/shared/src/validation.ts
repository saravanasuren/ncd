/**
 * Identity-field validation shared by the web wizard and the API, so both
 * sides enforce the SAME rules (client for immediate feedback, server so the
 * rules can't be bypassed).
 */

/** Standard PAN: 5 uppercase letters, 4 digits, 1 uppercase letter. */
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Names / occupation / city / district / state: letters and spaces only. */
export const ALPHA_SPACE_RE = /^[A-Za-z ]+$/;

export const isAlphaSpace = (v: string): boolean => ALPHA_SPACE_RE.test(v);

/** Type-time guard for alpha-space fields — drops anything else as it's typed. */
export const sanitizeAlphaSpace = (v: string): string => v.replace(/[^A-Za-z ]/g, '');

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
