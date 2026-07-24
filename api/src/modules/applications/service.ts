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
import { enqueue, drainOnce } from '../notifications/service.js';
import { signFileToken } from '../auth/tokens.js';
import { formatPhone } from '../../integrations/notify/wappcloud.js';
import { config } from '../../config.js';
import { assertTicket } from '../../lib/ticket.js';

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
  date_money_received: string;
  collection_method: string;
  collection_reference: string;
  club_with_application_id?: number; // append this line to an in-flight app
  // Receipt / cheque photo — mandatory: an investment never exists without it.
  // Same wire shape as POST /:id/receipt (the client mime is ignored — sniffed).
  receipt: { filename: string; mime: string; data_base64: string };
  is_locker_deposit?: boolean; // staff-keyed locker money; the LockerHub flow sets its own flag
}

/** Validate + persist receipt bytes; returns the stored path and SNIFFED mime
 * (the client-declared one is never trusted). Throws 400 on a bad file. */
async function storeReceiptFile(filename: string, dataBase64: string): Promise<{ file_path: string; mime: string }> {
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64);
  const { saveBuffer } = await import('../../lib/storage.js');
  const { path } = saveBuffer('receipts', filename, buffer);
  return { file_path: path, mime };
}

/** Attach already-stored receipt bytes to an application row (audited). */
async function attachReceipt(db: Db, actor: AuthUser, appId: number, filename: string, stored: { file_path: string; mime: string }) {
  const upd = await db.query('UPDATE applications SET receipt_file_path = $1, receipt_original_filename = $2, receipt_mime = $3, receipt_uploaded_at = now() WHERE id = $4',
    [stored.file_path, filename, stored.mime, appId]);
  if (!upd.rowCount) {
    const { removeStored } = await import('../../lib/storage.js');
    removeStored(stored.file_path); // no row to own the file — don't orphan it
    throw errors.notFound('Application not found');
  }
  await writeAudit(db, { actorId: actor.id, action: 'application.receipt', entityType: 'applications', entityId: appId, after: { filename } });
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
  // The receipt photo is mandatory and attached inside the create transaction,
  // so an application row never exists without one. Bad bytes 400 here, before
  // any row is written; if the transaction fails the stored file is removed —
  // no orphaned rows OR files either way.
  const storedReceipt = await storeReceiptFile(input.receipt.filename, input.receipt.data_base64);
  try {
    return await db.withTx(async (tx) => {
      const scheme = (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE id = $1', [input.scheme_id])).rows[0];
      if (!scheme) throw errors.badRequest('Unknown scheme');
      // NCDs are issued in whole ₹1,00,000 units (scheme min_ticket/multiple_of).
      // Checked here so it also covers the clubbing branch below: every line is a
      // whole number of units, so any total built from them is one too.
      assertTicket(input.amount, {
        min: Number(scheme.min_ticket) || 100000,
        multiple: Number(scheme.multiple_of) || 100000,
      });

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
        // The new line's receipt lands on the target app — same as the old
        // client-side follow-up upload did.
        await attachReceipt(tx, actor, Number(target.id), input.receipt.filename, storedReceipt);
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
        `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, customer_was_new_at_creation, referred_by_text, source, enrolled_by_user_id, enrolled_by_agent_id, is_locker_deposit, date_money_received, collection_method, collection_reference)
         VALUES ($1,$2,$3,'PendingApproval',$4,$5,$6,'staff',$7,$8,$9,$10,$11,$12) RETURNING id`,
        [appNo, input.customer_id, input.series_id, input.amount, isNew, customer.referred_by_text ?? null, actor.id, actor.agentId,
         input.is_locker_deposit ?? false, input.date_money_received, input.collection_method, input.collection_reference]
      );
      const appId = Number(rows[0]!.id);
      await addLine(tx, appId, scheme, input.amount);
      // Tell LockerHub a subscription intent was created (contract event). No-op unless configured.
      await emitForApplication(tx, 'subscription.created', appId);
      const subscriptionRequest = await createApprovalRequest(tx, { type: 'subscription', entityType: 'applications', entityId: appId, makerUserId: actor.id, metadata: { application_no: appNo } });
      await writeAudit(tx, { actorId: actor.id, action: 'application.create', entityType: 'applications', entityId: appId, after: { appNo, amount: input.amount, isNew } });
      await attachReceipt(tx, actor, appId, input.receipt.filename, storedReceipt);
      return { id: appId, application_no: appNo, clubbed: false, subscription_request: subscriptionRequest };
    });
  } catch (e) {
    const { removeStored } = await import('../../lib/storage.js');
    removeStored(storedReceipt.file_path);
    throw e;
  }
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
export async function setPayoutAccount(db: Db, actor: AuthUser, appId: number, bankAccountId: number | null) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ customer_id: string }>('SELECT customer_id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');

    // null clears the pin: this NCD goes back to following the customer's
    // default account, and its future unpaid rows move there with it.
    if (bankAccountId === null) {
      await tx.query('UPDATE applications SET payout_bank_account_id = NULL, updated_at = now() WHERE id = $1', [appId]);
      const { resnapshotPayeeBank } = await import('../schedule/materialize.js');
      await resnapshotPayeeBank(tx, Number(app.customer_id));
      await writeAudit(tx, { actorId: actor.id, action: 'application.payout-account', entityType: 'applications', entityId: appId, after: { bankAccountId: null } });
      return { ok: true };
    }

    // Any account ON FILE for this customer may be chosen — the check that
    // matters is that it belongs to them. Requiring penny-drop 'Verified' here
    // was inconsistent as well as unusable: interest already pays out to
    // whichever account is active, verified or not (403 of 433 live accounts
    // are 'Pending' — never penny-dropped, mostly migrated from wealth), so
    // gating only the per-NCD pin blocked the feature for everyone without
    // making a single payment safer.
    const bank = (await tx.query<{ account_number: string; ifsc: string }>(
      'SELECT account_number, ifsc FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2',
      [bankAccountId, app.customer_id])).rows[0];
    if (!bank) throw errors.badRequest('Bank account not found for this customer');
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
  const stored = await storeReceiptFile(filename, dataBase64); // sniffed mime — client's is ignored
  await attachReceipt(db, actor, appId, filename, stored);
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

export async function listApplications(db: Db, actor: AuthUser, filters: { status?: string; series_id?: number; showArchived?: boolean } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  conds.push(sc.sql); params.push(...sc.params);
  // Archived investments are hidden unless a super-admin (applications:delete)
  // explicitly asks to see them (to restore or purge).
  const showArchived = filters.showArchived && actor.permissions.includes('applications:delete');
  if (!showArchived) conds.push('a.archived_at IS NULL');
  if (filters.status) { params.push(filters.status); conds.push(`a.status = $${params.length}`); }
  if (filters.series_id) { params.push(filters.series_id); conds.push(`a.series_id = $${params.length}`); }
  const base = `FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE ${conds.join(' AND ')}`;
  const total = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, params)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT a.id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date, a.archived_at,
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
  // A signature is out with the customer — the UI polls while this is true so the
  // page flips to eSigned on its own once the Digio poller completes it.
  const pendingSessions = Number((await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM digio_signing_sessions WHERE application_id = $1 AND status = 'requested'", [appId]
  )).rows[0]?.n ?? 0);
  const esignPending = pendingSessions > 0 && !app.esigned_at;
  // Locker pledge breakdown: total / linked to lockers / free NCD / redeemable.
  // The investment is never split — links are claims against it.
  const { depositSummary } = await import('../lockers/deposits.js');
  const locker = await depositSummary(db, appId);
  return { application: app, lines, schedule, esign_pending: esignPending, locker };
}

/**
 * Send the acknowledgement PDF to the customer on WhatsApp (approved `ncd_akn`
 * template, which carries a Document header). The PDF is handed to WappCloud as
 * a short-lived, path-scoped `?vt=` URL its servers fetch — never a public
 * link. Queued through the shared notifications queue then drained now (one
 * click), so the caller gets the real send status back.
 */
export async function sendWhatsappAck(db: Db, appId: number): Promise<{ ok: boolean; status: string; error: string | null; phone: string }> {
  const row = (await db.query<{ full_name: string; phone: string | null }>(
    'SELECT c.full_name, c.phone FROM applications a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1', [appId])).rows[0];
  if (!row) throw errors.notFound('Application not found');
  const phone = formatPhone(row.phone ?? '');
  if (!phone) throw errors.badRequest("Customer has no valid phone number on file — can't send on WhatsApp.");
  if (!config.PUBLIC_BASE_URL) throw errors.badRequest('PUBLIC_BASE_URL is not set — add it to SSM so WappCloud can fetch the ack PDF.');

  const path = `/api/reports/acknowledgment/${appId}.pdf`;
  const documentUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}?vt=${encodeURIComponent(signFileToken('acknowledgment', appId))}`;
  const documentName = `${(row.full_name || 'Customer').trim()} - NCD Acknowledgment.pdf`;

  const id = await enqueue(db, {
    channel: 'whatsapp', template: 'acknowledgment', to: phone,
    payload: { name: row.full_name ?? '', documentUrl, documentName },
  });
  await drainOnce(db, 5); // send now (one click) rather than waiting for the cron
  const st = (await db.query<{ status: string; error: string | null }>('SELECT status, error FROM notifications_queue WHERE id = $1', [id])).rows[0];
  return { ok: st?.status === 'Sent', status: st?.status ?? 'Pending', error: st?.error ?? null, phone };
}
