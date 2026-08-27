/**
 * Super-admin delete/archive of customers & investments (owner spec 2026-07-21).
 *
 * Two levels, both super_admin-only (customers:delete / applications:delete):
 *  - ARCHIVE  — reversible. Sets archived_at; the record drops out of the book,
 *    dashboard, reports and default lists but is fully recoverable (unarchive).
 *  - HARD DELETE — irreversible purge of the row and everything hanging off it.
 *    A full snapshot is written to audit_log first. Allowed even when money has
 *    moved (paid redemption / paid incentive) — the caller confirms in the UI.
 *
 * Cascade note: application_lines, collections, disbursement_schedule,
 * incentive_accruals and digio_esign_sessions have ON DELETE CASCADE, so they
 * go automatically. The tables below reference applications/customers WITHOUT
 * cascade, so we clear them explicitly (in FK-safe order) inside one tx.
 *
 * A hard delete FORCE deletes (owner 2026-08-27): it must succeed whatever the
 * customer has — investments, lockers, anything. It used to abort instead. The
 * explicit clears below are followed by clearRemainingRefs(), which sweeps up
 * any reference they don't name, so the button cannot start failing again the
 * next time a table is added. That is not hypothetical: locker_authorised_users
 * was added in August and broke a production delete in September.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { writeAudit } from '../../lib/audit.js';
import { errors } from '../../lib/errors.js';

/**
 * Force-delete support (owner 2026-08-27: "it should force delete regardless of
 * if they are having any investments or lockers").
 *
 * Clear every remaining reference to `id` so the DELETE cannot be blocked. The
 * references are discovered from the catalogue, NOT hardcoded — the hardcoded
 * list this replaces silently rotted: `locker_authorised_users` was added in
 * August, nobody added it here, and a production delete failed on it in
 * September. Anything added in future is handled the day it appears.
 *
 * Per column: NULLABLE -> SET NULL, so a record owned by another subsystem
 * survives the purge (an escrow bank-statement line stays on the books, merely
 * unmatched). NOT NULL -> the row cannot exist without its parent, so it goes.
 *
 * Returns what it touched, so the audit snapshot shows exactly what a force
 * delete swept up rather than it happening invisibly.
 */
async function clearRemainingRefs(
  tx: Db, parentTable: string, id: number, skipTables: string[] = [],
): Promise<Record<string, number>> {
  const { rows } = await tx.query<{ table_name: string; column_name: string; is_nullable: string }>(
    `SELECT tc.table_name, kcu.column_name, c.is_nullable
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu   ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc  ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.columns c
         ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = $1 AND ccu.column_name = 'id'
        AND rc.delete_rule IN ('NO ACTION', 'RESTRICT')`, [parentTable]);

  const cleared: Record<string, number> = {};
  for (const r of rows) {
    if (skipTables.includes(r.table_name)) continue;
    // Identifiers come from the catalogue, never from user input, but they are
    // still quoted rather than interpolated bare.
    const t = `"${r.table_name}"`, col = `"${r.column_name}"`;
    const res = r.is_nullable === 'YES'
      ? await tx.query(`UPDATE ${t} SET ${col} = NULL WHERE ${col} = $1`, [id])
      : await tx.query(`DELETE FROM ${t} WHERE ${col} = $1`, [id]);
    const n = Number(res.rowCount ?? 0);
    if (n > 0) cleared[`${r.table_name}.${r.column_name}`] = n;
  }
  return cleared;
}

/** Delete an application's non-cascading dependents. Caller supplies the tx. */
async function deleteAppDependents(tx: Db, appId: number): Promise<void> {
  await tx.query('DELETE FROM redemptions WHERE application_id = $1', [appId]);
  await tx.query('DELETE FROM incentive_payouts WHERE application_id = $1', [appId]);
  await tx.query('DELETE FROM rollovers WHERE from_application_id = $1 OR to_application_id = $1', [appId]);
  await tx.query('DELETE FROM ncd_transfers WHERE application_id = $1', [appId]);
  await tx.query('DELETE FROM ncd_transformations WHERE application_id = $1', [appId]);
  await tx.query("DELETE FROM approval_requests WHERE entity_type = 'application' AND entity_id = $1", [String(appId)]);
}

// ── Applications ─────────────────────────────────────────────────────────
export async function hardDeleteApplication(db: Db, actor: AuthUser, appId: number, reason: string) {
  return db.withTx(async (tx) => {
    const app = (await tx.query('SELECT * FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    await deleteAppDependents(tx, appId);
    // Anything referencing this application that the list above doesn't know about.
    const cleared = await clearRemainingRefs(tx, 'applications', appId);
    // Snapshot BEFORE the row goes, and record what the force-delete swept up,
    // so the sweep is visible in the audit trail rather than silent.
    await writeAudit(tx, {
      actorId: actor.id, action: 'application.hard_delete', entityType: 'applications', entityId: appId,
      before: { application: app, reason }, after: { cleared },
    });
    // Cascades application_lines, collections, disbursement_schedule, incentive_accruals, esign.
    await tx.query('DELETE FROM applications WHERE id = $1', [appId]);
    return { ok: true, application_no: app.application_no, cleared };
  });
}

export async function setApplicationArchived(db: Db, actor: AuthUser, appId: number, archived: boolean, reason?: string) {
  const app = (await db.query('SELECT id, application_no, archived_at FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  await db.query(
    `UPDATE applications SET archived_at = $1, archived_by = $2, archived_reason = $3, updated_at = now() WHERE id = $4`,
    [archived ? new Date().toISOString() : null, archived ? actor.id : null, archived ? (reason ?? null) : null, appId]
  );
  await writeAudit(db, {
    actorId: actor.id, action: archived ? 'application.archive' : 'application.unarchive',
    entityType: 'applications', entityId: appId, after: { reason: reason ?? null },
  });
  return { ok: true };
}

// ── Customers ────────────────────────────────────────────────────────────
export async function hardDeleteCustomer(db: Db, actor: AuthUser, custId: number, reason: string) {
  return db.withTx(async (tx) => {
    const cust = (await tx.query('SELECT * FROM customers WHERE id = $1', [custId])).rows[0];
    if (!cust) throw errors.notFound('Customer not found');
    const apps = (await tx.query('SELECT id, application_no FROM applications WHERE customer_id = $1', [custId])).rows;
    for (const a of apps) {
      await deleteAppDependents(tx, Number(a.id));
      await tx.query('DELETE FROM applications WHERE id = $1', [Number(a.id)]);
    }
    // Customer-level non-cascading references.
    await tx.query('DELETE FROM ncd_transfers WHERE from_customer_id = $1 OR to_customer_id = $1', [custId]);
    await tx.query('DELETE FROM ncd_transformations WHERE deceased_customer_id = $1 OR nominee_customer_id = $1', [custId]);
    await tx.query('UPDATE investor_leads SET converted_customer_id = NULL WHERE converted_customer_id = $1', [custId]);
    await tx.query("DELETE FROM approval_requests WHERE entity_type = 'customer' AND entity_id = $1", [String(custId)]);
    // Everything else still pointing at this customer — locker authorised users,
    // locker deposit waivers, escrow matches, and whatever gets added next.
    // `applications` is skipped: handled above, with its own dependents.
    const cleared = await clearRemainingRefs(tx, 'customers', custId, ['applications']);
    // Snapshot BEFORE the row goes, and record what the force-delete swept up.
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.hard_delete', entityType: 'customers', entityId: custId,
      before: { customer: cust, applications: apps, reason }, after: { cleared },
    });
    // Cascades bank accounts, nominees, joint holders, documents, change requests, portal rows.
    await tx.query('DELETE FROM customers WHERE id = $1', [custId]);
    return { ok: true, customer_code: cust.customer_code, applications_deleted: apps.length, cleared };
  });
}

export async function setCustomerArchived(db: Db, actor: AuthUser, custId: number, archived: boolean, reason?: string) {
  return db.withTx(async (tx) => {
    const cust = (await tx.query('SELECT id, customer_code FROM customers WHERE id = $1', [custId])).rows[0];
    if (!cust) throw errors.notFound('Customer not found');
    const at = archived ? new Date().toISOString() : null;
    await tx.query(
      `UPDATE customers SET archived_at = $1, archived_by = $2, archived_reason = $3, updated_at = now() WHERE id = $4`,
      [at, archived ? actor.id : null, archived ? (reason ?? null) : null, custId]
    );
    // Archiving a customer archives their investments too, so the book/lists hide
    // the whole record. Unarchiving reverses both.
    await tx.query(
      `UPDATE applications SET archived_at = $1, archived_by = $2, archived_reason = $3, updated_at = now() WHERE customer_id = $4`,
      [at, archived ? actor.id : null, archived ? (reason ?? 'customer archived') : null, custId]
    );
    await writeAudit(tx, {
      actorId: actor.id, action: archived ? 'customer.archive' : 'customer.unarchive',
      entityType: 'customers', entityId: custId, after: { reason: reason ?? null },
    });
    return { ok: true };
  });
}
