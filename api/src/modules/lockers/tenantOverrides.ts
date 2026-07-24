/**
 * NCD-side overrides on LockerHub's tenant roster (owner 2026-07-24).
 *
 *  · linkTenant   — attach a roster tenant to an NCD customer by hand, because
 *                   automatic matching needs phone + a FULL name agreement and
 *                   LockerHub exposes no PAN to settle it (their profile is
 *                   null for these tenants; where present the PAN is masked).
 *  · removeTenant — super_admin hides the row from OUR roster. LockerHub owns
 *                   the tenancy and has no close endpoint, so the locker stays
 *                   allotted on their side; this only affects what NCD shows.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export interface TenantSnapshot {
  tenant_name?: string | null;
  locker_no?: string | null;
  branch_id?: string | null;
}

/** Point a roster tenant at an NCD customer. customerId null clears the link. */
export async function linkTenant(
  db: Db, actor: AuthUser, tenantId: string, customerId: number | null, snap: TenantSnapshot = {},
) {
  if (!tenantId.trim()) throw errors.badRequest('tenant id required');
  return db.withTx(async (tx) => {
    let customer: { customer_code: string; full_name: string } | undefined;
    if (customerId != null) {
      customer = (await tx.query<{ customer_code: string; full_name: string }>(
        'SELECT customer_code, full_name FROM customers WHERE id = $1 AND archived_at IS NULL', [customerId])).rows[0];
      if (!customer) throw errors.notFound('Customer not found');
    }
    await tx.query(
      `INSERT INTO locker_tenant_overrides
         (lockerhub_tenant_id, customer_id, linked_by_user_id, linked_at, tenant_name, locker_no, branch_id)
       VALUES ($1,$2,$3, CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END, $4,$5,$6)
       ON CONFLICT (lockerhub_tenant_id) DO UPDATE
         SET customer_id = EXCLUDED.customer_id,
             linked_by_user_id = EXCLUDED.linked_by_user_id,
             linked_at = EXCLUDED.linked_at,
             tenant_name = COALESCE(EXCLUDED.tenant_name, locker_tenant_overrides.tenant_name),
             locker_no = COALESCE(EXCLUDED.locker_no, locker_tenant_overrides.locker_no),
             branch_id = COALESCE(EXCLUDED.branch_id, locker_tenant_overrides.branch_id),
             updated_at = now()`,
      [tenantId, customerId, actor.id, snap.tenant_name ?? null, snap.locker_no ?? null, snap.branch_id ?? null]);
    await writeAudit(tx, {
      actorId: actor.id, action: customerId == null ? 'locker.tenant.unlink' : 'locker.tenant.link',
      entityType: 'locker_tenant_overrides', entityId: null,
      after: { tenant_id: tenantId, customer_id: customerId, customer: customer?.customer_code ?? null, tenant_name: snap.tenant_name ?? null },
    });
    return { ok: true, tenant_id: tenantId, customer_id: customerId };
  });
}

/** Hide a tenancy from NCD's roster (super_admin). Reason is mandatory. */
export async function removeTenant(
  db: Db, actor: AuthUser, tenantId: string, reason: string, snap: TenantSnapshot = {},
) {
  if (!tenantId.trim()) throw errors.badRequest('tenant id required');
  if (!reason?.trim() || reason.trim().length < 3) throw errors.badRequest('A reason is required');
  return db.withTx(async (tx) => {
    await tx.query(
      `INSERT INTO locker_tenant_overrides
         (lockerhub_tenant_id, removed_at, removed_reason, removed_by_user_id, tenant_name, locker_no, branch_id)
       VALUES ($1, now(), $2, $3, $4, $5, $6)
       ON CONFLICT (lockerhub_tenant_id) DO UPDATE
         SET removed_at = now(), removed_reason = EXCLUDED.removed_reason,
             removed_by_user_id = EXCLUDED.removed_by_user_id,
             tenant_name = COALESCE(EXCLUDED.tenant_name, locker_tenant_overrides.tenant_name),
             locker_no = COALESCE(EXCLUDED.locker_no, locker_tenant_overrides.locker_no),
             branch_id = COALESCE(EXCLUDED.branch_id, locker_tenant_overrides.branch_id),
             updated_at = now()`,
      [tenantId, reason.trim(), actor.id, snap.tenant_name ?? null, snap.locker_no ?? null, snap.branch_id ?? null]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.tenant.remove', entityType: 'locker_tenant_overrides', entityId: null,
      after: { tenant_id: tenantId, reason: reason.trim(), tenant_name: snap.tenant_name ?? null, locker_no: snap.locker_no ?? null,
               note: 'NCD view only — the locker remains allotted on LockerHub' },
    });
    return { ok: true, tenant_id: tenantId };
  });
}

/** Put a removed tenancy back on the roster. */
export async function restoreTenant(db: Db, actor: AuthUser, tenantId: string) {
  return db.withTx(async (tx) => {
    const r = await tx.query(
      `UPDATE locker_tenant_overrides
          SET removed_at = NULL, removed_reason = NULL, removed_by_user_id = NULL, updated_at = now()
        WHERE lockerhub_tenant_id = $1 AND removed_at IS NOT NULL`, [tenantId]);
    if (!r.rowCount) throw errors.notFound('No removed tenancy with that id');
    await writeAudit(tx, { actorId: actor.id, action: 'locker.tenant.restore', entityType: 'locker_tenant_overrides', entityId: null, after: { tenant_id: tenantId } });
    return { ok: true };
  });
}

export async function tenantOverrides(db: Db): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT o.lockerhub_tenant_id, o.customer_id, o.removed_at, o.removed_reason,
            o.tenant_name, o.locker_no, o.branch_id,
            c.customer_code, c.full_name AS customer_name
       FROM locker_tenant_overrides o
       LEFT JOIN customers c ON c.id = o.customer_id`);
  return rows;
}
