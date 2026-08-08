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
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';

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
  /** The open cheque-clearance approval, if this cheque has been submitted for
   *  one. Pending + set = awaiting a checker; Pending + NULL = not yet sent. */
  approval_request_id: r.approval_request_id == null ? null : Number(r.approval_request_id),
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

/**
 * Maker step: "funds cleared". This no longer clears the cheque directly — it
 * raises a `locker_cheque_clearance` approval (owner 2026-08-07). The cheque
 * stays Pending, now carrying the open approval; an Admin/CXO checker approves
 * it, and only THEN does it clear and settle on LockerHub (see the handler
 * below). Clearing real money against paper that could bounce is the control
 * the checker exists for.
 */
export async function requestClearance(db: Db, actor: AuthUser, id: number, input: { clearedOn: string; reference?: string | null }) {
  const cur = (await db.query<Record<string, unknown>>('SELECT * FROM locker_cheques WHERE id = $1', [id])).rows[0];
  if (!cur) throw errors.notFound('Cheque not found');
  if (cur.status !== 'Pending') throw errors.conflict(`This cheque is already ${String(cur.status).toLowerCase()}`);
  if (cur.approval_request_id) throw errors.conflict('This cheque is already awaiting clearance approval.');
  if (!input.clearedOn) throw errors.badRequest('A cleared-on date is required');

  return db.withTx(async (tx) => {
    const req = await createApprovalRequest(tx, {
      type: 'locker_cheque_clearance', entityType: 'locker_cheques', entityId: id, makerUserId: actor.id,
      metadata: {
        cheque_id: id,
        locker_application: cur.lockerhub_application_id,
        leg: cur.leg, amount: Number(cur.amount), cheque_no: cur.cheque_no, bank_name: cur.bank_name ?? null,
        cleared_on: input.clearedOn, reference: input.reference ?? null,
        applicant_name: cur.applicant_name ?? null,
      },
    });
    const row = (await tx.query<Record<string, unknown>>(
      'UPDATE locker_cheques SET approval_request_id = $1, updated_at = now() WHERE id = $2 RETURNING *', [req.id, id])).rows[0]!;
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.cheque.clearance_request', entityType: 'locker_cheques', entityId: id,
      after: { approval_request_id: req.id, cleared_on: input.clearedOn, reference: input.reference ?? null },
    });
    return { cheque: shape(row), request_id: req.id, request_no: req.request_no, status: 'PendingClearanceApproval' as const };
  });
}

/** On approval: clear the cheque and settle the leg on LockerHub. Runs inside the
 *  approval transaction — the LockerHub push tolerates failure (records the error,
 *  never rolls back the decision), matching the fee-waiver flow. */
registerOnFinalApprove('locker_cheque_clearance', async (tx, req) => {
  const id = req.metadata.cheque_id ? Number(req.metadata.cheque_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  // ApprovalRow carries the maker; the approver is the latest approve action.
  const act = (await tx.query<{ approver_user_id: string }>(
    `SELECT approver_user_id FROM approval_actions WHERE approval_request_id = $1 AND action = 'approve' ORDER BY id DESC LIMIT 1`,
    [req.id])).rows[0];
  const clearedOn = (req.metadata.cleared_on as string | null) ?? null;
  const reference = (req.metadata.reference as string | null) ?? null;
  const row = (await tx.query<Record<string, unknown>>(
    `UPDATE locker_cheques
        SET status = 'Cleared', cleared_on = $1, reference = COALESCE($2, reference),
            settled_by_user_id = $3, approval_request_id = NULL, updated_at = now()
      WHERE id = $4 AND status = 'Pending' AND approval_request_id = $5 RETURNING *`,
    [clearedOn, reference, act?.approver_user_id ?? null, id, req.id])).rows[0];
  if (!row) return; // already handled / cancelled
  await writeAudit(tx, { actorId: act?.approver_user_id ? Number(act.approver_user_id) : null, action: 'locker.cheque.cleared', entityType: 'locker_cheques', entityId: id, after: { via: 'approval', request_id: req.id } });
  // Settle the leg on LockerHub (§A18). tx is a Db, so this runs in the same
  // transaction; it never throws — a their-side failure is recorded on the row
  // and retryable, exactly as before.
  const approver = (await tx.query<{ id: string; full_name: string; email: string; role: string }>(
    'SELECT u.id, u.full_name, u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1',
    [row.settled_by_user_id])).rows[0];
  await settleOnLockerHub(tx, {
    id: Number(approver?.id ?? 0), fullName: approver?.full_name ?? 'NCD checker',
    email: approver?.email ?? '', role: (approver?.role ?? 'admin') as AuthUser['role'],
  } as AuthUser, shape(row));
});

/** On rejection: drop the open approval; the cheque stays Pending (re-submit or bounce). */
registerOnReject('locker_cheque_clearance', async (tx, req) => {
  const id = req.metadata.cheque_id ? Number(req.metadata.cheque_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query('UPDATE locker_cheques SET approval_request_id = NULL, updated_at = now() WHERE id = $1 AND approval_request_id = $2', [id, req.id]);
});

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
