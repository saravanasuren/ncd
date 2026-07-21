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
 * cascade, so we clear them explicitly (in FK-safe order) inside one tx — if any
 * unenumerated dependent exists, the FK error rolls the whole thing back rather
 * than leaving a half-deleted record.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { writeAudit } from '../../lib/audit.js';
import { errors } from '../../lib/errors.js';

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
    // Snapshot BEFORE deletion so the purge is auditable/traceable.
    await writeAudit(tx, {
      actorId: actor.id, action: 'application.hard_delete', entityType: 'applications', entityId: appId,
      before: { application: app, reason },
    });
    await deleteAppDependents(tx, appId);
    // Cascades application_lines, collections, disbursement_schedule, incentive_accruals, esign.
    await tx.query('DELETE FROM applications WHERE id = $1', [appId]);
    return { ok: true, application_no: app.application_no };
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
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.hard_delete', entityType: 'customers', entityId: custId,
      before: { customer: cust, applications: apps, reason },
    });
    for (const a of apps) {
      await deleteAppDependents(tx, Number(a.id));
      await tx.query('DELETE FROM applications WHERE id = $1', [Number(a.id)]);
    }
    // Customer-level non-cascading references.
    await tx.query('DELETE FROM ncd_transfers WHERE from_customer_id = $1 OR to_customer_id = $1', [custId]);
    await tx.query('DELETE FROM ncd_transformations WHERE deceased_customer_id = $1 OR nominee_customer_id = $1', [custId]);
    await tx.query('UPDATE investor_leads SET converted_customer_id = NULL WHERE converted_customer_id = $1', [custId]);
    await tx.query("DELETE FROM approval_requests WHERE entity_type = 'customer' AND entity_id = $1", [String(custId)]);
    // Cascades bank accounts, nominees, joint holders, documents, change requests, portal rows.
    await tx.query('DELETE FROM customers WHERE id = $1', [custId]);
    return { ok: true, customer_code: cust.customer_code, applications_deleted: apps.length };
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
