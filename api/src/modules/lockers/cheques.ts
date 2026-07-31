/**
 * Locker cheque register (NCD side only).
 *
 * High-value customers hand over cheques and expect the locker opened. This
 * records the instrument, tracks its clearance, and — since 2026-07-29 —
 * SETTLES the leg on LockerHub when it clears.
 *
 * That last part was impossible until now: contract v1.2 had retired A10
 * record-payment (400 `online_only`), so clearing a cheque released NCD's own
 * hold and nothing else, and a staff member had to open LockerHub and mark the
 * row paid by hand. §A18 settle-offline replaced it, correctly typed as an
 * offline receipt rather than a synthetic online row.
 *
 * TAKING a cheque still settles nothing — only CLEARING does. A cheque in hand
 * is not money in the bank, and telling LockerHub otherwise would allot a
 * locker against paper that may yet bounce.
 *
 * The clear and the settle are two systems, so the settle can fail on its own.
 * The local clear is never rolled back for that — the money did clear — but the
 * failure is recorded on the row and surfaced, because a cleared cheque whose
 * leg never settled is exactly the thing that otherwise goes unnoticed. Their
 * endpoint is idempotent, so a retry is always safe.
 *
 * Never route a cheque customer to the A9 payment link to "finish" it: that is
 * a live payment page, so it would take a SECOND real payment for money we
 * already hold — double collection, a refund owed, MDR on our own funds, and a
 * receipt telling the customer they paid online. LockerHub confirmed this
 * explicitly (2026-07-22).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { toISODate } from '../../lib/dates.js';
import * as lh from '../../integrations/lockerhub/client.js';

export type ChequeLeg = 'rent' | 'deposit';

/** Taking a cheque settles nothing — clearing it does. */
export const SETTLEMENT_NOTE =
  'Recorded in NCD. The locker leg settles on LockerHub when you mark this cheque cleared — not now, because a cheque in hand can still bounce. '
  + 'Do NOT open the payment link for a cheque customer: it is a live payment page and would take a SECOND real payment for money you already hold.';

/** Said when the clear settled the leg on their side too. */
export const SETTLED_NOTE =
  'Cheque cleared and the locker leg is settled on LockerHub. Once both legs are settled the application is ready to allot.';

/** Said when the money cleared here but their side did not take it. */
export const SETTLE_FAILED_NOTE =
  'Cheque cleared in NCD, but LockerHub did NOT accept the settlement — the locker leg is still outstanding and the locker will not allot. '
  + 'Use "Retry settlement" on the cheque; it is safe to repeat.';

export interface RecordChequeInput {
  lockerApplicationId: string;
  customerId?: number | null;
  /** Name/phone known at the moment of recording — carried when there's no
   * customerId to join against (see migration 042). */
  applicantName?: string | null;
  applicantPhone?: string | null;
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
  /** When the leg was settled on LockerHub. NULL on a Cleared cheque means the
   *  money is in but their leg is still open — the row someone must chase. */
  lockerhub_settled_at: r.lockerhub_settled_at ?? null,
  lockerhub_error: r.lockerhub_error ?? null,
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
      `INSERT INTO locker_cheques (lockerhub_application_id, customer_id, applicant_name, applicant_phone, leg, amount, cheque_no, bank_name, received_on, notes, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [appId, input.customerId ?? null, input.applicantName?.trim() || null, input.applicantPhone?.trim() || null,
       input.leg, input.amount, chequeNo, input.bankName ?? null, input.receivedOn, input.notes ?? null, actor.id])).rows[0]!;
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
    `SELECT q.*, COALESCE(c.full_name, q.applicant_name) AS customer_name, c.customer_code
       FROM locker_cheques q LEFT JOIN customers c ON c.id = q.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (q.status = 'Pending') DESC, q.received_on DESC, q.id DESC
      LIMIT 500`, params)).rows;

  // Rows recorded before migration 042 (or before the frontend started sending
  // a name) have neither customer_id nor a snapshot — resolve those against
  // LockerHub once and cache the answer on the row so this never repeats.
  // Bounded concurrency + per-row try/catch: this is a staff screen showing at
  // most a handful of pending cheques, not a hot path, and a LockerHub outage
  // must degrade to a blank name, not fail the whole register.
  const blank = rows.filter((r) => !r.customer_id && !r.customer_name);
  if (blank.length && lh.lockerHubConfigured()) {
    const CHUNK = 6;
    for (let i = 0; i < blank.length; i += CHUNK) {
      const slice = blank.slice(i, i + CHUNK);
      await Promise.all(slice.map(async (r) => {
        try {
          const a = await lh.getLockerApplication(String(r.lockerhub_application_id)) as Record<string, unknown>;
          const applicantName = (a?.name as string | null) ?? null;
          const applicantPhone = (a?.phone as string | null) ?? null;
          if (!applicantName) return;
          await db.query(
            'UPDATE locker_cheques SET applicant_name = $1, applicant_phone = $2 WHERE id = $3',
            [applicantName, applicantPhone, r.id]);
          r.customer_name = applicantName;
        } catch { /* LockerHub unreachable/unknown id — leave the row blank */ }
      }));
    }
  }

  return { rows: rows.map(shape), note: SETTLEMENT_NOTE };
}

/** Money landed in the bank — releases NCD's hold only. */
export async function clearCheque(db: Db, actor: AuthUser, id: number, input: { clearedOn: string; reference?: string | null }) {
  const cleared = await settle(db, actor, id, 'Cleared', { clearedOn: input.clearedOn, reference: input.reference ?? null });
  // Settle AFTER the local commit, never inside it: an open HTTP call in a
  // transaction holds a row lock for the length of someone else's outage, and
  // rolling the clear back would be wrong anyway — the money did clear.
  return settleOnLockerHub(db, actor, cleared.cheque);
}

/**
 * Push a cleared cheque to LockerHub (§A18) and record what happened.
 *
 * Never throws for a their-side failure: the cheque is cleared either way, and
 * an exception here would tell the operator the clearance failed when it did
 * not. The outcome is written to the row and returned instead.
 */
async function settleOnLockerHub(db: Db, actor: AuthUser, cheque: ReturnType<typeof shape>) {
  // Same shape routes.ts sends on every other Part A write — their audit log
  // shows the real person, not "NCD".
  const staff: lh.ActingStaff = { id: actor.id, name: actor.fullName, email: actor.email, staff_role: actor.role };
  try {
    await lh.settleOffline(staff, String(cheque.lockerhub_application_id), {
      leg: cheque.leg as ChequeLeg,
      method: 'cheque',
      // Their reference, ours as the fallback — a bank ref identifies the money
      // better than our cheque number, but the cheque number always exists.
      reference: String(cheque.reference || cheque.cheque_no),
      ...(cheque.cleared_on ? { received_on: cheque.cleared_on } : {}),
    });
    const row = (await db.query<Record<string, unknown>>(
      'UPDATE locker_cheques SET lockerhub_settled_at = now(), lockerhub_error = NULL WHERE id = $1 RETURNING *',
      [cheque.id])).rows[0]!;
    return { cheque: shape(row), settled: true, note: SETTLED_NOTE };
  } catch (e) {
    const msg = (e as Error).message || 'LockerHub did not accept the settlement';
    const row = (await db.query<Record<string, unknown>>(
      'UPDATE locker_cheques SET lockerhub_error = $1 WHERE id = $2 RETURNING *',
      [msg.slice(0, 500), cheque.id])).rows[0]!;
    return { cheque: shape(row), settled: false, note: SETTLE_FAILED_NOTE, error: msg };
  }
}

/**
 * Retry a settlement that failed after the cheque cleared. Safe to repeat —
 * §A18 is idempotent on their side — and refuses on a cheque that never
 * cleared, so it can't be used to settle a leg against paper still in hand.
 */
export async function retrySettlement(db: Db, actor: AuthUser, id: number) {
  const cur = (await db.query<Record<string, unknown>>('SELECT * FROM locker_cheques WHERE id = $1', [id])).rows[0];
  if (!cur) throw errors.notFound('Cheque not found');
  if (cur.status !== 'Cleared') throw errors.conflict('Only a cleared cheque can settle a locker leg.');
  if (cur.lockerhub_settled_at) return { cheque: shape(cur), settled: true, note: SETTLED_NOTE };
  return settleOnLockerHub(db, actor, shape(cur));
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
