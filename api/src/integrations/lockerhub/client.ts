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

/**
 * Who is acting, as LockerHub records it in their audit log.
 *
 * `staff_role` carries OUR role name verbatim (contract §A11, 2026-07-25). They
 * only operate a denylist — `agent` / `lead_agent` / `rm` /
 * `relationship_manager` are refused on allocate with 403 `staff_only` — so our
 * `agent` role is correctly blocked while every other role passes through. Send
 * the real role rather than a flattened "branch": an honest assertion is what
 * their audit trail is for, and it keeps the block working if they ever widen
 * the list.
 */
export interface ActingStaff {
  id: string | number; name: string; email?: string | null; staff_role?: string;
  /**
   * The branch this write is asserted to be for (contract §A14, 2026-07-29).
   * Optional on their side: when present they compare it against the branch
   * resolved from the tenancy and refuse a mismatch with
   * `403 { code: 'branch_scope' }`. Only sent for an operator who IS restricted
   * to one branch — a head-office user legitimately records anywhere, and
   * asserting a branch for them would invent a restriction that does not exist.
   */
  branch_id?: string;
}

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

/**
 * Same call, but for a response that is BYTES rather than JSON — lhFetch always
 * parses, which would destroy a PDF. Errors are still read as JSON, since a
 * failure comes back as their usual error envelope.
 */
async function lhFetchBinary(path: string, query: Record<string, string | undefined> = {}): Promise<{ body: Buffer; contentType: string }> {
  const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  const qs = q.length ? '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  if (!lockerHubConfigured()) throw errors.unavailable('LockerHub locker API is not configured (LOCKERHUB_API_URL)');
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${base()}${path}${qs}`, { headers: { 'X-Integration-Key': apiKey() }, signal: ctl.signal });
  } catch (e) {
    throw errors.unavailable(`LockerHub unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(tid);
  }
  if (!resp.ok) {
    let json: unknown = null;
    try { json = JSON.parse(await resp.text()); } catch { /* non-JSON error */ }
    const msg = (json as { error?: string; message?: string })?.error
      ?? (json as { message?: string })?.message ?? `LockerHub ${resp.status}`;
    throw errors.upstream(resp.status, msg, json);
  }
  return {
    body: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type') || 'application/pdf',
  };
}

/**
 * A16 — the signed locker agreement, as a PDF.
 *
 * Keyed on the AGREEMENT id, which is the `esign_id` that A19.2 /esign/status
 * returns — not the application id. Chain: status → esign_id → here.
 *
 * Use this rather than the `signed_file_url` that comes back on the status:
 * that is an internal SharePoint link and is not openly fetchable, so
 * rendering it as a download would hand staff a link that 404s for them
 * (LockerHub, 2026-07-31).
 *
 * ATTRIBUTION IS MANDATORY, and as a QUERY PARAMETER — this is a GET, so there
 * is no body to put a `staff` block in. Without `staff_id` they answer
 * `400 staff_id attribution required` and nothing downloads. Found by probing
 * their live endpoint after deploying; it is not in the note they sent, so do
 * not "simplify" it away.
 */
export const agreementPdf = (staff: ActingStaff, esignId: string) =>
  lhFetchBinary(`/agreements/${encodeURIComponent(esignId)}/pdf`, {
    staff_id: String(staff.id),
    staff_name: staff.name || undefined,
  });

// ── Reads ────────────────────────────────────────────────────────────────
export const ping = () => lhFetch<{ ok: boolean; service: string; time: string }>('GET', '/ping');
export const branches = () => lhFetch<{ branches: Array<{ id: string; name: string; address?: string }> }>('GET', '/branches');
export const lockerAvailability = (branchId?: string) =>
  lhFetch<Record<string, unknown>>('GET', '/locker-availability', { query: { branch_id: branchId } });

/**
 * A15 — the whole stock position: totals, what's left, branch-wise and size-wise.
 *
 * NOT interchangeable with lockerAvailability (A3). A3 is a sell-right-now price
 * quote and OMITS sizes with zero vacancy; A15 hides nothing — every canonical
 * size at every branch comes back, zeroes included, because "0 Extra Large left
 * at Hosur" is the fact a stock screen exists to state. Quote a sale from A3,
 * show stock from A15.
 *
 * `vacant` is what is actually sellable. `reserved` is a locker mid-allocation —
 * never add it to `vacant` when telling a customer what's available. Statuses
 * LockerHub adds later land in `other` and are itemised in `by_status`, so
 * `total` always equals the real row count and nothing is silently dropped.
 *
 * Omit branchId for the whole network; pass one to scope everything (totals
 * included) to that branch. An unknown id is a 404 from them, surfaced as-is.
 * Counts are read live off the same rows allocation reads, and they do not
 * cache — call it as often as the page needs.
 */
export interface LockerStockCounts {
  total: number; vacant: number; occupied: number; reserved: number; other: number;
  by_status: Record<string, number>;
}
export interface LockerSizeStock extends LockerStockCounts { size: string }
export interface LockerBranchStock extends LockerStockCounts {
  branch_id: string; branch_name: string; address?: string | null;
  occupancy_pct: number; by_size: LockerSizeStock[];
}
export interface LockerInventory {
  as_of: string;
  branch_id: string | null;
  totals: LockerStockCounts & { occupancy_pct: number; branches: number };
  by_size: LockerSizeStock[];
  pricing: Array<{ size: string; annual_fee: number; rent_incl_gst: number; deposit: number; gst_pct: number }>;
  branches: LockerBranchStock[];
}
export const lockerInventory = (branchId?: string) =>
  lhFetch<LockerInventory>('GET', '/locker-inventory', { query: { branch_id: branchId } });
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
/**
 * A14 — the locker Visit Log: who opened which locker, when and why.
 *
 * `tenant_phone` comes back MASKED to last-4 (`******3210`), the same posture
 * as the A13 roster. Full phone would need Prem's sign-off on their side, so
 * never build a lookup that depends on it.
 *
 * All filters are optional; results are newest-first, default 500 rows capped
 * at 5000.
 */
export interface LockerVisit {
  id: string;
  branch_id?: string | null; branch_name?: string | null;
  tenant_id?: string | null; tenant_name?: string | null; tenant_phone?: string | null;
  locker_id?: string | null; locker_number?: string | null; locker_size?: string | null;
  datetime?: string | null; visit_time?: string | null; exit_time?: string | null;
  purpose?: string | null; duration?: string | null; notes?: string | null;
  created_at?: string | null;
}
export const lockerVisits = (q: { branch_id?: string; phone?: string; limit?: number } = {}) =>
  lhFetch<{ visits: LockerVisit[] }>('GET', '/visits', { query: { branch_id: q.branch_id, phone: q.phone, limit: q.limit } });

/**
 * A14 write — record a walk-in. Branch and locker are DERIVED from the tenancy
 * on their side (a tenant has exactly one locker), so we deliberately do not
 * send them: the phone identifies the customer and they resolve the rest from
 * the most-recent ACTIVE tenancy. 404 if nobody active matches.
 *
 * Unlike allocate this is not privileged — no staff-only block — but the write
 * is still attributed and lands in their audit log as `ncd_app_visit_recorded`.
 *
 * Branch scope rides on `staff.branch_id` (§A14, 2026-07-29): supply it and
 * they refuse a tenancy belonging to a different branch with
 * `403 { code: 'branch_scope', tenant_branch_id }`. See the caller for who gets
 * it and who does not.
 */
export const recordLockerVisit = (
  staff: ActingStaff,
  input: { phone?: string; tenant_id?: string; datetime?: string; purpose?: string; duration?: string; notes?: string; visit_time?: string; exit_time?: string },
) => lhFetch<{ success: boolean; id: string; tenant_id: string; tenant_name: string; branch_id: string; locker_id: string }>(
  'POST', '/visits', { body: { ...input, staff } });

export const getCustomer = (phone: string) =>
  lhFetch<Record<string, unknown>>('GET', `/customers/${encodeURIComponent(phone)}`);
export const getLockerApplication = (id: string) =>
  lhFetch<Record<string, unknown>>('GET', `/locker-applications/${encodeURIComponent(id)}`);

// ── Writes (carry the acting staff) ───────────────────────────────────────
export const upsertCustomer = (staff: ActingStaff, profile: Record<string, unknown>) =>
  lhFetch<{ success: boolean; phone: string; created: boolean }>('POST', '/customers', { body: { ...profile, staff } });

/**
 * A7 — open a locker application. The optional `applicant` block (contract
 * 2026-07-24) carries the full profile — address, nominee, KYC, bank — so the
 * tenancy is complete on their side and nobody has to open LockerHub to finish
 * it. Built by `modules/lockers/applicant.ts` from our own customer record;
 * see that file for why Aadhaar is last-four only.
 */
export const createLockerApplication = (
  staff: ActingStaff,
  input: { phone: string; name?: string; email?: string; branch_id: string; locker_size: string; applicant?: Record<string, unknown>;
    // NCD-owned pricing sent on create (owner 2026-08-07). LockerHub honouring
    // these is a pending contract change; omitted when unset.
    deposit_amount?: number; annual_rent?: number },
) => lhFetch<Record<string, unknown>>('POST', '/locker-applications', { body: { ...input, staff } });

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

/**
 * A18 — settle a leg with money taken OFFLINE (cheque, cash, transfer).
 *
 * The successor to the retired A10 record-payment. The difference that made A10
 * unsafe is that this writes a correctly-TYPED offline receipt rather than a
 * synthetic online row, so their reconciliation and deposit-refund flows treat
 * it as what it is (their #709).
 *
 * The amount is derived on their side from the leg — deliberately not sent, so
 * a stale figure here can never disagree with what they are owed.
 *
 * Idempotent, and unlike A21 waiver it works AFTER allotment too: that is the
 * case this exists for, a payment arriving once the locker is already handed
 * over under an A20 override.
 */
export const settleOffline = (
  staff: ActingStaff,
  applicationId: string,
  input: { leg: 'rent' | 'deposit'; method: 'cheque' | 'cash' | 'transfer'; reference?: string; received_on?: string; reason?: string },
) => lhFetch<Record<string, unknown>>(
  'POST', `/locker-applications/${encodeURIComponent(applicationId)}/settle-offline`, { body: { ...input, staff } });

/**
 * A17.1 — hand our KYC to an application that reached them bare.
 *
 * For applications created before the enrolment screen started sending
 * `customer_id`: no applicant block went with them, so they park at
 * `kyc_pending` with nothing to move them on. Going forward A7 carries the
 * KYC and this is not needed.
 *
 * LockerHub takes this approved-on-arrival, so it must only ever be sent when
 * OUR book says Verified — see modules/lockers/routes.ts, which refuses
 * otherwise. Asserting a verification we have not done would put a false
 * record in their book, and they are a regulated counterparty too.
 *
 * Aadhaar last four only. Never the full number.
 */
export const pushKyc = (
  staff: ActingStaff,
  applicationId: string,
  kyc: { pan: string; aadhaar_last4: string; verified: boolean; verified_on?: string; verifier?: string },
) => lhFetch<Record<string, unknown>>(
  'POST', `/locker-applications/${encodeURIComponent(applicationId)}/kyc`, { body: { ...kyc, staff } });

/**
 * A19 — start the locker-agreement e-Sign.
 *
 * Builds the agreement, uploads it to Digio and returns the signing `auth_url`;
 * Digio also emails/SMSes the customer, so handing the URL over is a
 * convenience for someone signing at the branch, not the only route.
 *
 * POST-ALLOTMENT ONLY — there is no agreement until there is a locker, and
 * they answer `409 not_allotted` before A11.
 *
 * NCD had no locker e-Sign at all before this: neither starting one nor
 * fetching the result. LockerHub added it themselves on 2026-07-29.
 */
export const esignInitiate = (staff: ActingStaff, applicationId: string) =>
  lhFetch<Record<string, unknown>>(
    'POST', `/locker-applications/${encodeURIComponent(applicationId)}/esign/initiate`, { body: { staff } });

/**
 * A19 — where the signing has got to. `{ found: false, status: null }` when
 * nothing has been started, so a missing e-Sign is a normal answer rather than
 * a 404. Completion arrives through their own Digio webhook, so this is a poll
 * for display, not a driver of anything.
 */
export const esignStatus = (applicationId: string) =>
  lhFetch<Record<string, unknown>>('GET', `/locker-applications/${encodeURIComponent(applicationId)}/esign/status`);

/**
 * A22 — authorised users on the locker record. Upsert on `ncd_ref` (our stable
 * id), so a re-push keeps them in sync with no duplicates and a blank field
 * doesn't wipe a stored value. Aadhaar is LAST-4 ONLY (a full number is rejected,
 * Aadhaar Act §29); post-allotment only (`409 not_allotted` before).
 */
export const pushAuthorisedUser = (staff: ActingStaff, applicationId: string, input: {
  name: string; phone?: string | null; pan?: string | null; aadhaar_last4?: string | null;
  relation?: string | null; consent_ref?: string | null; ncd_ref: string;
}) => lhFetch<Record<string, unknown>>('POST', `/locker-applications/${encodeURIComponent(applicationId)}/authorised-users`, { body: { ...input, staff } });

export const listLockerHubAuthorisedUsers = (applicationId: string) =>
  lhFetch<{ authorised_users: Array<Record<string, unknown>> }>('GET', `/locker-applications/${encodeURIComponent(applicationId)}/authorised-users`);

/**
 * A21 — waive rent or deposit on an application.
 *
 * LockerHub applies this **approved-on-arrival**: they do not re-check it, and
 * they attribute it to `approved_by`. So this must only ever be called after
 * OUR checker has approved — see modules/lockers/feeWaivers.ts, which is the
 * only caller for that reason.
 *
 * 100% clears the leg outright (`leg_settled: true` comes back); a partial one
 * reduces the payable and their side recomputes rent GST on the discounted
 * base, so the reduced figure is what A9 payment-link or A18 settle-offline
 * then collect. PRE-ALLOTMENT ONLY — once a locker is handed over there is
 * nothing left to waive.
 */
export const applyWaiver = (
  staff: ActingStaff,
  applicationId: string,
  input: { leg: 'rent' | 'deposit'; waiver_pct?: number; waiver_amount?: number; reason: string; approved_by: string },
) => lhFetch<Record<string, unknown>>(
  'POST', `/locker-applications/${encodeURIComponent(applicationId)}/waiver`, { body: { ...input, staff } });

/**
 * A23 — cancel a locker application (LockerHub, 2026-08-22, at our request).
 *
 * The one thing NCD could never do: void a mis-keyed enrolment. Before this our
 * "Delete" could only hide the row locally, so the customer lookup kept
 * returning the old application and a fresh enrolment was never clean.
 *
 * Their guarantees, which the caller relies on: idempotent (`already: true` on
 * re-cancel), releases any held locker, and a WAIVED leg does not block —
 * abandoned-with-a-waiver is the case this exists for. It refuses only where
 * money was collected (409 payment_collected) or the application is already a
 * live tenancy (409 live_tenancy).
 */
export const cancelLockerApplication = (
  staff: ActingStaff,
  applicationId: string,
  reason: string,
) => lhFetch<{ success?: boolean; status?: string; locker_released?: string | boolean | null; already?: boolean }>(
  'POST', `/locker-applications/${encodeURIComponent(applicationId)}/cancel`, { body: { reason, staff } });

/**
 * A11 — allocate. This is the APPROVAL step: it is what creates the tenant on
 * LockerHub, so `staff` is mandatory and lands in their audit log as
 * "<name> (NCD app)". Omit `locker_id` to let them auto-pick the lowest vacant
 * locker of the requested size; `lease_months` defaults to 12 on their side.
 *
 * A tenant is ONE LOCKER RENTAL, not a customer account — one person with three
 * lockers is three tenant rows sharing a phone. Never treat a tenant row as an
 * identity.
 *
 * Failure modes worth knowing (surfaced with their status + body by lhFetch):
 *   409 obligations_pending + missing:["rent"|"deposit"] — money unsettled. The
 *       gate stays the right default; `override` is the deliberate, attributed
 *       way past it (§A20) and nothing else opens it.
 *   400 no_vacancy — nothing left in that size.
 *   400 "Locker is no longer vacant" — a race; retry (re-picks if no locker_id).
 *   200 already:true — already allocated. Treated as SUCCESS by callers, since a
 *       re-drive of a completed allocation is the queue doing its job.
 */
export const allocate = (
  staff: ActingStaff,
  applicationId: string,
  input: {
    locker_id?: string;
    lease_months?: number;
    /**
     * A20 (2026-07-29) — allot with rent or deposit still outstanding. Both
     * fields are required on their side and the call is loudly audited. They
     * asked US to restrict it to a senior role, which routes.ts does via
     * `lockers:allot-override`.
     *
     * A spurious override is ignored: if §A18/§A21 already cleared the legs
     * there is nothing to override, and allocate passes on its own merits.
     */
    override?: { reason: string; approved_by: string };
  },
) =>
  lhFetch<Record<string, unknown>>('POST', `/locker-applications/${encodeURIComponent(applicationId)}/allocate`, { body: { ...input, staff } });
