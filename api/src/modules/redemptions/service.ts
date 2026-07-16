/**
 * Redemptions (docs/02 §6, docs/17). Flows:
 *  - Customer/app REQUESTS a redemption → 'Requested' record (no approval yet).
 *  - Staff (NCD Manager) SUBMITS a request → 2-level approval (NCD → CXO).
 *  - Staff can initiate + submit in one step (initiatePremature).
 *  - On final approval the application is RELIABLY closed (regression-tested).
 *  - Maturity redemption closes a Matured application at par (no penalty).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { nextCode } from '../../lib/sequences.js';
import { computeRedemption } from '../../lib/redemption.js';
import type { RateSpec } from '../../lib/incentive.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove, type ApprovalRow } from '../approvals/service.js';

async function outstandingPrincipal(db: Db, applicationId: number): Promise<number> {
  return Number((await db.query<{ p: string }>(
    "SELECT COALESCE(sum(outstanding_amount),0) AS p FROM application_lines WHERE application_id = $1 AND status = 'Active'",
    [applicationId]
  )).rows[0]!.p);
}

async function penaltySetting(db: Db): Promise<RateSpec> {
  const s = await getSettingsMap(db);
  return (s['redemption.premature_penalty'] as RateSpec) ?? { mode: 'pct', value: 1.0 };
}

/** Create a 'Requested' redemption record (no approval). Shared by all callers. */
async function createRequest(
  tx: Db,
  input: { applicationId: number; type: 'premature' | 'maturity'; reason: string; source: string; byCustomer: boolean; redemptionDate?: string; createdBy: number | null }
): Promise<{ id: number; redemption_no: string; principal: number; penalty: number; netPayment: number; brokenInterest: number }> {
  const principal = await outstandingPrincipal(tx, input.applicationId);
  const penalty = input.type === 'maturity' ? { mode: 'flat' as const, value: 0 } : await penaltySetting(tx);
  const calc = computeRedemption({ principal, penalty });
  const redDate = input.redemptionDate ?? new Date().toISOString().slice(0, 10);
  const redNo = await nextCode(tx, 'redemption', 'MCR-{yyyy}-{seq:6}');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO redemptions (redemption_no, application_id, type, principal, penalty, net_payment, broken_interest, requested_date, redemption_date, reason, status, source, requested_by_customer, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Requested',$11,$12,$13) RETURNING id`,
    [redNo, input.applicationId, input.type, calc.principal, calc.penalty, calc.netPayment, calc.brokenInterest, redDate, redDate, input.reason, input.source, input.byCustomer, input.createdBy]
  );
  return { id: Number(rows[0]!.id), redemption_no: redNo, principal: calc.principal, penalty: calc.penalty, netPayment: calc.netPayment, brokenInterest: calc.brokenInterest };
}

/** Customer / app requests a redemption (no approval yet — lands in the staff queue). */
export async function requestRedemption(db: Db, input: { applicationId: number; reason: string; source: 'portal' | 'lockerhub'; createdBy?: number | null }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [input.applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active') throw errors.unprocessable('Only Active investments can be redeemed');
    const dupe = await tx.query("SELECT 1 FROM redemptions WHERE application_id = $1 AND status IN ('Requested','Approved')", [input.applicationId]);
    if (dupe.rowCount) throw errors.conflict('A redemption is already in progress for this investment');
    const r = await createRequest(tx, { applicationId: input.applicationId, type: 'premature', reason: input.reason, source: input.source, byCustomer: true, createdBy: input.createdBy ?? null });
    await writeAudit(tx, { actorId: input.createdBy ?? null, action: 'redemption.request', entityType: 'redemptions', entityId: r.id, after: { source: input.source, net: r.netPayment } });
    return r;
  });
}

/** Staff submits an existing 'Requested' redemption into the 2-level approval. */
export async function submitForApproval(db: Db, staff: AuthUser, redemptionId: number): Promise<ApprovalRow> {
  return db.withTx(async (tx) => {
    const red = (await tx.query<{ status: string; application_id: string; redemption_date: string; net_payment: string; penalty: string; approval_request_id: string | null }>(
      'SELECT status, application_id, redemption_date, net_payment, penalty, approval_request_id FROM redemptions WHERE id = $1', [redemptionId])).rows[0];
    if (!red) throw errors.notFound('Redemption not found');
    if (red.status !== 'Requested' || red.approval_request_id) throw errors.conflict('Redemption is not awaiting submission');
    const req = await createApprovalRequest(tx, {
      type: 'premature_redemption', entityType: 'redemptions', entityId: redemptionId, makerUserId: staff.id,
      metadata: { application_id: Number(red.application_id), redemption_id: redemptionId, redemption_date: red.redemption_date, net_payment: Number(red.net_payment), penalty: Number(red.penalty) },
    });
    await tx.query('UPDATE redemptions SET approval_request_id = $1 WHERE id = $2', [req.id, redemptionId]);
    await writeAudit(tx, { actorId: staff.id, action: 'redemption.submit', entityType: 'redemptions', entityId: redemptionId, after: { request_no: req.request_no } });
    return req;
  });
}

/** Staff initiates + submits a premature redemption in one step. */
export async function initiatePremature(db: Db, actor: AuthUser, input: { application_id: number; redemption_date?: string; reason: string }) {
  const app = (await db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [input.application_id])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  if (app.status !== 'Active') throw errors.unprocessable('Only Active applications can be prematurely redeemed');
  const rec = await db.withTx(async (tx) =>
    createRequest(tx, { applicationId: input.application_id, type: 'premature', reason: input.reason, source: 'staff', byCustomer: false, redemptionDate: input.redemption_date, createdBy: actor.id }));
  const req = await submitForApproval(db, actor, rec.id);
  return { redemption_id: rec.id, redemption_no: rec.redemption_no, request: req, principal: rec.principal, penalty: rec.penalty, netPayment: rec.netPayment, brokenInterest: rec.brokenInterest };
}

/** Maturity redemption — close a Matured application at par. */
export async function redeemAtMaturity(db: Db, actor: AuthUser, applicationId: number) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Matured' && app.status !== 'Active') throw errors.unprocessable('Only Matured/Active applications can be redeemed at maturity');
    const rec = await createRequest(tx, { applicationId, type: 'maturity', reason: 'Maturity redemption', source: 'staff', byCustomer: false, createdBy: actor.id });
    // Maturity redemption closes immediately (no penalty, principal already scheduled).
    assertTransition('application', app.status, app.status === 'Active' ? 'Matured' : 'Redeemed');
    if (app.status === 'Active') await tx.query("UPDATE applications SET status = 'Matured' WHERE id = $1", [applicationId]);
    await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = now(), updated_at = now() WHERE id = $1", [applicationId]);
    await tx.query("UPDATE application_lines SET status = 'Matured' WHERE application_id = $1 AND status = 'Active'", [applicationId]);
    await tx.query("UPDATE redemptions SET status = 'Approved' WHERE id = $1", [rec.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.maturity', entityType: 'redemptions', entityId: rec.id });
    return rec;
  });
}

registerOnFinalApprove('premature_redemption', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const redId = Number(req.metadata.redemption_id);
  const redDate = String(req.metadata.redemption_date ?? new Date().toISOString().slice(0, 10));
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return;
  assertTransition('application', app.status, 'Redeemed');
  await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = $1, updated_at = now() WHERE id = $2", [redDate, appId]);
  await tx.query("UPDATE application_lines SET status = 'PrematureWithdrawn', outstanding_amount = 0 WHERE application_id = $1 AND status = 'Active'", [appId]);
  await tx.query("UPDATE disbursement_schedule SET status = 'Skipped' WHERE application_id = $1 AND status = 'Scheduled'", [appId]);
  const red = (await tx.query<{ net_payment: string }>('SELECT net_payment FROM redemptions WHERE id = $1', [redId])).rows[0]!;
  const lineId = (await tx.query<{ id: string }>('SELECT id FROM application_lines WHERE application_id = $1 ORDER BY id LIMIT 1', [appId])).rows[0]?.id;
  if (lineId) {
    await tx.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status)
       VALUES ($1,$2,$3,'Premature',$4,0,$4,'Scheduled') ON CONFLICT (line_id, due_date, due_type) DO NOTHING`,
      [Number(lineId), appId, redDate, red.net_payment]);
  }
  await tx.query("UPDATE redemptions SET status = 'Approved', redemption_date = $1 WHERE id = $2", [redDate, redId]);
});

/** Federal Bank NEFT sheet for approved (unpaid) redemptions. */
export async function redemptionNeft(db: Db): Promise<Buffer> {
  const debit = (await db.query<{ account_number: string }>("SELECT account_number FROM banks WHERE is_disbursement_account = TRUE AND is_active = TRUE ORDER BY id LIMIT 1")).rows[0];
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, r.net_payment, r.redemption_date, c.full_name AS name, c.email,
            cba.account_number AS payee_account, cba.ifsc AS payee_ifsc
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_bank_accounts cba ON cba.customer_id = c.id AND cba.is_active = TRUE
     WHERE r.status = 'Approved' AND r.utr IS NULL ORDER BY c.full_name`)).rows;
  const { buildNeftSheet } = await import('../../lib/neft.js');
  return buildNeftSheet(
    { debitAccount: debit?.account_number ?? 'DISBURSEMENT-ACCT', sheetName: 'Redemptions' },
    rows.map((r) => ({
      amount: Number(r.net_payment), valueDate: String(r.redemption_date ?? new Date().toISOString().slice(0, 10)),
      beneAccount: String(r.payee_account ?? ''), beneName: String(r.name), ifsc: String(r.payee_ifsc ?? ''),
      email: (r.email as string) ?? '', creditRemark: `NCD redemption ${r.redemption_no}`, reference: String(r.redemption_no),
    }))
  );
}

/** Redemption report (all redemptions) as xlsx. */
export async function redemptionReport(db: Db): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Redemptions');
  ws.addRow(['Ref', 'Customer', 'Application', 'Type', 'Principal', 'Penalty', 'Net', 'Status', 'Date']).eachCell((c) => { c.font = { bold: true }; });
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, c.full_name, a.application_no, r.type, r.principal, r.penalty, r.net_payment, r.status, r.redemption_date
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id ORDER BY r.created_at DESC`)).rows;
  for (const r of rows) ws.addRow([r.redemption_no, r.full_name, r.application_no, r.type, Number(r.principal), Number(r.penalty), Number(r.net_payment), r.status, r.redemption_date]);
  [5, 6, 7].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function listRedemptions(db: Db, filter?: 'requests' | 'all') {
  const where = filter === 'requests' ? "WHERE r.status = 'Requested' AND r.approval_request_id IS NULL" : '';
  return (await db.query(
    `SELECT r.id, r.redemption_no, r.type, r.status, r.source, r.requested_by_customer, r.principal, r.penalty, r.net_payment, r.redemption_date, r.approval_request_id,
            a.application_no, c.full_name AS customer_name
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     ${where} ORDER BY r.created_at DESC LIMIT 200`)).rows;
}
