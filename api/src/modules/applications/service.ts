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
import { assertTransition, isTerminal } from '../../lib/statusMachine.js';
import { toISODate } from '../../lib/dates.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';

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
  club_with_application_id?: number; // append this line to an in-flight app
  receipt?: { file_path: string; original_filename: string; mime: string };
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

    // Optional subscription approval gate (old-app parity, off by default).
    const subGate = settings['approvals.subscription_maker_checker'] === true;
    const initialStatus = subGate ? 'PendingApproval' : 'PendingFundVerification';

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, customer_was_new_at_creation, referred_by_text, source, enrolled_by_user_id, enrolled_by_agent_id, receipt_file_path, receipt_original_filename, receipt_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',$8,$9,$10,$11,$12) RETURNING id`,
      [appNo, input.customer_id, input.series_id, initialStatus, input.amount, isNew, customer.referred_by_text ?? null, actor.id, actor.agentId,
       input.receipt?.file_path ?? null, input.receipt?.original_filename ?? null, input.receipt?.mime ?? null]
    );
    const appId = Number(rows[0]!.id);
    await addLine(tx, appId, scheme, input.amount);
    let subscriptionRequest;
    if (subGate) {
      subscriptionRequest = await createApprovalRequest(tx, { type: 'subscription', entityType: 'applications', entityId: appId, makerUserId: actor.id, metadata: { application_no: appNo } });
    }
    await writeAudit(tx, { actorId: actor.id, action: 'application.create', entityType: 'applications', entityId: appId, after: { appNo, amount: input.amount, isNew, gated: subGate } });
    return { id: appId, application_no: appNo, clubbed: false, ...(subscriptionRequest ? { subscription_request: subscriptionRequest } : {}) };
  });
}

// Subscription approval (only used when the gate setting is on) → advances the
// application from PendingApproval to PendingFundVerification.
registerOnFinalApprove('subscription', async (tx, req) => {
  if (!req.entity_id) return;
  const appId = Number(req.entity_id);
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (app?.status === 'PendingApproval') {
    await tx.query("UPDATE applications SET status = 'PendingFundVerification', updated_at = now() WHERE id = $1", [appId]);
  }
});

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

export async function confirmCollection(db: Db, actor: AuthUser, appId: number, input: { amount_received: number; date_money_received: string; method: string; reference?: string }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string; series_id: string }>('SELECT status, series_id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    // Money is in Dhanam's account → the app is ready for the activation
    // approval. eSign and allotment happen later and do not gate this.
    assertTransition('application', app.status, 'PendingActivation');
    const series = (await tx.query<{ deemed_date: string | null }>('SELECT deemed_date FROM series WHERE id = $1', [app.series_id])).rows[0];
    const deemed = toISODate(series?.deemed_date ?? null);
    // interest_start_date = max(receipt date, series deemed date)
    const isd = deemed && deemed > input.date_money_received ? deemed : input.date_money_received;
    const colNo = await nextCode(tx, 'collection', 'COL-{yyyy}-{seq:6}');
    await tx.query('INSERT INTO collections (collection_no, application_id, amount, method, reference, collection_date, confirmed_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [colNo, appId, input.amount_received, input.method, input.reference ?? null, input.date_money_received, actor.id]);
    await tx.query(
      `UPDATE applications SET status = 'PendingActivation', amount_received = $1, date_money_received = $2, collection_method = $3, collection_reference = $4, interest_start_date = $5, updated_at = now() WHERE id = $6`,
      [input.amount_received, input.date_money_received, input.method, input.reference ?? null, isd, appId]
    );
    await writeAudit(tx, { actorId: actor.id, action: 'application.confirm-collection', entityType: 'applications', entityId: appId, after: { interest_start_date: isd } });
    return { interest_start_date: isd };
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
  const { rows } = await db.query(
    `SELECT a.id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date,
            c.full_name AS customer_name, c.customer_code, s.code AS series_code
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT 2000`,
    params
  );
  return rows;
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
