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
import { round2, toISODate } from '../../lib/dates.js';
import type { RateSpec } from '../../lib/incentive.js';
import { getSettingsMap } from '../settings/service.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject, type ApprovalRow } from '../approvals/service.js';

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
  const redDate = input.redemptionDate ?? new Date().toISOString().slice(0, 10);
  // Accrued broken-period interest (last paid → redemption date) is now COMPUTED
  // and RECORDED on the redemption (it was silently 0 before because the
  // coupon/dates were never passed). Single-Active-line apps compute exactly;
  // multi-line uses the first line's rate on the total (staff review before pay).
  // NOTE: net_payment stays principal − penalty per the documented design; the
  // broken interest's PAYOUT mechanism is a pending product decision.
  let brokenArgs: Partial<Parameters<typeof computeRedemption>[0]> = {};
  if (input.type === 'premature') {
    const line = (await tx.query<{ coupon_rate_pct: string; day_count_convention: string; paid_through: string | null }>(
      `SELECT l.coupon_rate_pct, l.day_count_convention,
              COALESCE((SELECT max(ds.due_date) FROM disbursement_schedule ds
                         WHERE ds.line_id = l.id AND ds.due_type IN ('Interest','BrokenInterest') AND ds.status = 'Paid'),
                       a.interest_start_date) AS paid_through
         FROM application_lines l JOIN applications a ON a.id = l.application_id
        WHERE l.application_id = $1 AND l.status = 'Active' ORDER BY l.id LIMIT 1`, [input.applicationId])).rows[0];
    const paidThrough = toISODate(line?.paid_through ?? null);
    if (line && paidThrough) {
      brokenArgs = {
        couponRatePct: Number(line.coupon_rate_pct),
        lastRegularPayoutDate: paidThrough,
        redemptionDate: redDate,
        convention: line.day_count_convention as never,
      };
    }
  }
  const calc = computeRedemption({ principal, penalty, ...brokenArgs });
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

/** Maturity redemption — maker→checker approval gate (old-app parity: it does
 * NOT close immediately; a checker must approve). */
export async function initiateMaturity(db: Db, actor: AuthUser, applicationId: number) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Matured' && app.status !== 'Active') throw errors.unprocessable('Only Matured/Active applications can be redeemed at maturity');
    const dupe = await tx.query("SELECT 1 FROM redemptions WHERE application_id = $1 AND status IN ('Requested','Approved')", [applicationId]);
    if (dupe.rowCount) throw errors.conflict('A redemption is already in progress for this investment');
    const rec = await createRequest(tx, { applicationId, type: 'maturity', reason: 'Maturity redemption', source: 'staff', byCustomer: false, createdBy: actor.id });
    const req = await createApprovalRequest(tx, {
      type: 'redemption', entityType: 'redemptions', entityId: rec.id, makerUserId: actor.id,
      metadata: { application_id: applicationId, redemption_id: rec.id },
    });
    await tx.query('UPDATE redemptions SET approval_request_id = $1 WHERE id = $2', [req.id, rec.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.maturity.initiate', entityType: 'redemptions', entityId: rec.id });
    return { redemption_id: rec.id, redemption_no: rec.redemption_no, request: req };
  });
}

/**
 * CXO waives / discounts a pending premature penalty before approving.
 * new_penalty = 0 (waive) or a reduced amount (discount); can't exceed the
 * current penalty or go negative. Recomputes net = principal − penalty and
 * mirrors the new figures onto the approval request so the card is truthful.
 */
export async function adjustPrematurePenalty(db: Db, actor: AuthUser, redemptionId: number, input: { new_penalty: number; reason: string }) {
  const settings = await getSettingsMap(db);
  if (settings['redemption.premature_penalty_waiver_enabled'] === false) {
    throw errors.unprocessable('Premature penalty waivers are turned off in Settings');
  }
  if (input.new_penalty < 0) throw errors.badRequest('Penalty cannot be negative');
  if (!input.reason?.trim() || input.reason.trim().length < 3) throw errors.badRequest('A reason is required');

  return db.withTx(async (tx) => {
    const red = (await tx.query<{ type: string; status: string; principal: string; penalty: string; penalty_original: string | null; approval_request_id: string | null }>(
      'SELECT type, status, principal, penalty, penalty_original, approval_request_id FROM redemptions WHERE id = $1 FOR UPDATE', [redemptionId])).rows[0];
    if (!red) throw errors.notFound('Redemption not found');
    if (red.type !== 'premature') throw errors.unprocessable('Only premature redemptions carry a penalty');
    if (red.status !== 'Requested') throw errors.unprocessable('This redemption is no longer pending approval');
    const current = Number(red.penalty);
    if (input.new_penalty > current + 0.001) throw errors.badRequest('The penalty can only be waived or reduced, not increased');

    const principal = Number(red.principal);
    const newPenalty = round2(input.new_penalty);
    const newNet = round2(principal - newPenalty);
    const original = red.penalty_original != null ? Number(red.penalty_original) : current;

    await tx.query(
      `UPDATE redemptions SET penalty = $1, net_payment = $2,
         penalty_original = $3, penalty_waived_by_user_id = $4, penalty_waive_reason = $5, penalty_waived_at = now()
       WHERE id = $6`,
      [newPenalty, newNet, original, actor.id, input.reason.trim(), redemptionId]);

    // Keep the approval card's metadata in sync (it shows penalty + net_payment).
    if (red.approval_request_id) {
      await tx.query(
        `UPDATE approval_requests SET metadata = metadata || jsonb_build_object('penalty', $1::numeric, 'net_payment', $2::numeric, 'penalty_waived', true) WHERE id = $3`,
        [newPenalty, newNet, Number(red.approval_request_id)]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.penalty-waive', entityType: 'redemptions', entityId: redemptionId, before: { penalty: current }, after: { penalty: newPenalty, net_payment: newNet, reason: input.reason.trim() } });
    return { redemption_id: redemptionId, penalty: newPenalty, penalty_original: original, net_payment: newNet };
  });
}

/** On maturity-redemption approval: close the application at par. */
registerOnFinalApprove('redemption', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const redId = Number(req.metadata.redemption_id);
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return;
  if (app.status === 'Active') {
    assertTransition('application', 'Active', 'Matured');
    await tx.query("UPDATE applications SET status = 'Matured' WHERE id = $1", [appId]);
  }
  assertTransition('application', 'Matured', 'Redeemed');
  await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = now(), updated_at = now() WHERE id = $1", [appId]);
  await tx.query("UPDATE application_lines SET status = 'Matured' WHERE application_id = $1 AND status = 'Active'", [appId]);
  await tx.query("UPDATE redemptions SET status = 'Approved' WHERE id = $1", [redId]);
});

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
  const neftSettings = await getSettingsMap(db);
  const asText = (v: unknown): string => {
    const t = (v === null || v === undefined ? '' : String(v)).trim();
    return t === 'null' || t === 'undefined' ? '' : t;
  };
  const debitSetting = asText(neftSettings['payouts.neft_debit_account']);
  const fallbackEmail = asText(neftSettings['payouts.neft_beneficiary_email']);
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, r.net_payment, r.redemption_date, c.full_name AS name, c.email,
            cba.account_number AS payee_account, cba.ifsc AS payee_ifsc
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_bank_accounts cba ON cba.customer_id = c.id AND cba.is_active = TRUE
     WHERE r.status = 'Approved' AND r.utr IS NULL ORDER BY c.full_name`)).rows;
  const { buildNeftSheet } = await import('../../lib/neft.js');
  return buildNeftSheet(
    { debitAccount: debitSetting || debit?.account_number || 'DISBURSEMENT-ACCT',
      sheetName: 'Redemptions',
      valueDate: new Date() },   // value date = the day the sheet is generated
    rows.map((r) => ({
      amount: Number(r.net_payment), valueDate: String(r.redemption_date ?? new Date().toISOString().slice(0, 10)),
      beneAccount: String(r.payee_account ?? ''), beneName: String(r.name), ifsc: String(r.payee_ifsc ?? ''),
      email: ((r.email as string) || fallbackEmail) ?? '', creditRemark: `NCD redemption ${r.redemption_no}`, reference: String(r.redemption_no),
    }))
  );
}

/** Scope predicate for redemptions, by the underlying application's owner. */
function redemptionScope(actor: AuthUser, offset = 0) {
  return scopeWhere(scopeFor(actor), { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id' }, offset);
}

/** Redemption report (scoped to the caller) as xlsx. */
export async function redemptionReport(db: Db, actor: AuthUser): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Redemptions');
  ws.addRow(['Ref', 'Customer', 'Application', 'Type', 'Principal', 'Penalty', 'Net', 'Status', 'Date']).eachCell((c) => { c.font = { bold: true }; });
  const sc = redemptionScope(actor);
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, c.full_name, a.application_no, r.type, r.principal, r.penalty, r.net_payment, r.status, r.redemption_date
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ${sc.sql} ORDER BY r.created_at DESC`, sc.params)).rows;
  for (const r of rows) ws.addRow([r.redemption_no, r.full_name, r.application_no, r.type, Number(r.principal), Number(r.penalty), Number(r.net_payment), r.status, r.redemption_date]);
  [5, 6, 7].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function listRedemptions(db: Db, actor: AuthUser, filter?: 'requests' | 'all') {
  const sc = redemptionScope(actor);
  const conds = [sc.sql];
  if (filter === 'requests') conds.push("r.status = 'Requested' AND r.approval_request_id IS NULL");
  return (await db.query(
    `SELECT r.id, r.redemption_no, r.type, r.status, r.source, r.requested_by_customer, r.principal, r.penalty, r.net_payment, r.redemption_date, r.approval_request_id,
            a.application_no, c.full_name AS customer_name
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ${conds.join(' AND ')} ORDER BY r.created_at DESC LIMIT 2000`, sc.params)).rows;
}

// On REJECT of a redemption approval, mark the redemption Rejected (terminal).
// Without this the row stayed 'Requested' with an approval_request_id set — it
// vanished from the queue, couldn't be resubmitted, and blocked any new
// redemption on the same investment. (Review 2026-07-21.)
async function rejectRedemption(tx: Db, req: ApprovalRow) {
  const redId = Number(req.metadata.redemption_id);
  if (!redId) return;
  await tx.query("UPDATE redemptions SET status = 'Rejected' WHERE id = $1 AND status = 'Requested'", [redId]);
}
registerOnReject('premature_redemption', rejectRedemption);
registerOnReject('redemption', rejectRedemption);
