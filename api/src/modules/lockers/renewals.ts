/**
 * Locker renewals — whose rent is due, and who is already overdue.
 *
 * A locker is an annual-rent product, but until now nothing in NCD told anyone
 * when a lease runs out (owner, 2026-08-03: "there is no way at all to renew a
 * locker"). The facts were already on the tenants screen — `lease_expires_on`
 * has been in the roster since A13 — but a roster sorted by branch does not
 * answer "who do I chase this week", so nobody could act on it.
 *
 * Built ON TOP of lockerTenants() rather than fetching the roster again. That is
 * deliberate: the tenants pass already does branch scoping, the phone+full-name
 * matching guard that stops a family member's locker being pinned to the wrong
 * customer, the manual link/removal overrides, and the deposit-waiver overlay.
 * A second, simpler implementation of the same join would drift from it and
 * eventually disagree on screen — the one thing worse than no renewal list.
 *
 * READ-ONLY, and it says so on the page. LockerHub has no renewal call: an
 * application carries exactly two legs (rent, deposit), each a bare
 * settled true/false, and A18 settle-offline is idempotent on a leg that is
 * already settled — so there is no way from here to take a second year's rent
 * or to move a lease end date. Offering a "Collect" button that cannot work
 * would be worse than offering none. See ops/LOCKERHUB-CR-RENEWALS.md.
 */
import type { Db } from '../../db/types.js';

export interface RenewalRow {
  tenant_id: string | null;
  /** Needed to re-open the application — the only route to its e-Sign. */
  lockerhub_application_id: string | null;
  locker_no: string | null;
  locker_size: string | null;
  branch_id: string | null;
  branch_name: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  customer_id: number | null;
  customer_code: string | null;
  lease_start: string | null;
  lease_expires_on: string | null;
  /** Negative = already expired. Null when LockerHub holds no expiry date. */
  days_to_expiry: number | null;
  annual_rent: number | null;
  deposit_amount: number | null;
  /** Deposit backed by an NCD investment — renewing has an NCD consequence. */
  pledged_amount: number;
  ncd_backed: boolean;
  state: 'expired' | 'due' | 'upcoming' | 'unknown';
  /**
   * The allotment was BACKDATED on our side (owner 2026-09-04). The expiry above
   * is LockerHub's, computed from the date THEY stamped — so this locker comes
   * up for renewal LATE by however far it was backdated. Shown rather than
   * silently corrected: their date is the one their billing follows.
   */
  backdated_allotment?: { allotted_on: string; lockerhub_allotted_on: string | null; reason: string | null } | null;
}

/** Everything expiring within this many days counts as "coming up". */
const DEFAULT_WINDOW_DAYS = 60;
/** Inside this many days it is no longer a heads-up, it is this week's work. */
const DUE_SOON_DAYS = 14;

const asDate = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/**
 * Whole days from today to `iso`, negative once it is in the past.
 *
 * Compared as plain calendar dates in UTC, never as timestamps: a lease expiry
 * is a date, and running Date.now() against midnight makes "expires today" read
 * as -1 day (expired) for most of the working day.
 */
export function daysUntil(iso: string | null, today = new Date()): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - now) / 86400000);
}

/**
 * One roster tenancy → one renewal row, or `null` when it does not belong on
 * this screen.
 *
 * Separated out so the decisions here can be tested directly: LockerHub is not
 * configured under test, so anything left inside the fetch loop is reachable
 * only by a live roster and would in practice go unverified.
 *
 * `today` is injectable for the same reason the date helper's is — a test that
 * cannot fix "now" cannot pin a boundary.
 */
export function renewalRowFrom(
  r: Record<string, any>,
  withinDays: number = DEFAULT_WINDOW_DAYS,
  today = new Date(),
): RenewalRow | null {
  // A tenancy that never got allotted has no lease to renew — it is unfinished
  // enrolment, which is the Outstanding list's job, not this one.
  if (!r.tenant_id && !r.lease_expires_on) return null;
  // Closed/cancelled tenancies are not renewable and must not be chased.
  const acct = String(r.account_status ?? '').toLowerCase();
  if (acct === 'closed' || acct === 'cancelled') return null;

  const expires = asDate(r.lease_expires_on);
  const days = daysUntil(expires, today);
  const state: RenewalRow['state'] =
    days == null ? 'unknown' : days < 0 ? 'expired' : days <= DUE_SOON_DAYS ? 'due' : 'upcoming';

  // Anything further out than the window is simply not this screen's business.
  // "unknown" is kept regardless: a live tenancy with no expiry date on record
  // is a gap somebody has to close, and dropping it hides it forever.
  if (state === 'upcoming' && (days ?? 0) > withinDays) return null;

  return {
    tenant_id: r.tenant_id ? String(r.tenant_id) : null,
    lockerhub_application_id: r.lockerhub_application_id ? String(r.lockerhub_application_id) : null,
    locker_no: r.locker_no ?? null,
    locker_size: r.locker_size ?? null,
    branch_id: r.branch_id ?? null,
    branch_name: r.branch_name ?? null,
    tenant_name: r.tenant_name ?? null,
    tenant_phone: r.tenant_phone ?? null,
    customer_id: r.customer_id != null ? Number(r.customer_id) : null,
    customer_code: r.customer_code ?? null,
    lease_start: asDate(r.lease_start),
    lease_expires_on: expires,
    days_to_expiry: days,
    annual_rent: r.annual_rent != null ? Number(r.annual_rent) : null,
    deposit_amount: r.deposit_amount != null ? Number(r.deposit_amount) : null,
    pledged_amount: Number(r.pledged_amount ?? 0),
    ncd_backed: !!r.ncd_backed,
    state,
  };
}

/**
 * Branch scoping is decided by the CALLER, exactly as `/tenants` does it — the
 * route owns that 403 so there is one place where "which branches may this user
 * see" is answered, not two that can drift apart.
 */
export async function lockerRenewals(
  db: Db,
  opts: { withinDays?: number; branchId?: string | string[] } = {},
): Promise<{ rows: RenewalRow[]; lockerhub_error: string | null; window_days: number }> {
  const withinDays = Number.isFinite(opts.withinDays) && opts.withinDays! > 0
    ? Math.min(Math.trunc(opts.withinDays!), 365)
    : DEFAULT_WINDOW_DAYS;

  const { lockerTenants } = await import('./deposits.js');
  const t = await lockerTenants(db, opts.branchId ? { branchId: opts.branchId } : {});
  const tenancies = (t.rows ?? []) as Array<Record<string, any>>;

  // Backdated allotments, so a locker whose real start pre-dates LockerHub's
  // record is visibly flagged instead of quietly renewing late.
  const { backdatedByApplication } = await import('./allotments.js');
  const backdated = await backdatedByApplication(db).catch(() => new Map());

  const rows: RenewalRow[] = [];
  for (const r of tenancies) {
    const row = renewalRowFrom(r, withinDays);
    if (!row) continue;
    const bd = row.lockerhub_application_id ? backdated.get(row.lockerhub_application_id) : undefined;
    if (bd) {
      row.backdated_allotment = {
        allotted_on: bd.allotted_on,
        lockerhub_allotted_on: bd.lockerhub_allotted_on,
        reason: bd.backdate_reason,
      };
    }
    rows.push(row);
  }

  // Most overdue first, then soonest. The top of this list is money already
  // being used without being paid for. `unknown` sorts last: it needs fixing,
  // but not ahead of a lease that expired three weeks ago.
  rows.sort((a, b) => {
    if (a.days_to_expiry == null) return b.days_to_expiry == null ? 0 : 1;
    if (b.days_to_expiry == null) return -1;
    return a.days_to_expiry - b.days_to_expiry;
  });

  return { rows, lockerhub_error: t.lockerhub_error ?? null, window_days: withinDays };
}
