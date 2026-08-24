/**
 * Rent paid offline (owner 2026-08-22). Staff record a payment — method (cheque
 * or transfer) + reference — and it is marked PAID only when an Admin/CXO
 * approves, at which point it settles on LockerHub (§A18). Until then the rent
 * reads "yet to be paid", but the locker can be allotted regardless.
 *
 * Approve first, settle second — like the cheque register and the fee waivers:
 * the approval stands on its own, and a LockerHub outage leaves the row Approved
 * with the error recorded and retryable (§A18 is idempotent), never rolled back.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import * as lh from '../../integrations/lockerhub/client.js';

export type PayMethod = 'cheque' | 'transfer';
export type PayLeg = 'rent' | 'deposit';

const shape = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  lockerhub_application_id: r.lockerhub_application_id as string,
  leg: r.leg as string,
  method: r.method as string,
  reference: (r.reference as string) ?? null,
  amount: r.amount == null ? null : Number(r.amount),
  status: r.status as string,
  lockerhub_settled: r.lockerhub_settled_at != null,
  lockerhub_error: (r.lockerhub_error as string) ?? null,
  created_at: r.created_at ?? null,
});

export async function listOfflinePayments(db: Db, applicationId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, lockerhub_application_id, leg, method, reference, amount, status,
            lockerhub_settled_at, lockerhub_error, created_at
       FROM locker_offline_payments
      WHERE lockerhub_application_id = $1 AND status <> 'Rejected'
      ORDER BY id DESC`, [applicationId]);
  return rows.map(shape);
}

/** Record an offline rent payment; it goes to Admin/CXO and settles on approval. */
export async function recordOfflinePayment(
  db: Db, actor: AuthUser,
  input: { lockerhub_application_id: string; leg?: PayLeg; method: PayMethod; reference?: string | null; amount?: number | null },
) {
  const appId = String(input.lockerhub_application_id ?? '').trim();
  if (!appId) throw errors.badRequest('lockerhub_application_id is required');
  const leg: PayLeg = input.leg ?? 'rent';
  if (input.method !== 'cheque' && input.method !== 'transfer') throw errors.badRequest('Choose a payment method — cheque or transfer.');
  const reference = String(input.reference ?? '').trim();
  if (reference.length < 2) throw errors.badRequest('Enter the payment reference (cheque number, or the bank/UTR reference).');

  return db.withTx(async (tx) => {
    const open = (await tx.query(
      `SELECT 1 FROM locker_offline_payments WHERE lockerhub_application_id = $1 AND leg = $2 AND status = 'PendingApproval'`,
      [appId, leg])).rowCount;
    if (open) throw errors.conflict(`A ${leg} payment is already awaiting approval on this application.`);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO locker_offline_payments (lockerhub_application_id, leg, method, reference, amount, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [appId, leg, input.method, reference, input.amount ?? null, actor.id]);
    const id = Number(rows[0]!.id);

    const req = await createApprovalRequest(tx, {
      type: 'locker_offline_payment', entityType: 'locker_offline_payments', entityId: id, makerUserId: actor.id,
      metadata: { payment_id: id, lockerhub_application_id: appId, leg, method: input.method, reference, amount: input.amount ?? null },
    });
    await tx.query('UPDATE locker_offline_payments SET approval_request_id = $1 WHERE id = $2', [req.id, id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.offline_payment.record', entityType: 'locker_offline_payments', entityId: id,
      after: { application: appId, leg, method: input.method, reference, amount: input.amount ?? null },
    });
    return { id, request_id: req.id, request_no: req.request_no, status: 'PendingApproval' as const };
  });
}

/** Settle an approved payment on LockerHub (§A18). Never throws — a their-side
 *  failure is stored on the row and retryable. */
async function settleOnLockerHub(db: Db, approver: { id: number; full_name: string; email: string; role: string }, row: ReturnType<typeof shape>) {
  const staff: lh.ActingStaff = { id: approver.id, name: approver.full_name, email: approver.email, staff_role: approver.role };
  try {
    await lh.settleOffline(staff, row.lockerhub_application_id, {
      leg: row.leg as PayLeg, method: row.method as PayMethod, reference: row.reference ?? undefined,
      received_on: new Date().toISOString().slice(0, 10),
    });
    await db.query('UPDATE locker_offline_payments SET lockerhub_settled_at = now(), lockerhub_error = NULL, updated_at = now() WHERE id = $1', [row.id]);
    return { settled: true as const };
  } catch (e) {
    const msg = (e as Error).message || 'LockerHub did not accept the settlement';
    await db.query('UPDATE locker_offline_payments SET lockerhub_error = $1, updated_at = now() WHERE id = $2', [msg.slice(0, 500), row.id]);
    return { settled: false as const, error: msg };
  }
}

registerOnFinalApprove('locker_offline_payment', async (tx, req) => {
  const id = req.metadata.payment_id ? Number(req.metadata.payment_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  const act = (await tx.query<{ approver_user_id: string }>(
    `SELECT approver_user_id FROM approval_actions WHERE approval_request_id = $1 AND action = 'approve' ORDER BY id DESC LIMIT 1`,
    [req.id])).rows[0];
  const row = (await tx.query<Record<string, unknown>>(
    `UPDATE locker_offline_payments SET status = 'Approved', settled_by_user_id = $1, approval_request_id = NULL, updated_at = now()
      WHERE id = $2 AND status = 'PendingApproval' AND approval_request_id = $3 RETURNING *`,
    [act?.approver_user_id ?? null, id, req.id])).rows[0];
  if (!row) return; // already handled / cancelled
  await writeAudit(tx, { actorId: act?.approver_user_id ? Number(act.approver_user_id) : null, action: 'locker.offline_payment.approved', entityType: 'locker_offline_payments', entityId: id, after: { via: 'approval', request_id: req.id } });
  const approver = (await tx.query<{ id: string; full_name: string; email: string; role: string }>(
    'SELECT u.id, u.full_name, u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1',
    [row.settled_by_user_id])).rows[0];
  await settleOnLockerHub(tx, {
    id: Number(approver?.id ?? 0), full_name: approver?.full_name ?? 'NCD checker',
    email: approver?.email ?? '', role: approver?.role ?? 'admin',
  }, shape(row));
});

registerOnReject('locker_offline_payment', async (tx, req) => {
  const id = req.metadata.payment_id ? Number(req.metadata.payment_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE locker_offline_payments SET status = 'Rejected', approval_request_id = NULL, updated_at = now() WHERE id = $1 AND approval_request_id = $2", [id, req.id]);
});

/** Re-send an approved payment LockerHub didn't accept. Idempotent (§A18). */
export async function retryOfflineSettlement(db: Db, actor: AuthUser, id: number) {
  const row = (await db.query<Record<string, unknown>>('SELECT * FROM locker_offline_payments WHERE id = $1', [id])).rows[0];
  if (!row) throw errors.notFound('Payment not found');
  if (row.status !== 'Approved') throw errors.conflict('Only an approved payment can be settled.');
  if (row.lockerhub_settled_at) return { settled: true as const };
  return settleOnLockerHub(db, { id: actor.id, full_name: actor.fullName, email: actor.email, role: actor.role }, shape(row));
}
