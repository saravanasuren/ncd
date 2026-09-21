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
 *   5. unpaid    otherwise
 * A request still awaiting approval changes NO status — it is not in force — but
 * it is named in `reason`, so "Premium, awaiting approval" is visible instead of
 * silently reading as an ordinary unpaid locker.
 *
 * "Unpaid" always says WHY. LockerHub owns the money, so an unsettled rent leg is
 * Unpaid — but NCD also records collections (a cleared cheque, an approved
 * transfer) and pushes each to LockerHub as a second call that can fail. When NCD
 * holds such a record LockerHub never settled, the reason names it: the customer
 * DID pay, and what is broken is the settlement, not the customer.
 *
 * Every consumer goes through rentDecisions(); none may recompute this.
 */
import type { RentStatus } from '@new-wealth/shared';
import type { Db } from '../../db/types.js';
import * as lh from '../../integrations/lockerhub/client.js';

export interface RentWaiver { category: string; waiver_pct: number | null; status: string; reason: string | null }
/** A rent collection NCD recorded, and whether LockerHub was ever told. */
export interface RentPayment { kind: 'cheque' | 'transfer'; state: 'collected' | 'awaiting_approval'; reference: string | null; settled: boolean; error: string | null }
export interface RentDecision { status: RentStatus; reason: string | null }

type App = Record<string, any>;

const settled = (app: App): boolean => {
  const leg = app?.legs?.rent;
  return leg?.settled === true || /paid|settled|success|complete/i.test(String(leg?.status ?? ''));
};

/** Why an unsettled rent leg is unpaid — the most specific true thing we know. */
function unpaidReason(app: App, payments: RentPayment[]): string {
  const unsettled = payments.find((p) => p.state === 'collected' && !p.settled);
  if (unsettled) {
    const what = unsettled.kind === 'cheque' ? `Cheque ${unsettled.reference ?? ''}`.trim() + ' cleared' : `Transfer ${unsettled.reference ?? ''}`.trim() + ' approved';
    return `${what} in NCD — rent not settled on LockerHub${unsettled.error ? ` (${unsettled.error})` : ''}`;
  }
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
