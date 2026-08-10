/**
 * Everything that is started but not finished, in one place (owner 2026-08-01).
 *
 * These items already exist, each on its own screen — a part payment on the
 * customer, a cheque inside one locker application, an approval in the queue.
 * That is precisely the problem: nothing is wrong with any single screen, and
 * an item that nobody happens to open just ages. This is the list you check
 * when you want to know what is hanging, without knowing where to look.
 *
 * Deliberately NCD-owned data only — no LockerHub call. This list must answer
 * instantly and must not go blank because a partner API is having a bad
 * morning; a monitoring view that depends on the thing it monitors is worth
 * very little. Locker allotment and e-sign state live with LockerHub and are
 * shown on the enrolment screen, which is already talking to them.
 *
 * Every row carries `age_days` because age is the point. A cheque taken
 * yesterday is business as usual; the same cheque uncleared for six weeks is
 * money nobody chased.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';

const SCOPE_COLS = {
  userCol: 'a.enrolled_by_user_id',
  agentCol: 'a.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
  refCol: "COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)",
};

export interface OutstandingRow {
  kind: 'part_payment' | 'awaiting_approval' | 'cheque_uncleared' | 'cheque_settle_failed';
  id: number;
  customer_id: number | null;
  customer: string | null;
  customer_code: string | null;
  reference: string;
  amount: string;
  since: string | null;
  age_days: number | null;
  detail: string;
}

/** NCDs are issued in whole ₹1,00,000 units; a pending total that is not one is
 *  a part payment still waiting to be clubbed. */
const LAKH = 100000;

export async function outstandingItems(db: Db, actor: AuthUser, customerId?: number): Promise<OutstandingRow[]> {
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  const custFilter = customerId ? ` AND a.customer_id = ${Number(customerId)}` : '';

  // 1) Part payments — pending, and the total is not yet a whole unit. The one
  //    that most needs a home: it is new, and it looks exactly like a normal
  //    pending investment on every other screen.
  const partPayments = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.total_amount, a.created_at, a.customer_id,
            c.full_name AS customer, c.customer_code
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE ${sc.sql}${custFilter}
        AND a.archived_at IS NULL
        AND a.status IN ('Draft','PendingApproval','PendingFundVerification','PendingEsign')
        -- Subordinate bonds carry NO whole-unit rule (owner 2026-08-10), so a
        -- ₹60,000 one is a complete investment, not a part payment. Without
        -- this it would be listed as "needs ₹40,000 more" — advice that is
        -- simply wrong for the product.
        AND a.product_type <> 'subordinate_bond'
        AND (round(a.total_amount * 100)::bigint % ${LAKH * 100}) <> 0
      ORDER BY a.created_at`, sc.params)).rows;

  // 2) Awaiting approval, whole-unit ones. Split from the above on purpose:
  //    a part payment CANNOT be approved yet, so listing it as "awaiting
  //    approval" would send a checker to a button that will refuse them.
  const awaiting = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.total_amount, a.created_at, a.customer_id,
            c.full_name AS customer, c.customer_code
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE ${sc.sql}${custFilter}
        AND a.archived_at IS NULL
        AND a.status = 'PendingApproval'
        -- A subordinate bond of any amount is approvable, so it belongs here
        -- whatever its total; an NCD still has to be a whole unit first.
        AND (a.product_type = 'subordinate_bond'
             OR (round(a.total_amount * 100)::bigint % ${LAKH * 100}) = 0)
      ORDER BY a.created_at`, sc.params)).rows;

  // 3) + 4) Locker cheques. Not scoped by the application scope above — a
  //    cheque row is keyed to a LockerHub application, not one of ours — so it
  //    is filtered by customer only, which is what the customer view needs and
  //    is safe for the global view (both are staff-only screens).
  const chequeCust = customerId ? ` AND q.customer_id = ${Number(customerId)}` : '';
  const cheques = (await db.query<Record<string, unknown>>(
    `SELECT q.id, q.cheque_no, q.leg, q.amount, q.received_on, q.cleared_on, q.status,
            q.lockerhub_settled_at, q.lockerhub_error, q.lockerhub_application_id,
            q.customer_id, c.full_name AS customer, c.customer_code
       FROM locker_cheques q LEFT JOIN customers c ON c.id = q.customer_id
      WHERE (q.status = 'Pending'
             OR (q.status = 'Cleared' AND q.lockerhub_settled_at IS NULL))${chequeCust}
      ORDER BY q.received_on`)).rows;

  const days = (v: unknown): number | null => {
    if (!v) return null;
    const t = new Date(typeof v === 'string' ? v : (v as Date).toISOString()).getTime();
    return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
  };
  const iso = (v: unknown): string | null => {
    if (!v) return null;
    const s = typeof v === 'string' ? v : (v as Date).toISOString();
    return s.slice(0, 10);
  };

  const rows: OutstandingRow[] = [];

  for (const r of partPayments) {
    const amt = Number(r.total_amount);
    const short = (Math.floor(amt / LAKH) + 1) * LAKH - amt;
    rows.push({
      kind: 'part_payment', id: Number(r.id),
      customer_id: r.customer_id ? Number(r.customer_id) : null,
      customer: (r.customer as string) ?? null, customer_code: (r.customer_code as string) ?? null,
      reference: r.application_no as string, amount: String(r.total_amount),
      since: iso(r.created_at), age_days: days(r.created_at),
      detail: `Needs ₹${short.toLocaleString('en-IN')} more to make a whole unit — cannot be approved until then`,
    });
  }

  for (const r of awaiting) {
    rows.push({
      kind: 'awaiting_approval', id: Number(r.id),
      customer_id: r.customer_id ? Number(r.customer_id) : null,
      customer: (r.customer as string) ?? null, customer_code: (r.customer_code as string) ?? null,
      reference: r.application_no as string, amount: String(r.total_amount),
      since: iso(r.created_at), age_days: days(r.created_at),
      detail: 'Money recorded, waiting for a checker to approve it live',
    });
  }

  for (const r of cheques) {
    const settleFailed = r.status === 'Cleared';
    rows.push({
      kind: settleFailed ? 'cheque_settle_failed' : 'cheque_uncleared',
      id: Number(r.id),
      customer_id: r.customer_id ? Number(r.customer_id) : null,
      customer: (r.customer as string) ?? null, customer_code: (r.customer_code as string) ?? null,
      reference: `${r.cheque_no as string} · ${r.leg as string}`,
      amount: String(r.amount),
      since: iso(settleFailed ? r.cleared_on : r.received_on),
      age_days: days(settleFailed ? r.cleared_on : r.received_on),
      detail: settleFailed
        // The code that clears a cheque says this is "exactly the thing that
        // otherwise goes unnoticed": the money cleared on our side, LockerHub
        // never took the settlement, and the locker will not allot.
        ? `Cheque cleared but LockerHub did NOT accept the settlement — the locker leg is still outstanding${r.lockerhub_error ? `: ${String(r.lockerhub_error).slice(0, 120)}` : ''}`
        : 'Cheque taken but not yet cleared — the locker leg settles only when it clears',
    });
  }

  // Oldest first: the list is read top-down, and the top is where the risk is.
  return rows.sort((x, y) => (y.age_days ?? 0) - (x.age_days ?? 0));
}
