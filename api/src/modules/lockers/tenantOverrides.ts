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

/**
 * Hide a locker APPLICATION from NCD's screens — Super Admin only
 * (owner 2026-08-19: "get me delete option only for super admin for deleting
 * any locker applicaation").
 *
 * ⚠️ This does NOT delete anything on LockerHub, and it deliberately does not
 * pretend to. Their contract exposes no delete or cancel for an application at
 * all (checked against LOCKERHUB-INTEGRATION-CONTRACT.md): applications reach
 * `rejected`/`cancelled` on their side only, by their own flows. So the honest
 * scope of a "delete" from here is our own view of it — exactly what
 * removeTenant already does for an allotted tenancy, and the caller is told so
 * in the same words on screen.
 *
 * Keyed on the LockerHub application id. The overrides table is keyed
 * `lockerhub_tenant_id`, and an application that has never been allotted has no
 * tenant id — the existing code already stores an application id in that column
 * for exactly this reason (see overrideKey in deposits.ts), so the two share one
 * mechanism rather than growing a second table that could disagree.
 */
export async function removeLockerApplication(
  db: Db, actor: AuthUser, applicationId: string, reason: string,
  snap: { tenant_name?: string | null; locker_no?: string | null; branch_id?: string | null } = {},
) {
  // Explicit role check rather than a permission: the owner asked for Super
  // Admin specifically, and a permission could later be granted to someone else
  // without anyone revisiting this decision.
  if (actor.role !== 'super_admin') {
    throw errors.forbidden('Only a Super Admin can remove a locker application');
  }
  if (!applicationId.trim()) throw errors.badRequest('application id required');
  if (!reason?.trim() || reason.trim().length < 3) throw errors.badRequest('A reason is required');

  // Cancel it where it actually LIVES first (A23, shipped 2026-08-22 at our
  // request). Until this existed we could only hide the row here, and the owner
  // rightly called that out: "if i delete in here it should get deleted so that
  // while i make a new enrollement the old traces doesnt affect in there".
  //
  // Their side is the source of truth, so it goes first — if they refuse, we
  // must NOT write a local hide that would leave the two disagreeing. Their two
  // refusals are the ones staff need in plain words, not a raw 409.
  const lh = await import('../../integrations/lockerhub/client.js');
  let released: unknown = null;
  try {
    const r = await lh.cancelLockerApplication(
      { id: actor.id, name: actor.fullName, email: actor.email, staff_role: actor.role },
      applicationId.trim(), reason.trim());
    released = r?.locker_released ?? null;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/payment_collected/i.test(msg)) {
      throw errors.conflict('This locker has money already collected against it — cancelling would be a refund, which has to be handled with LockerHub.');
    }
    if (/live_tenancy/i.test(msg)) {
      throw errors.conflict('This application is already a live tenancy — close or surrender the locker instead of cancelling the application.');
    }
    throw errors.upstream(502, `LockerHub would not cancel this application: ${msg.slice(0, 200)}`);
  }

  return db.withTx(async (tx) => {
    await tx.query(
      `INSERT INTO locker_tenant_overrides
         (lockerhub_tenant_id, removed_at, removed_reason, removed_by_user_id, tenant_name, locker_no, branch_id)
       VALUES ($1, now(), $2, $3, $4, $5, $6)
       ON CONFLICT (lockerhub_tenant_id) DO UPDATE
         SET removed_at = now(), removed_reason = EXCLUDED.removed_reason,
             removed_by_user_id = EXCLUDED.removed_by_user_id,
             updated_at = now()`,
      [applicationId.trim(), reason.trim(), actor.id,
       snap.tenant_name ?? null, snap.locker_no ?? null, snap.branch_id ?? null]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.application.remove',
      entityType: 'locker_applications', entityId: applicationId.trim(),
      after: { reason: reason.trim(), cancelled_on_lockerhub: true, locker_released: released,
               note: 'Cancelled on LockerHub via A23, and hidden here so no stale roster read resurfaces it' },
    });
    return { application_id: applicationId.trim(), cancelled: true, locker_released: released };
  });
}
