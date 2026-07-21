/**
 * Applications module (docs/04 §2). Lifecycle:
 *   create → PendingFundVerification → (confirm collection) PendingActivation
 *   → (activation approval) Active → Redeemed/Matured…
 * eSign is recorded (esigned_at) but no longer gates the flow; allotment is a
 * separate, later series step that only stamps allotment_date.
 * State changes go through the shared state machine.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { isTerminal } from '../../lib/statusMachine.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { emitForApplication } from '../../integrations/lockerhub/customerEvents.js';

const SCOPE_COLS = {
  userCol: 'a.enrolled_by_user_id',
  agentCol: 'a.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
};

export interface CreateApplicationInput {
  customer_id: number;
  series_id: number;
  scheme_id: number;
  amount: number;
  // Date the money hit Dhanam's account, entered by staff at enrolment. Stored
  // now; interest starts from it once the investment is approved (go-live).
  date_money_received?: string;
  collection_method?: string;
  collection_reference?: string;
  club_with_application_id?: number; // append this line to an in-flight app
  receipt?: { file_path: string; original_filename: string; mime: string };
  is_locker_deposit?: boolean; // staff-keyed locker money; the LockerHub flow sets its own flag
}

async function addLine(tx: Db, appId: number, scheme: Record<string, unknown>, amount: number) {
  await tx.query(
    `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active')`,
    [appId, scheme.id, scheme.coupon_rate_pct, scheme.tenure_months, scheme.payout_frequency, scheme.day_count_convention, amount]);
}

export async function createApplication(db: Db, actor: AuthUser, input: CreateApplicationInput) {
  const settings = await getSettingsMap(db);
  const appFmt = String(settings['numbering.application_format'] ?? 'APP-{yyyy}-{seq:6}');
  return db.withTx(async (tx) => {
    const scheme = (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE id = $1', [input.scheme_id])).rows[0];
    if (!scheme) throw errors.badRequest('Unknown scheme');

    // Clubbing: append this line's amount to an existing in-flight application.
    if (input.club_with_application_id) {
      const target = (await tx.query<{ id: string; status: string; series_id: string; total_amount: string }>(
        'SELECT id, status, series_id, total_amount FROM applications WHERE id = $1', [input.club_with_application_id])).rows[0];
      if (!target) throw errors.notFound('Clubbing target not found');
      if (Number(target.series_id) !== input.series_id) throw errors.badRequest('Can only club within the same series');
      if (!['PendingFundVerification', 'PendingEsign', 'PendingApproval'].includes(target.status)) throw errors.conflict('Target application is no longer in-flight');
      await addLine(tx, Number(target.id), scheme, input.amount);
      await tx.query('UPDATE applications SET total_amount = total_amount + $1, updated_at = now() WHERE id = $2', [input.amount, Number(target.id)]);
      await writeAudit(tx, { actorId: actor.id, action: 'application.club', entityType: 'applications', entityId: Number(target.id), after: { added: input.amount } });
      const no = (await tx.query<{ application_no: string }>('SELECT application_no FROM applications WHERE id = $1', [Number(target.id)])).rows[0]!.application_no;
      return { id: Number(target.id), application_no: no, clubbed: true };
    }

    const customer = (await tx.query<{ referred_by_text: string | null }>('SELECT referred_by_text FROM customers WHERE id = $1', [input.customer_id])).rows[0];
    if (!customer) throw errors.badRequest('Unknown customer');
    const priorCount = Number((await tx.query<{ n: string }>('SELECT count(*)::int AS n FROM applications WHERE customer_id = $1', [input.customer_id])).rows[0]!.n);
    const isNew = priorCount === 0;
    const appNo = await nextCode(tx, 'application', appFmt);

    // Every staff-enrolled investment goes through one gate: it lands in
    // PendingApproval and an investment approval is raised. The admin verifies
    // the money is in Dhanam's account and approves — that approval is the
    // go-live (Active + schedule + incentives). Staff record the credit date
    // here so interest can start from it (owner spec 2026-07-19).
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, customer_was_new_at_creation, referred_by_text, source, enrolled_by_user_id, enrolled_by_agent_id, receipt_file_path, receipt_original_filename, receipt_mime, is_locker_deposit, date_money_received, collection_method, collection_reference)
       VALUES ($1,$2,$3,'PendingApproval',$4,$5,$6,'staff',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [appNo, input.customer_id, input.series_id, input.amount, isNew, customer.referred_by_text ?? null, actor.id, actor.agentId,
       input.receipt?.file_path ?? null, input.receipt?.original_filename ?? null, input.receipt?.mime ?? null,
       input.is_locker_deposit ?? false, input.date_money_received ?? null, input.collection_method ?? null, input.collection_reference ?? null]
    );
    const appId = Number(rows[0]!.id);
    await addLine(tx, appId, scheme, input.amount);
    // Tell LockerHub a subscription intent was created (contract event). No-op unless configured.
    await emitForApplication(tx, 'subscription.created', appId);
    const subscriptionRequest = await createApprovalRequest(tx, { type: 'subscription', entityType: 'applications', entityId: appId, makerUserId: actor.id, metadata: { application_no: appNo } });
    await writeAudit(tx, { actorId: actor.id, action: 'application.create', entityType: 'applications', entityId: appId, after: { appNo, amount: input.amount, isNew } });
    return { id: appId, application_no: appNo, clubbed: false, subscription_request: subscriptionRequest };
  });
}

// Investment approval = go-live. The admin has verified the money is in
// Dhanam's account; approving takes the NCD live (Active + schedule +
// incentives) using the credit date staff recorded at enrolment.
registerOnFinalApprove('subscription', async (tx, req) => {
  if (!req.entity_id) return;
  const appId = Number(req.entity_id);
  const { activateApplication } = await import('./activate.js');
  await activateApplication(tx, appId, { confirmedByUserId: req.maker_user_id });
});

// A rejected subscription approval = the intent was cancelled. Emit-only (the
// app lifecycle is unchanged here); no-op unless the event webhook is configured.
registerOnReject('subscription', async (tx, req) => {
  if (!req.entity_id) return;
  await emitForApplication(tx, 'subscription.cancelled', Number(req.entity_id));
});

/**
 * Assign (or reassign) the referrer staff/agent on an investment and re-accrue
 * the referrer incentive. Used for app-channel investments where the customer
 * gave no referral code — the admin picks the payee from the App-investment
 * notice on the Approvals page. Idempotent per (app, payee): a clean unpaid
 * re-accrual, paid rows are never touched.
 */
export async function attributeReferrer(db: Db, actor: AuthUser, appId: number, payee: string) {
  const text = payee.trim();
  if (!text) throw errors.badRequest('Pick a staff or agent to assign');
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ id: string }>('SELECT id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    // Drop any existing UNPAID referrer accrual so a re-assignment lands cleanly.
    await tx.query("DELETE FROM incentive_accruals WHERE application_id = $1 AND matrix_cell = 'referrer' AND paid_at IS NULL", [appId]);
    await tx.query('UPDATE applications SET referred_by_text = $1, updated_at = now() WHERE id = $2', [text, appId]);
    const { accrueForApplication } = await import('../incentives/accrual.js');
    await accrueForApplication(tx, appId);
    // Mark the App-investment notice resolved so the queue reflects it.
    await tx.query(
      `UPDATE approval_requests
         SET metadata = jsonb_set(jsonb_set(metadata, '{needs_attribution}', 'false'), '{referred_by}', to_jsonb($1::text))
       WHERE request_type = 'app_investment' AND entity_type = 'applications' AND entity_id = $2 AND status = 'Pending'`,
      [text, String(appId)]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.attribute-referrer', entityType: 'applications', entityId: appId, after: { referred_by_text: text } });
    return { ok: true };
  });
}

/** Clubbing candidates — in-flight apps in a series for a customer. */
export async function clubbingCandidates(db: Db, customerId: number, seriesId: number) {
  return (await db.query(
    `SELECT id, application_no, total_amount, status FROM applications
     WHERE customer_id = $1 AND series_id = $2 AND status IN ('PendingFundVerification','PendingEsign','PendingApproval') ORDER BY id`,
    [customerId, seriesId])).rows;
}

/** Set/change the interest payout bank account for an application (re-snapshots
 * only future unpaid schedule rows). */
export async function setPayoutAccount(db: Db, actor: AuthUser, appId: number, bankAccountId: number) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ customer_id: string }>('SELECT customer_id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    const bank = (await tx.query<{ account_number: string; ifsc: string }>('SELECT account_number, ifsc FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2 AND penny_drop_status = $3', [bankAccountId, app.customer_id, 'Verified'])).rows[0];
    if (!bank) throw errors.badRequest('Bank account not found or not verified for this customer');
    await tx.query('UPDATE applications SET payout_bank_account_id = $1, updated_at = now() WHERE id = $2', [bankAccountId, appId]);
    // Re-snapshot future unpaid (Scheduled, no batch) rows to the new account.
    await tx.query(
      "UPDATE disbursement_schedule SET payee_account = $1, payee_ifsc = $2 WHERE application_id = $3 AND status = 'Scheduled' AND batch_id IS NULL",
      [bank.account_number, bank.ifsc, appId]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.payout-account', entityType: 'applications', entityId: appId, after: { bankAccountId } });
    return { ok: true };
  });
}

export async function uploadReceipt(db: Db, actor: AuthUser, appId: number, filename: string, _clientMime: string, dataBase64: string) {
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64); // sniffed mime — client's is ignored
  const { saveBuffer } = await import('../../lib/storage.js');
  const { path } = saveBuffer('receipts', filename, buffer);
  const upd = await db.query('UPDATE applications SET receipt_file_path = $1, receipt_original_filename = $2, receipt_mime = $3, receipt_uploaded_at = now() WHERE id = $4',
    [path, filename, mime, appId]);
  if (!upd.rowCount) throw errors.notFound('Application not found');
  await writeAudit(db, { actorId: actor.id, action: 'application.receipt', entityType: 'applications', entityId: appId, after: { filename } });
  return { ok: true };
}

export async function getReceipt(db: Db, appId: number): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const app = (await db.query<{ receipt_file_path: string | null; receipt_mime: string | null; receipt_original_filename: string | null }>(
    'SELECT receipt_file_path, receipt_mime, receipt_original_filename FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app?.receipt_file_path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(app.receipt_file_path);
  if (!buffer) return null;
  return { buffer, mime: app.receipt_mime ?? 'application/octet-stream', filename: app.receipt_original_filename ?? 'receipt' };
}

/** Correct the locker-deposit flag on an application (staff-keyed entries;
 * the LockerHub integration path sets its own flag automatically). */
export async function setLockerDeposit(db: Db, actor: AuthUser, appId: number, value: boolean) {
  const upd = await db.query('UPDATE applications SET is_locker_deposit = $1, updated_at = now() WHERE id = $2', [value, appId]);
  if (!upd.rowCount) throw errors.notFound('Application not found');
  await writeAudit(db, { actorId: actor.id, action: 'application.locker-deposit', entityType: 'applications', entityId: appId, after: { is_locker_deposit: value } });
  return { ok: true };
}

/** Record eSign completion. Non-gating: it stamps esigned_at and does not
 * change the lifecycle status (eSign no longer sits on the critical path). */
export async function markESigned(db: Db, actor: AuthUser, appId: number) {
  await db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (isTerminal('application', app.status)) throw errors.conflict('Application is closed');
    await tx.query('UPDATE applications SET esigned_at = now(), updated_at = now() WHERE id = $1', [appId]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.esigned', entityType: 'applications', entityId: appId });
  });
}

export async function listApplications(db: Db, actor: AuthUser, filters: { status?: string; series_id?: number } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  conds.push(sc.sql); params.push(...sc.params);
  if (filters.status) { params.push(filters.status); conds.push(`a.status = $${params.length}`); }
  if (filters.series_id) { params.push(filters.series_id); conds.push(`a.series_id = $${params.length}`); }
  const base = `FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE ${conds.join(' AND ')}`;
  const total = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, params)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT a.id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date,
            c.full_name AS customer_name, c.customer_code, s.code AS series_code
     ${base} ORDER BY a.created_at DESC LIMIT 2000`,
    params
  );
  return { rows, total, truncated: total > rows.length };
}

export async function getApplicationDetail(db: Db, actor: AuthUser, appId: number) {
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 1);
  const app = (await db.query(
    `SELECT a.*, c.full_name AS customer_name, c.customer_code, s.code AS series_code
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE a.id = $1 AND ${sc.sql}`, [appId, ...sc.params])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  const lines = (await db.query('SELECT * FROM application_lines WHERE application_id = $1', [appId])).rows;
  const schedule = (await db.query('SELECT id, due_date, due_type, gross_amount, tds_amount, net_amount, status, paid_at FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date', [appId])).rows;
  return { application: app, lines, schedule };
}
