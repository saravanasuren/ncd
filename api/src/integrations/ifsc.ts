/**
 * IFSC → bank / branch lookup. Uses the public Razorpay IFSC directory
 * (https://ifsc.razorpay.com) — no credentials, the de-facto source for Indian
 * branch data. This is a directory lookup, NOT account verification; penny-drop
 * (kycProvider) stays separate.
 *
 * Returns null on an invalid/unknown IFSC, a non-OK response, a timeout or any
 * error — the caller falls back to manual entry rather than blocking the user.
 */
export interface IfscInfo {
  ifsc: string;
  bank: string;
  branch: string;
  city: string;
  state: string;
  district: string | null;
  address: string | null;
}

import { config } from '../config.js';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
type Fetcher = typeof fetch;

/** Normalise + validate an IFSC without any network call. */
export function normaliseIfsc(raw: string): string | null {
  const code = String(raw ?? '').toUpperCase().trim();
  return IFSC_RE.test(code) ? code : null;
}

export async function lookupIfsc(raw: string, doFetch: Fetcher = fetch): Promise<IfscInfo | null> {
  const code = normaliseIfsc(raw);
  if (!code) return null;
  try {
    const res = await doFetch(`https://ifsc.razorpay.com/${code}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d || !d.BANK) return null;
    return {
      ifsc: code,
      bank: String(d.BANK),
      branch: String(d.BRANCH ?? ''),
      city: String(d.CITY ?? d.CENTRE ?? ''),
      state: String(d.STATE ?? ''),
      district: d.DISTRICT ? String(d.DISTRICT) : null,
      address: d.ADDRESS ? String(d.ADDRESS) : null,
    };
  } catch {
    return null;
  }
}

/** The bank/branch fields an account row carries, as far as this module cares. */
export interface BankBranchFields {
  bank_name?: string | null;
  branch_name?: string | null;
  branch_city?: string | null;
}

/**
 * Fill bank/branch from the IFSC directory, for the fields that are EMPTY.
 *
 * Both consoles already look the IFSC up in the BROWSER and post the result —
 * but only if that lookup finished first. It is a 400 ms debounce plus a call to
 * an external directory, so staff who type the IFSC and save quickly send
 * nothing, the account is accepted without a bank or branch, and nothing ever
 * fills them in again. 74 accounts were saved that way (17 in Sep 2026 alone),
 * and the printed application form shows the two fields blank.
 *
 * The server holds the IFSC, so it can answer the question itself rather than
 * depending on the browser having won a race. A value the caller DID supply
 * always wins — staff correcting a wrong directory entry must not be overruled.
 *
 * Never throws and never blocks: lookupIfsc already returns null on a bad code,
 * a non-OK response, a timeout or any error, and then this returns the input
 * untouched. Saving a bank account must not depend on a third-party directory
 * being up. Call it OUTSIDE a transaction — it makes a network request.
 *
 * Inert under NODE_ENV=test unless a fetcher is injected: 51 test files add a
 * bank account, and on a runner with no egress each one would sit through the
 * 5s timeout. Tests that care about the filling pass their own `doFetch`.
 */
export async function fillBankBranchFromIfsc<T extends BankBranchFields>(
  ifsc: string, fields: T, doFetch?: Fetcher,
): Promise<T> {
  if (!doFetch && config.NODE_ENV === 'test') return fields;
  const fetcher = doFetch ?? fetch;
  const has = (v: unknown) => String(v ?? '').trim() !== '';
  if (has(fields.bank_name) && has(fields.branch_name) && has(fields.branch_city)) return fields;
  const info = await lookupIfsc(ifsc, fetcher);
  if (!info) return fields;
  return {
    ...fields,
    bank_name: has(fields.bank_name) ? fields.bank_name : (info.bank || null),
    branch_name: has(fields.branch_name) ? fields.branch_name : (info.branch || null),
    branch_city: has(fields.branch_city) ? fields.branch_city : (info.city || null),
  };
}
