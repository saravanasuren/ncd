/**
 * Locker deposit waivers / exceptions (owner 2026-07-24).
 *
 * Some tenants hold a locker with NO NCD backing because the deposit
 * requirement was waived as a deliberate exception. This records that fact so
 * the Locker Tenants roster can say so, instead of leaving those rows
 * indistinguishable from ordinary online-paid tenants.
 *
 * Maker: NCD Manager+ (lockers:waive), with a mandatory reason.
 * Checker: Admin/CXO in the approvals queue (locker_deposit_waiver).
 * Purely informational — nothing settles on LockerHub's side.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';

export interface CreateWaiverInput {
  lockerhub_tenant_id: string;
  reason: string;
  locker_no?: string | null;
  branch_id?: string | null;
  tenant_name?: string | null;
  tenant_phone?: string | null;
  customer_id?: number | null;
}

export async function createWaiver(db: Db, actor: AuthUser, input: CreateWaiverInput) {
  return db.withTx(async (tx) => {
    const open = (await tx.query(
      `SELECT 1 FROM locker_deposit_waivers
        WHERE lockerhub_tenant_id = $1 AND status IN ('PendingApproval','Approved')`,
      [input.lockerhub_tenant_id])).rowCount;
    if (open) throw errors.conflict('This tenancy already has a waiver recorded (pending or approved).');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO locker_deposit_waivers
         (lockerhub_tenant_id, locker_no, branch_id, tenant_name, tenant_phone, customer_id, reason, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.lockerhub_tenant_id, input.locker_no ?? null, input.branch_id ?? null,
       input.tenant_name ?? null, input.tenant_phone ?? null, input.customer_id ?? null,
       input.reason.trim(), actor.id]);
    const id = Number(rows[0]!.id);

    const req = await createApprovalRequest(tx, {
      type: 'locker_deposit_waiver', entityType: 'locker_deposit_waivers', entityId: id, makerUserId: actor.id,
      metadata: {
        waiver_id: id, lockerhub_tenant_id: input.lockerhub_tenant_id,
        tenant_name: input.tenant_name ?? null, locker_no: input.locker_no ?? null,
        reason: input.reason.trim(),
      },
    });
    await tx.query('UPDATE locker_deposit_waivers SET approval_request_id = $1 WHERE id = $2', [req.id, id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.waiver.create', entityType: 'locker_deposit_waivers', entityId: id,
      after: { tenant: input.tenant_name, locker: input.locker_no, reason: input.reason.trim() },
    });
    return { id, request_id: req.id, request_no: req.request_no, status: 'PendingApproval' };
  });
}

registerOnFinalApprove('locker_deposit_waiver', async (tx, req) => {
  const id = req.metadata.waiver_id ? Number(req.metadata.waiver_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE locker_deposit_waivers SET status = 'Approved', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [id]);
});

registerOnReject('locker_deposit_waiver', async (tx, req) => {
  const id = req.metadata.waiver_id ? Number(req.metadata.waiver_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE locker_deposit_waivers SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [id]);
});

/** Open waivers (pending + approved), keyed for the roster overlay. */
export async function openWaivers(db: Db): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT w.id, w.lockerhub_tenant_id, w.locker_no, w.branch_id, w.tenant_name, w.tenant_phone,
            w.customer_id, w.reason, w.status, u.full_name AS created_by, w.created_at,
            c.customer_code
       FROM locker_deposit_waivers w
       LEFT JOIN users u ON u.id = w.created_by_user_id
       LEFT JOIN customers c ON c.id = w.customer_id
      WHERE w.status IN ('PendingApproval','Approved')
      ORDER BY w.id DESC`);
  return rows.map((r) => ({ ...r, id: Number(r.id), customer_id: r.customer_id != null ? Number(r.customer_id) : null }));
}

/** Withdraw an open waiver. Rejected/cancelled ones are history. */
export async function cancelWaiver(db: Db, actor: AuthUser, id: number) {
  return db.withTx(async (tx) => {
    const r = (await tx.query<Record<string, unknown>>(
      'SELECT id, status, approval_request_id FROM locker_deposit_waivers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw errors.notFound('Waiver not found');
    if (r.status !== 'PendingApproval' && r.status !== 'Approved') {
      throw errors.conflict(`This waiver is ${r.status} — it can no longer be cancelled.`);
    }
    await tx.query("UPDATE locker_deposit_waivers SET status = 'Cancelled', updated_at = now() WHERE id = $1", [id]);
    if (r.approval_request_id) {
      await tx.query("UPDATE approval_requests SET status = 'Cancelled' WHERE id = $1 AND status = 'Pending'", [Number(r.approval_request_id)]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'locker.waiver.cancel', entityType: 'locker_deposit_waivers', entityId: id, after: { from_status: r.status } });
    return { ok: true };
  });
}
