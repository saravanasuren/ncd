/**
 * Outbound LockerHub client (NCD_INTEGRATION_CONTRACT.md Part A). NCD staff
 * enroll a customer for a LOCKER by calling LockerHub server-to-server:
 *
 *   Base:   LOCKERHUB_API_URL   (…/api/integration/v1)
 *   Auth:   header X-Integration-Key on every call
 *   Staff:  every MUTATING call carries { staff: { id, name, email } } — the
 *           acting NCD user, injected by the orchestration layer (never trusted
 *           from the browser).
 *
 * INERT unless LOCKERHUB_API_URL is set — every call throws lockerHubDisabled()
 * so the orchestration route returns a clean 503 rather than hitting undefined.
 * Pricing/amounts are server-side on LockerHub; NCD never sends amounts.
 */
import { config } from '../../config.js';
import { errors } from '../../lib/errors.js';

const HTTP_TIMEOUT_MS = 12000;

export const lockerHubConfigured = (): boolean => !!config.LOCKERHUB_API_URL;
const apiKey = (): string => config.LOCKERHUB_API_KEY || config.LOCKERHUB_INTEGRATION_KEY;

export interface ActingStaff { id: string | number; name: string; email?: string | null }

function base(): string {
  return String(config.LOCKERHUB_API_URL).replace(/\/+$/, '');
}

async function lhFetch<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  if (!lockerHubConfigured()) throw errors.unavailable('LockerHub locker API is not configured (LOCKERHUB_API_URL)');
  const q = opts.query
    ? '?' + Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${base()}${path}${q}`, {
      method,
      headers: { 'X-Integration-Key': apiKey(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    throw errors.unavailable(`LockerHub unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(tid);
  }
  let json: unknown = null;
  try { json = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) {
    const msg = (json as { error?: string; message?: string })?.error ?? (json as { message?: string })?.message ?? `LockerHub ${resp.status}`;
    // Surface LockerHub's own status (e.g. 409 missing legs, 400 locker taken)
    // with its body so the staff UI can show the exact reason.
    throw errors.upstream(resp.status, msg, json);
  }
  return json as T;
}

// ── Reads ────────────────────────────────────────────────────────────────
export const ping = () => lhFetch<{ ok: boolean; service: string; time: string }>('GET', '/ping');
export const branches = () => lhFetch<{ branches: Array<{ id: string; name: string; address?: string }> }>('GET', '/branches');
export const lockerAvailability = (branchId?: string) =>
  lhFetch<Record<string, unknown>>('GET', '/locker-availability', { query: { branch_id: branchId } });
export const lockers = (branchId: string, size?: string) =>
  lhFetch<{ lockers: Array<Record<string, unknown>> }>('GET', '/lockers', { query: { branch_id: branchId, size } });
/**
 * The tenant roster — every OCCUPIED locker with who holds it, keyed by
 * tenant_id. The counterpart to /lockers, which returns vacant lockers only.
 * branch_id is OPTIONAL: omit it for all branches in one call, or pass a single
 * id (their API also accepts a comma-separated list, max 50).
 */
export const lockerTenants = (branchId?: string) =>
  lhFetch<{ tenants: Array<Record<string, unknown>> }>('GET', '/locker-tenants', { query: { branch_id: branchId } });
export const getCustomer = (phone: string) =>
  lhFetch<Record<string, unknown>>('GET', `/customers/${encodeURIComponent(phone)}`);
export const getLockerApplication = (id: string) =>
  lhFetch<Record<string, unknown>>('GET', `/locker-applications/${encodeURIComponent(id)}`);

// ── Writes (carry the acting staff) ───────────────────────────────────────
export const upsertCustomer = (staff: ActingStaff, profile: Record<string, unknown>) =>
  lhFetch<{ success: boolean; phone: string; created: boolean }>('POST', '/customers', { body: { ...profile, staff } });

export const createLockerApplication = (staff: ActingStaff, input: { phone: string; name?: string; email?: string; branch_id: string; locker_size: string }) =>
  lhFetch<Record<string, unknown>>('POST', '/locker-applications', { body: { ...input, staff } });

export const paymentLink = (staff: ActingStaff, applicationId: string, leg: 'rent' | 'deposit') =>
  lhFetch<Record<string, unknown>>('POST', `/locker-applications/${encodeURIComponent(applicationId)}/payment-link`, { body: { leg, staff } });

// A10 recordPayment removed — RETIRED by LockerHub (contract v1.2 §A10). It
// returns 400 `online_only` for every caller, because online-only is a property
// of the locker/NCD product, not of who is calling. Use paymentLink (A9) to
// collect, or linkNcd (A12) to satisfy a deposit leg with an NCD investment.

/**
 * A12 — settle a locker's deposit leg as NCD-BACKED (not as money received).
 *
 * Replaces the old `recordPayment({ leg: 'deposit' })` route, which LockerHub
 * retired in their #709 (returns 400 `online_only`): a synthetic payment row
 * broke their reconciliation, double-counted AUM, and made their deposit-refund
 * flow treat the pledge as NEFT-refundable cash.
 *
 * `ncd_id` is our application_no — the same identifier as B17/B18/B19a. No
 * method or reference field: the leg is settled by pledge, not by payment.
 * Idempotent on re-submit. The response carries the locker application status,
 * since LockerHub allocates in the same call once the rent leg is settled.
 */
export const linkNcd = (staff: ActingStaff, applicationId: string, input: { ncd_id: string }) =>
  lhFetch<Record<string, unknown>>('POST', `/locker-applications/${encodeURIComponent(applicationId)}/link-ncd`, { body: { ...input, staff } });

export const allocate = (staff: ActingStaff, applicationId: string, input: { locker_id?: string; lease_months?: number }) =>
  lhFetch<Record<string, unknown>>('POST', `/locker-applications/${encodeURIComponent(applicationId)}/allocate`, { body: { ...input, staff } });
