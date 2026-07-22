/**
 * Locker cheque register (NCD side only).
 *
 * Lockers are ONLINE-ONLY on LockerHub — contract v1.2 §A10 retired offline
 * record-payment and it now 400s for every caller, so NCD has no way to settle a
 * locker leg with a cheque. High-value customers still hand over cheques and
 * expect the locker opened, so this records the instrument and its clearance for
 * OUR books and audit.
 *
 * Read this before changing anything here: clearing a cheque releases NCD's own
 * hold and NOTHING ELSE. It does not settle the leg on LockerHub and does not
 * allot the locker — the LockerHub-side action is a STAFF action in their
 * Tenants screen (mark the row Paid, method = cheque), not an API call.
 *
 * Never route a cheque customer to the A9 payment link to "finish" it: that is
 * a live payment page, so it would take a SECOND real payment for money we
 * already hold — double collection, a refund owed, MDR on our own funds, and a
 * receipt telling the customer they paid online. LockerHub confirmed this
 * explicitly (2026-07-22). Every response repeats the correct route.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { toISODate } from '../../lib/dates.js';

export type ChequeLeg = 'rent' | 'deposit';

/** Stated on every response — a cleared cheque never opens a locker. */
export const SETTLEMENT_NOTE =
  'Recorded in NCD only. The locker leg is NOT settled on LockerHub and the locker will not allot. '
  + 'Complete it in LockerHub → Tenants (mark the row Paid, method = cheque). '
  + 'Do NOT open the payment link for a cheque customer — it is a live payment page and would take a SECOND real payment.';

export interface RecordChequeInput {
  lockerApplicationId: string;
  customerId?: number | null;
  leg: ChequeLeg;
  amount: number;
  chequeNo: string;
  bankName?: string | null;
  receivedOn: string;
  notes?: string | null;
}

const shape = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  lockerhub_application_id: r.lockerhub_application_id,
  customer_id: r.customer_id == null ? null : Number(r.customer_id),
  customer_name: r.customer_name ?? null,
  customer_code: r.customer_code ?? null,
  leg: r.leg,
  amount: Number(r.amount),
  cheque_no: r.cheque_no,
  bank_name: r.bank_name ?? null,
  received_on: toISODate(r.received_on as string | null),
  status: r.status,
  cleared_on: toISODate(r.cleared_on as string | null),
  reference: r.reference ?? null,
  notes: r.notes ?? null,
});

/** Take a cheque against a locker application. */
export async function recordCheque(db: Db, actor: AuthUser, input: RecordChequeInput) {
  const appId = String(input.lockerApplicationId ?? '').trim();
  if (!appId) throw errors.badRequest('lockerhub_application_id is required');
  if (!(input.amount > 0)) throw errors.badRequest('amount must be greater than zero');
  const chequeNo = String(input.chequeNo ?? '').trim();
  if (!chequeNo) throw errors.badRequest('cheque_no is required');

  const live = (await db.query(
    "SELECT id FROM locker_cheques WHERE lockerhub_application_id = $1 AND leg = $2 AND status = 'Pending'",
    [appId, input.leg])).rows[0];
  if (live) throw errors.conflict(`A cheque is already pending clearance for the ${input.leg} leg of ${appId}`);

  return db.withTx(async (tx) => {
    const row = (await tx.query<Record<string, unknown>>(
      `INSERT INTO locker_cheques (lockerhub_application_id, customer_id, leg, amount, cheque_no, bank_name, received_on, notes, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [appId, input.customerId ?? null, input.leg, input.amount, chequeNo,
       input.bankName ?? null, input.receivedOn, input.notes ?? null, actor.id])).rows[0]!;
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.cheque.record', entityType: 'locker_cheques', entityId: Number(row.id),
      after: { locker_application: appId, leg: input.leg, amount: input.amount, cheque_no: chequeNo },
    });
    return { cheque: shape(row), note: SETTLEMENT_NOTE };
  });
}

/** The register. Defaults to what's still awaiting clearance. */
export async function listCheques(db: Db, filters: { status?: string; lockerApplicationId?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) { params.push(filters.status); where.push(`q.status = $${params.length}`); }
  if (filters.lockerApplicationId) { params.push(filters.lockerApplicationId); where.push(`q.lockerhub_application_id = $${params.length}`); }
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT q.*, c.full_name AS customer_name, c.customer_code
       FROM locker_cheques q LEFT JOIN customers c ON c.id = q.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (q.status = 'Pending') DESC, q.received_on DESC, q.id DESC
      LIMIT 500`, params)).rows;
  return { rows: rows.map(shape), note: SETTLEMENT_NOTE };
}

/** Money landed in the bank — releases NCD's hold only. */
export async function clearCheque(db: Db, actor: AuthUser, id: number, input: { clearedOn: string; reference?: string | null }) {
  return settle(db, actor, id, 'Cleared', { clearedOn: input.clearedOn, reference: input.reference ?? null });
}

/** Cheque bounced / withdrawn — frees the leg so a fresh one can be recorded. */
export async function bounceCheque(db: Db, actor: AuthUser, id: number, reason: string) {
  if (!reason || reason.trim().length < 2) throw errors.badRequest('A reason is required');
  return settle(db, actor, id, 'Bounced', { reason: reason.trim() });
}

async function settle(
  db: Db, actor: AuthUser, id: number, status: 'Cleared' | 'Bounced',
  extra: { clearedOn?: string; reference?: string | null; reason?: string },
) {
  const cur = (await db.query<Record<string, unknown>>('SELECT * FROM locker_cheques WHERE id = $1', [id])).rows[0];
  if (!cur) throw errors.notFound('Cheque not found');
  if (cur.status !== 'Pending') throw errors.conflict(`This cheque is already ${String(cur.status).toLowerCase()}`);

  return db.withTx(async (tx) => {
    const row = (await tx.query<Record<string, unknown>>(
      `UPDATE locker_cheques
          SET status = $1, cleared_on = $2, reference = COALESCE($3, reference),
              notes = COALESCE($4, notes), settled_by_user_id = $5, updated_at = now()
        WHERE id = $6 RETURNING *`,
      [status, status === 'Cleared' ? (extra.clearedOn ?? null) : null, extra.reference ?? null,
       extra.reason ?? null, actor.id, id])).rows[0]!;
    await writeAudit(tx, {
      actorId: actor.id, action: `locker.cheque.${status.toLowerCase()}`, entityType: 'locker_cheques', entityId: id,
      before: { status: cur.status }, after: { status, ...extra },
    });
    return { cheque: shape(row), note: SETTLEMENT_NOTE };
  });
}
