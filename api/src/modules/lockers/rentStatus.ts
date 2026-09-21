/**
 * How a locker's rent stands — the ONE rule, and the ONE way to get its inputs.
 *
 * Locker Tenants and the Locker Rent Report each used to decide this for
 * themselves:
 *
 *   Tenants  no approved waiver  →  PAID   (nothing about the money was checked)
 *   Report   no approved waiver  →  PAID if LockerHub's rent leg is settled,
 *                                   otherwise UNPAID
 *
 * So Tenants said "Paid" for any tenant with no waiver — settled or not — and a
 * customer flagged Premium whose request was still awaiting Admin/CXO approval
 * read Paid on one page and Unpaid on the other (Sonia, DHN0892). During a
 * LockerHub outage Tenants said Paid for everyone while the Report said Unpaid.
 * Two copies of a rule drift; this file is the only copy.
 *
 * The rule, in priority order:
 *   1. premium   an APPROVED premium waiver            (complimentary rent)
 *   2. waived    an APPROVED 100% discretionary waiver (customer pays nothing)
 *   3. unknown   LockerHub could not be read — nothing can be said about the
 *                money, so neither Paid nor Unpaid is claimed
 *   4. paid      LockerHub's rent leg is settled — a standard PARTIAL GST waiver
 *                lands here: the customer still pays the base
 *   5. paid      NCD holds a cleared cheque / approved transfer for the rent that
 *                LockerHub was never told about (`settlement_pending`). The money
 *                is in and approved; only the second call failed. It reads Paid,
 *                flagged, so nobody chases a customer who has paid — and the
 *                flag is what tells staff to retry the settlement.
 *   6. unpaid    otherwise
 * A request still awaiting approval changes NO status — it is not in force — but
 * it is named in `reason`, so "Premium, awaiting approval" is visible instead of
 * silently reading as an ordinary unpaid locker.
 *
 * "Unpaid" always says WHY. LockerHub owns the money, so an unsettled rent leg is
 * unsettled — but NCD also records collections (a cleared cheque, an approved
 * transfer) and pushes each to LockerHub as a second call that can fail (rule 5).
 * An application LockerHub has CANCELLED is not a locker owing rent: a cancel is
 * only allowed while nothing has been paid, so it would otherwise read Unpaid
 * forever. Callers that LIST lockers drop those (see liveApplications).
 *
 * Every consumer goes through rentDecisions(); none may recompute this.
 */
import type { RentStatus } from '@new-wealth/shared';
import type { Db } from '../../db/types.js';
import * as lh from '../../integrations/lockerhub/client.js';

export interface RentWaiver { category: string; waiver_pct: number | null; status: string; reason: string | null }
/** A rent collection NCD recorded, and whether LockerHub was ever told. */
export interface RentPayment { kind: 'cheque' | 'transfer'; state: 'collected' | 'awaiting_approval'; reference: string | null; settled: boolean; error: string | null }
export interface RentDecision { status: RentStatus; reason: string | null; settlement_pending?: boolean }

type App = Record<string, any>;

const settled = (app: App): boolean => {
  const leg = app?.legs?.rent;
  return leg?.settled === true || /paid|settled|success|complete/i.test(String(leg?.status ?? ''));
};

/** The rent amount both pages show: what LockerHub bills (`amount` IS the payable), else the pre-waiver figure. */
export function rentAmountOf(app: App | null): number | null {
  const leg = app?.legs?.rent;
  return Number(leg?.amount ?? leg?.original_amount ?? 0) || null;
}

/** LockerHub's own word for a cancelled application ("cancelled", per the A23 contract). */
export const isCancelled = (app: App | null): boolean => /^cancel/i.test(String(app?.status ?? app?.application_status ?? ''));

const settlementNote = (p: RentPayment) =>
  `${p.kind === 'cheque' ? `Cheque ${p.reference ?? ''}`.trim() + ' cleared' : `Transfer ${p.reference ?? ''}`.trim() + ' approved'} in NCD — settlement to LockerHub pending${p.error ? ` (${p.error})` : ''}`;

/** Why an unsettled rent leg is unpaid — the most specific true thing we know. */
function unpaidReason(app: App, payments: RentPayment[]): string {
  if (isCancelled(app)) return 'Application cancelled on LockerHub';
  if (payments.some((p) => p.state === 'awaiting_approval')) return 'Payment recorded — awaiting approval';
  const st = app?.legs?.rent?.status;
  return `LockerHub shows the rent unsettled${st ? ` (status: ${st})` : ''}; no payment recorded in NCD`;
}

/** The rule. Pure: waivers + what LockerHub said about the application (null = it could not be read) + NCD's recorded collections. */
export function rentDecisionOf(app: App | null, waivers: RentWaiver[], payments: RentPayment[] = []): RentDecision {
  const approved = waivers.filter((w) => w.status === 'Approved');
  const premium = approved.find((w) => w.category === 'premium');
  if (premium) return { status: 'premium', reason: premium.reason };
  const waived = approved.find((w) => w.category === 'waiver' && Number(w.waiver_pct) === 100);
  if (waived) return { status: 'waived', reason: waived.reason };

  // Not in force yet — say so, change nothing.
  const pending = waivers.find((w) => w.status === 'PendingApproval' && (w.category === 'premium' || Number(w.waiver_pct) === 100));
  const reason = pending
    ? (pending.category === 'premium' ? 'Premium request awaiting approval' : 'Rent waiver request awaiting approval')
    : null;

  if (!app) return { status: 'unknown', reason };
  if (settled(app)) return { status: 'paid', reason };
  // Rule 5 — money NCD collected and approved that LockerHub was never told about.
  const pendingSettle = isCancelled(app) ? undefined : payments.find((p) => p.state === 'collected' && !p.settled);
  if (pendingSettle) return { status: 'paid', reason: [reason, settlementNote(pendingSettle)].filter(Boolean).join(' · '), settlement_pending: true };
  return { status: 'unpaid', reason: [reason, unpaidReason(app, payments)].filter(Boolean).join(' · ') };
}

/** application id → rent collections NCD recorded (cleared cheques, approved / pending transfers). */
export async function loadRentPayments(db: Db): Promise<Map<string, RentPayment[]>> {
  const by = new Map<string, RentPayment[]>();
  const add = (id: unknown, p: RentPayment) => { const k = String(id); if (!by.has(k)) by.set(k, []); by.get(k)!.push(p); };
  const chq = (await db.query<Record<string, any>>(
    `SELECT lockerhub_application_id, cheque_no, lockerhub_settled_at, lockerhub_error
       FROM locker_cheques WHERE leg = 'rent' AND status = 'Cleared'`)).rows;
  for (const c of chq) add(c.lockerhub_application_id, { kind: 'cheque', state: 'collected', reference: (c.cheque_no as string) ?? null, settled: !!c.lockerhub_settled_at, error: (c.lockerhub_error as string) ?? null });
  const off = (await db.query<Record<string, any>>(
    `SELECT lockerhub_application_id, method, reference, status, lockerhub_settled_at, lockerhub_error
       FROM locker_offline_payments WHERE leg = 'rent' AND status IN ('Approved','PendingApproval')`)).rows;
  for (const o of off) add(o.lockerhub_application_id, {
    kind: String(o.method) === 'cheque' ? 'cheque' : 'transfer',
    state: String(o.status) === 'Approved' ? 'collected' : 'awaiting_approval',
    reference: (o.reference as string) ?? null, settled: !!o.lockerhub_settled_at, error: (o.lockerhub_error as string) ?? null,
  });
  return by;
}

/** application id → its rent waivers that matter to the rule (approved, or awaiting approval). */
export async function loadRentWaivers(db: Db): Promise<Map<string, RentWaiver[]>> {
  const rows = (await db.query<Record<string, any>>(
    `SELECT lockerhub_application_id, category, waiver_pct, status, reason
       FROM locker_fee_waivers WHERE leg = 'rent' AND status IN ('Approved', 'PendingApproval')`)).rows;
  const by = new Map<string, RentWaiver[]>();
  for (const w of rows) {
    const k = String(w.lockerhub_application_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push({
      category: String(w.category ?? 'waiver'), waiver_pct: w.waiver_pct == null ? null : Number(w.waiver_pct),
      status: String(w.status), reason: (w.reason as string) ?? null,
    });
  }
  return by;
}

/**
 * What LockerHub says about each application, read once, bounded. `preloaded`
 * lets a caller that already fetched some (Tenants does, for NCD-backed rows)
 * avoid asking twice. A failed read is `null` — and is reported, never turned
 * into "unpaid" or "paid".
 */
export async function readApplications(
  ids: string[], preloaded: Map<string, App | null> = new Map(), concurrency = 6,
): Promise<{ apps: Map<string, App | null>; error: string | null }> {
  const apps = new Map<string, App | null>(preloaded);
  let error: string | null = null;
  const todo = [...new Set(ids)].filter((id) => !apps.has(id));
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async (id) => {
      if (!lh.lockerHubConfigured()) { apps.set(id, null); return; }
      try { apps.set(id, await lh.getLockerApplication(id) as App); }
      catch (e) { if (!error) error = (e as Error).message; apps.set(id, null); }
    }));
  }
  return { apps, error };
}

/**
 * THE entry point: the rent decision for each application id. Tenants and the
 * Report both call this and nothing else, so they cannot disagree.
 */
export async function rentDecisions(
  db: Db, ids: string[], opts: { preloaded?: Map<string, App | null> } = {},
): Promise<{ decisions: Map<string, RentDecision>; apps: Map<string, App | null>; lockerhub_error: string | null }> {
  const unique = [...new Set(ids.filter(Boolean))];
  const [waivers, payments, { apps, error }] = await Promise.all([loadRentWaivers(db), loadRentPayments(db), readApplications(unique, opts.preloaded)]);
  const decisions = new Map<string, RentDecision>();
  for (const id of unique) decisions.set(id, rentDecisionOf(apps.get(id) ?? null, waivers.get(id) ?? [], payments.get(id) ?? []));
  return { decisions, apps, lockerhub_error: error };
}

// ── Which applications are lockers at all ────────────────────────────────

type Roster = Array<Record<string, any>>;

/**
 * Ids NCD staff removed (locker_tenant_overrides). Keyed on the tenant id for an
 * allotted tenancy and on the application id for one not yet allotted — the same
 * key Locker Tenants uses, so a removed tenancy is gone from both pages.
 */
export async function removedKeys(db: Db): Promise<Set<string>> {
  const rows = (await db.query<{ lockerhub_tenant_id: string }>(
    'SELECT lockerhub_tenant_id FROM locker_tenant_overrides WHERE removed_at IS NOT NULL')).rows;
  return new Set(rows.map((r) => String(r.lockerhub_tenant_id)));
}

/** Is this application id removed from NCD's view — directly, or via its roster tenancy? */
export function isRemoved(appId: string, removed: Set<string>, roster: Roster): boolean {
  if (removed.has(appId)) return true;
  const t = roster.find((x) => String(x.application_id ?? '') === appId);
  return !!t && removed.has(String(t.tenant_id ?? ''));
}

const lockerNoOf = (app: App | null): string => String(app?.allotment?.locker_number ?? app?.allotment?.locker_no ?? app?.locker_no ?? '').trim();

/**
 * An application that is NOT the tenancy on its locker: LockerHub's roster (the
 * allotted truth) holds a DIFFERENT application on the same locker at the same
 * branch. That is a stale or duplicate application — its rent leg was never
 * paid because the customer paid the other one — and listing it as a locker
 * would read "Unpaid" for a locker that is paid. Needs the roster: with it
 * unreadable nothing can be called superseded, so nothing is dropped.
 */
export function isSuperseded(appId: string, app: App | null, roster: Roster): boolean {
  if (!roster.length || !app) return false;
  if (roster.some((t) => String(t.application_id ?? '') === appId)) return false; // it IS the tenancy
  const no = lockerNoOf(app);
  const branch = String(app.branch_id ?? '');
  if (!no || !branch) return false;
  return roster.some((t) => String(t.locker_number ?? '').trim() === no && String(t.branch_id ?? '') === branch
    && String(t.application_id ?? '') !== appId);
}
