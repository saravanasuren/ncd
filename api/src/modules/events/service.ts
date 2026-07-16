/**
 * NCD lifecycle events (docs/00 §6): rollover, holder transfer, and
 * transformation (nominee inheritance on death). Each is maker-checker; the
 * lineage change happens in the approval transaction.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { materializeForApplication } from '../schedule/materialize.js';

// ── Rollover ──────────────────────────────────────────────────────────
export async function initiateRollover(db: Db, actor: AuthUser, applicationId: number) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string; total_amount: string }>('SELECT status, total_amount FROM applications WHERE id = $1', [applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active' && app.status !== 'Matured') throw errors.unprocessable('Only Active/Matured investments can roll over');
    const no = await nextCode(tx, 'rollover', 'ROL-{yyyy}-{seq:6}');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO rollovers (rollover_no, from_application_id, amount, status, created_by_user_id) VALUES ($1,$2,$3,'Requested',$4) RETURNING id`,
      [no, applicationId, app.total_amount, actor.id]);
    const rolloverId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, { type: 'rollover', entityType: 'rollovers', entityId: rolloverId, makerUserId: actor.id, metadata: { rollover_id: rolloverId, from_application_id: applicationId, amount: Number(app.total_amount) } });
    await tx.query('UPDATE rollovers SET approval_request_id = $1 WHERE id = $2', [req.id, rolloverId]);
    await writeAudit(tx, { actorId: actor.id, action: 'rollover.initiate', entityType: 'rollovers', entityId: rolloverId });
    return { rollover_id: rolloverId, rollover_no: no, request: req };
  });
}

registerOnFinalApprove('rollover', async (tx, req) => {
  const fromId = Number(req.metadata.from_application_id);
  const from = (await tx.query<Record<string, unknown>>('SELECT * FROM applications WHERE id = $1', [fromId])).rows[0];
  if (!from) return;
  assertTransition('application', String(from.status), 'RolledOver');
  await tx.query("UPDATE applications SET status = 'RolledOver', updated_at = now() WHERE id = $1", [fromId]);
  await tx.query("UPDATE application_lines SET status = 'RolledOver' WHERE application_id = $1 AND status = 'Active'", [fromId]);
  await tx.query("UPDATE disbursement_schedule SET status = 'Skipped' WHERE application_id = $1 AND status = 'Scheduled'", [fromId]);
  // New Active application for the rolled principal, fresh schedule from today.
  const appNo = await nextCode(tx, 'application', 'APP-{yyyy}-{seq:6}');
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, interest_start_date, allotment_date, customer_was_new_at_creation, source, enrolled_by_user_id, enrolled_by_agent_id)
     VALUES ($1,$2,$3,'Active',$4,$5,$5,FALSE,'rollover',$6,$7) RETURNING id`,
    [appNo, from.customer_id, from.series_id, from.total_amount, today, from.enrolled_by_user_id, from.enrolled_by_agent_id]);
  const newId = Number(rows[0]!.id);
  const line = (await tx.query<Record<string, unknown>>('SELECT * FROM application_lines WHERE application_id = $1 ORDER BY id LIMIT 1', [fromId])).rows[0];
  if (line) {
    await tx.query(
      `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active')`,
      [newId, line.scheme_id, line.coupon_rate_pct, line.tenure_months, line.payout_frequency, line.day_count_convention, from.total_amount]);
  }
  await materializeForApplication(tx, newId);
  await tx.query('UPDATE rollovers SET to_application_id = $1, status = $2 WHERE id = $3', [newId, 'Approved', Number(req.metadata.rollover_id)]);
});

// ── Holder transfer ───────────────────────────────────────────────────
export async function initiateTransfer(db: Db, actor: AuthUser, input: { application_id: number; to_customer_id: number; reason: string }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string; customer_id: string }>('SELECT status, customer_id FROM applications WHERE id = $1', [input.application_id])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active') throw errors.unprocessable('Only Active investments can be transferred');
    const to = await tx.query('SELECT 1 FROM customers WHERE id = $1', [input.to_customer_id]);
    if (!to.rowCount) throw errors.badRequest('Target customer not found');
    const no = await nextCode(tx, 'transfer', 'TRF-{yyyy}-{seq:6}');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ncd_transfers (transfer_no, application_id, from_customer_id, to_customer_id, reason, status, created_by_user_id) VALUES ($1,$2,$3,$4,$5,'Requested',$6) RETURNING id`,
      [no, input.application_id, app.customer_id, input.to_customer_id, input.reason, actor.id]);
    const transferId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, { type: 'ncd_transfer', entityType: 'ncd_transfers', entityId: transferId, makerUserId: actor.id, metadata: { transfer_id: transferId, application_id: input.application_id, to_customer_id: input.to_customer_id } });
    await tx.query('UPDATE ncd_transfers SET approval_request_id = $1 WHERE id = $2', [req.id, transferId]);
    return { transfer_id: transferId, transfer_no: no, request: req };
  });
}

registerOnFinalApprove('ncd_transfer', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const toCustomer = Number(req.metadata.to_customer_id);
  await tx.query('UPDATE applications SET customer_id = $1, updated_at = now() WHERE id = $2', [toCustomer, appId]);
  await tx.query('UPDATE ncd_transfers SET status = $1 WHERE id = $2', ['Approved', Number(req.metadata.transfer_id)]);
});

// ── Transformation (death → nominee) ──────────────────────────────────
export async function initiateTransformation(db: Db, actor: AuthUser, input: { application_id: number; nominee_name: string; nominee_customer_id?: number; nominee_bank_name?: string; nominee_account?: string; nominee_ifsc?: string }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string; customer_id: string }>('SELECT status, customer_id FROM applications WHERE id = $1', [input.application_id])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active') throw errors.unprocessable('Only Active investments can be transformed');
    const no = await nextCode(tx, 'transfer', 'TRN-{yyyy}-{seq:6}');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ncd_transformations (transformation_no, application_id, deceased_customer_id, nominee_name, nominee_customer_id, nominee_bank_name, nominee_account, nominee_ifsc, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Requested',$9) RETURNING id`,
      [no, input.application_id, app.customer_id, input.nominee_name, input.nominee_customer_id ?? null, input.nominee_bank_name ?? null, input.nominee_account ?? null, input.nominee_ifsc ?? null, actor.id]);
    const tId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, { type: 'ncd_transformation', entityType: 'ncd_transformations', entityId: tId, makerUserId: actor.id, metadata: { transformation_id: tId, application_id: input.application_id, deceased_customer_id: Number(app.customer_id), nominee_customer_id: input.nominee_customer_id ?? null } });
    await tx.query('UPDATE ncd_transformations SET approval_request_id = $1 WHERE id = $2', [req.id, tId]);
    return { transformation_id: tId, transformation_no: no, request: req };
  });
}

registerOnFinalApprove('ncd_transformation', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const deceased = Number(req.metadata.deceased_customer_id);
  const nomineeCustomer = req.metadata.nominee_customer_id ? Number(req.metadata.nominee_customer_id) : null;
  await tx.query('UPDATE customers SET is_deceased = TRUE, deceased_date = now() WHERE id = $1', [deceased]);
  if (nomineeCustomer) await tx.query('UPDATE applications SET customer_id = $1, updated_at = now() WHERE id = $2', [nomineeCustomer, appId]);
  await tx.query('UPDATE ncd_transformations SET status = $1 WHERE id = $2', ['Approved', Number(req.metadata.transformation_id)]);
});

export async function listEvents(db: Db) {
  const rollovers = (await db.query('SELECT id, rollover_no AS ref, status, created_at FROM rollovers ORDER BY id DESC LIMIT 100')).rows;
  const transfers = (await db.query('SELECT id, transfer_no AS ref, status, created_at FROM ncd_transfers ORDER BY id DESC LIMIT 100')).rows;
  const transformations = (await db.query('SELECT id, transformation_no AS ref, status, created_at FROM ncd_transformations ORDER BY id DESC LIMIT 100')).rows;
  return { rollovers, transfers, transformations };
}
