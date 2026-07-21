/**
 * Pincode → state / city / district lookup. Uses India Post's public API
 * (https://api.postalpincode.in) — no credentials, the standard free source.
 * Same shape/behaviour as the IFSC lookup: returns null on an invalid/unknown
 * PIN, a non-OK response, a timeout or any error, so the caller falls back to
 * manual entry rather than blocking the user.
 */
export interface PincodeInfo {
  pincode: string;
  state: string;
  district: string;
  city: string; // best-effort (District is the closest India Post gives)
}

const PIN_RE = /^[1-9][0-9]{5}$/;
type Fetcher = typeof fetch;

/** Normalise + validate a 6-digit Indian PIN without any network call. */
export function normalisePincode(raw: string): string | null {
  const pin = String(raw ?? '').replace(/\D/g, '');
  return PIN_RE.test(pin) ? pin : null;
}

export async function lookupPincode(raw: string, doFetch: Fetcher = fetch): Promise<PincodeInfo | null> {
  const pin = normalisePincode(raw);
  if (!pin) return null;
  try {
    const res = await doFetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const first = Array.isArray(body) ? body[0] : null;
    if (!first || first.Status !== 'Success') return null;
    const offices = first.PostOffice as Array<Record<string, unknown>> | undefined;
    const po = offices?.[0];
    if (!po) return null;
    const state = String(po.State ?? '');
    const district = String(po.District ?? '');
    if (!state) return null;
    return { pincode: pin, state, district, city: district };
  } catch {
    return null;
  }
}
