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
