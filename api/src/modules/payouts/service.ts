/**
 * Interest NEFT payout batches (docs/02 §5). Maker previews due interest,
 * creates a batch (maker-checker); on approval it unlocks; admin marks paid,
 * which flips the schedule rows to Paid at value date.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { round2, toISODate, daysBetween } from '../../lib/dates.js';
import { denominatorFor, type DayCountConvention } from '../../lib/interest.js';
import { computeTds } from '../../lib/tds.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';
import { nextCode } from '../../lib/sequences.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { getSettingsMap } from '../settings/service.js';

const DUE_TYPES = "('Interest','BrokenInterest')";
const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((x) => `'${x}'`).join(',');

/**
 * Interest due up to `payoutDate`, computed PRO-RATA (owner decision 2026-07-20):
 * the sheet can be pulled on ANY date and pays each live line the interest it has
 * accrued since it was last paid, up to that date — not a fixed 28th-of-month row.
 *
 *   gross = outstanding x rate/100 x days(paid_through -> payoutDate) / dayCount
 *
 * `paid_through` is the line's watermark: the last Paid Interest/BrokenInterest
 * due_date, else the application's interest start. Because every batch starts at
 * the watermark and paying advances it, a period can never be paid twice, and the
 * next run always starts fresh from the date you just paid.
 */
export async function previewDue(db: Db, payoutDate: string) {
  const { rows: lines } = await db.query<Record<string, unknown>>(
    `SELECT l.id AS line_id, l.application_id, l.outstanding_amount, l.coupon_rate_pct,
            l.day_count_convention, l.payout_frequency, l.amount AS line_amount,
            l.scheme_id,
            a.application_no, a.interest_start_date, a.payout_bank_account_id, a.customer_id,
            c.full_name AS customer_name, c.is_nri, c.tds_applicable AS cust_tds,
            c.tax_form, c.tax_form_expires_on,
            COALESCE((SELECT max(ds.due_date) FROM disbursement_schedule ds
                       WHERE ds.line_id = l.id AND ds.due_type IN ${DUE_TYPES}
                         AND (ds.status = 'Paid'
                              OR (ds.status = 'Scheduled' AND ds.batch_id IS NOT NULL))),
                     a.interest_start_date) AS paid_through
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
      WHERE l.status = 'Active' AND a.status IN (${OUTSTANDING_SQL_LIST})
      ORDER BY c.full_name`);

  const out: Record<string, unknown>[] = [];
  const totals = { gross: 0, tds: 0, net: 0 };
  for (const l of lines) {
    const paidThrough = toISODate(l.paid_through as string | null);
    if (!paidThrough || payoutDate <= paidThrough) continue;   // nothing accrued yet
    const days = daysBetween(paidThrough, payoutDate);
    if (days <= 0) continue;
    const principal = Number(l.outstanding_amount);
    if (!(principal > 0)) continue;

    const denom = denominatorFor(l.day_count_convention as DayCountConvention, paidThrough);
    const gross = round2((principal * Number(l.coupon_rate_pct)) / 100 * days / denom);
    if (gross <= 0) continue;

    const tdsRule = l.scheme_id
      ? (await db.query<{ rate_pct: number }>(
          'SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [l.scheme_id])).rows[0] ?? null
      : null;
    const tds = computeTds(
      tdsRule,
      { is_nri: l.is_nri as boolean, tds_applicable: l.cust_tds as boolean,
        tax_form: l.tax_form as string | null, tax_form_expires_on: toISODate(l.tax_form_expires_on as string | null) },
      { payout_frequency: l.payout_frequency as string, amount: Number(l.line_amount) },
      { due_type: 'Interest', gross_amount: gross, due_date: payoutDate }
    );
    const net = round2(gross - tds);

    totals.gross += gross; totals.tds += tds; totals.net += net;
    out.push({
      line_id: Number(l.line_id), application_id: Number(l.application_id),
      application_no: l.application_no, customer_name: l.customer_name,
      due_date: payoutDate, due_type: 'Interest',
      from_date: paidThrough, days,
      gross_amount: gross, tds_amount: tds, net_amount: net,
    });
  }
  return { rows: out, totals: { gross: round2(totals.gross), tds: round2(totals.tds), net: round2(totals.net) }, count: out.length };
}

export async function createInterestBatch(db: Db, actor: AuthUser, payoutDate: string, utr?: string) {
  return db.withTx(async (tx) => {
    const due = await previewDue(tx, payoutDate);
    if (due.count === 0) throw errors.unprocessable('No interest has accrued up to that date');
    const batchNo = await nextCode(tx, 'redemption', 'NEFT-{yyyy}-{seq:6}');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payout_batches (batch_no, kind, payout_date, total_gross, total_tds, total_net, status, created_by_user_id)
       VALUES ($1,'interest',$2,$3,$4,$5,'PendingChecker',$6) RETURNING id`,
      [batchNo, payoutDate, due.totals.gross, due.totals.tds, due.totals.net, actor.id]
    );
    const batchId = Number(rows[0]!.id);

    // Materialise each pro-rata amount as a schedule row at the payout date and
    // attach it to the batch. Downstream (approve -> Paid, NEFT sheet,
    // reconciliation) already works off batch_id, so it needs no change. Paying
    // the row advances the line's paid-through watermark, so the next sheet
    // starts fresh from this date.
    for (const r of due.rows as Record<string, unknown>[]) {
      const bank = (await tx.query<{ account_number: string; ifsc: string }>(
        `SELECT COALESCE(pb.account_number, cb.account_number) AS account_number,
                COALESCE(pb.ifsc, cb.ifsc) AS ifsc
           FROM applications a
           LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
           LEFT JOIN customer_bank_accounts cb ON cb.customer_id = a.customer_id AND cb.is_active = TRUE
          WHERE a.id = $1 LIMIT 1`, [r.application_id])).rows[0];
      await tx.query(
        `INSERT INTO disbursement_schedule
           (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount,
            status, batch_id, payee_account, payee_ifsc)
         VALUES ($1,$2,$3,'Interest',$4,$5,$6,'Scheduled',$7,$8,$9)
         ON CONFLICT (line_id, due_date, due_type) DO UPDATE
           SET gross_amount = EXCLUDED.gross_amount, tds_amount = EXCLUDED.tds_amount,
               net_amount = EXCLUDED.net_amount, batch_id = EXCLUDED.batch_id`,
        [r.line_id, r.application_id, payoutDate, r.gross_amount, r.tds_amount, r.net_amount,
         batchId, bank?.account_number ?? null, bank?.ifsc ?? null]
      );
      // Supersede any still-unpaid projected rows already covered by this
      // settlement (due on/before the payout date) so they can never be paid
      // twice. Stamp them with this batch_id so a REJECT can un-supersede exactly
      // these rows (and no others).
      await tx.query(
        `UPDATE disbursement_schedule SET status = 'Skipped', batch_id = $3
          WHERE line_id = $1 AND due_type IN ${DUE_TYPES} AND status = 'Scheduled'
            AND batch_id IS NULL AND due_date <= $2`, [r.line_id, payoutDate, batchId]);
    }

    // Creating a batch IS the maker's "this was paid" claim, so it raises the
    // approval right here. Generating/downloading a sheet stays stateless and
    // free (neftSheetForDate) — nothing is reserved until you claim payment.
    const req = await createApprovalRequest(tx, {
      type: 'interest_batch', entityType: 'payout_batches', entityId: batchId, makerUserId: actor.id,
      metadata: { batch_id: batchId, payout_date: payoutDate, net: due.totals.net, count: due.count, utr: utr ?? null },
    });
    await tx.query('UPDATE payout_batches SET approval_request_id = $1 WHERE id = $2', [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'payout.batch.claim-paid', entityType: 'payout_batches', entityId: batchId, after: { batchNo, net: due.totals.net } });
    return { batch_id: batchId, batch_no: batchNo, request: req, ...due };
  });
}

// Approving the payment claim is what actually settles the batch: its rows flip to
// Paid, which advances each line's paid-through watermark, so the next NEFT sheet
// starts fresh from this payout date.
registerOnFinalApprove('interest_batch', async (tx, req) => {
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;
  if (!batchId) return;
  const batch = (await tx.query<{ payout_date: string }>('SELECT payout_date FROM payout_batches WHERE id = $1', [batchId])).rows[0];
  const utr = (req.metadata.utr as string | null) ?? null;
  await tx.query(
    "UPDATE disbursement_schedule SET status = 'Paid', paid_at = $1, utr = COALESCE(utr, $2) WHERE batch_id = $3 AND status = 'Scheduled'",
    [batch?.payout_date ?? null, utr, batchId]);
  await tx.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [batchId]);
});

// On REJECT of an interest batch: reverse the materialisation so the interest
// period is billable again. Without this the rows kept their batch_id, the
// paid-through watermark treated them as paid, and the next batch skipped that
// period → customers were never paid it. (Review 2026-07-21.)
registerOnReject('interest_batch', async (tx, req) => {
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;
  if (!batchId) return;
  // 1) Un-supersede the rows this batch skipped (they carry the batch_id).
  await tx.query("UPDATE disbursement_schedule SET status = 'Scheduled', batch_id = NULL WHERE batch_id = $1 AND status = 'Skipped'", [batchId]);
  // 2) Drop the batch's own materialised (still-Scheduled) rows.
  await tx.query("DELETE FROM disbursement_schedule WHERE batch_id = $1 AND status = 'Scheduled'", [batchId]);
  // 3) Mark the batch failed.
  await tx.query("UPDATE payout_batches SET status = 'Failed' WHERE id = $1", [batchId]);
});

/** Maker states "this batch has been paid out" — that claim goes to a checker.
 * Settlement (rows -> Paid, watermark advance) happens on approval, not here. */
export async function markBatchPaid(db: Db, actor: AuthUser, batchId: number, utr?: string) {
  return db.withTx(async (tx) => {
    const batch = (await tx.query<{ status: string; payout_date: string; batch_no: string; total_net: string }>(
      'SELECT status, payout_date, batch_no, total_net FROM payout_batches WHERE id = $1', [batchId])).rows[0];
    if (!batch) throw errors.notFound('Batch not found');
    if (batch.status === 'Paid') throw errors.conflict('Batch is already settled');
    if (batch.status === 'PendingChecker') throw errors.conflict('Batch is already awaiting a checker');

    const req = await createApprovalRequest(tx, {
      type: 'interest_batch', entityType: 'payout_batches', entityId: batchId, makerUserId: actor.id,
      metadata: { batch_id: batchId, payout_date: batch.payout_date, net: Number(batch.total_net), utr: utr ?? null },
    });
    await tx.query("UPDATE payout_batches SET status = 'PendingChecker', approval_request_id = $1 WHERE id = $2", [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'payout.batch.mark-paid-request', entityType: 'payout_batches', entityId: batchId, after: { utr: utr ?? null } });
    return { batch_id: batchId, status: 'PendingChecker', request: req };
  });
}

export async function listBatches(db: Db) {
  return (await db.query('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 200')).rows;
}

/** Debit account + fallback beneficiary email (Admin -> Settings). */
async function neftHeaderBits(db: Db) {
  const settings = await getSettingsMap(db);
  const asText = (v: unknown): string => {
    const t = (v === null || v === undefined ? '' : String(v)).trim();
    return t === 'null' || t === 'undefined' ? '' : t;
  };
  const debit = (await db.query<{ account_number: string }>(
    "SELECT account_number FROM banks WHERE is_disbursement_account = TRUE AND is_active = TRUE ORDER BY id LIMIT 1")).rows[0];
  return {
    debitAccount: asText(settings['payouts.neft_debit_account']) || debit?.account_number || 'DISBURSEMENT-ACCT',
    fallbackEmail: asText(settings['payouts.neft_beneficiary_email']),
  };
}

/**
 * STATELESS NEFT sheet for any date — computes what has accrued up to that day
 * and hands back the workbook. Writes nothing, reserves nothing, so it can be
 * pulled for as many dates, as many times, as you like. A batch is only created
 * when you claim the money was actually paid (createInterestBatch).
 */
export async function neftSheetForDate(db: Db, payoutDate: string): Promise<Buffer> {
  const due = await previewDue(db, payoutDate);
  if (due.count === 0) throw errors.unprocessable('No interest has accrued up to that date');
  const { debitAccount, fallbackEmail } = await neftHeaderBits(db);
  const withBank = await db.query<Record<string, unknown>>(
    `SELECT l.id AS line_id, c.email,
            COALESCE(pb.account_number, cb.account_number) AS payee_account,
            COALESCE(pb.ifsc, cb.ifsc) AS payee_ifsc
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
       LEFT JOIN customer_bank_accounts cb ON cb.customer_id = a.customer_id AND cb.is_active = TRUE`);
  const bank = new Map(withBank.rows.map((b) => [Number(b.line_id), b]));
  const { buildNeftSheet } = await import('../../lib/neft.js');
  return buildNeftSheet(
    { debitAccount, sheetName: 'Interest', valueDate: new Date() },
    (due.rows as Record<string, unknown>[]).map((r) => {
      const b = bank.get(Number(r.line_id)) ?? {};
      return {
        amount: Number(r.net_amount), valueDate: payoutDate,
        beneAccount: String(b.payee_account ?? ''), beneName: String(r.customer_name ?? ''),
        ifsc: String(b.payee_ifsc ?? ''), email: (b.email as string) || fallbackEmail || '',
        creditRemark: `NCD interest ${r.application_no}`, reference: `UPTO-${payoutDate}`,
      };
    })
  );
}

/** Federal Bank NEFT sheet for an approved interest batch. */
export async function neftForBatch(db: Db, batchId: number): Promise<{ buffer: Buffer; batchNo: string }> {
  const batch = (await db.query<{ batch_no: string; status: string; payout_date: string }>('SELECT batch_no, status, payout_date FROM payout_batches WHERE id = $1', [batchId])).rows[0];
  if (!batch) throw errors.notFound('Batch not found');
  // Downloadable as soon as the batch exists — you need the sheet to make the
  // transfer. (Rows are still 'Scheduled' until the payment claim is approved.)
  // Debit account + fallback beneficiary email are settings-driven (Admin → Settings),
  // falling back to the bank master's disbursement account.
  const settings = await getSettingsMap(db);
  const asText = (v: unknown): string => {
    const t = (v === null || v === undefined ? '' : String(v)).trim();
    return t === 'null' || t === 'undefined' ? '' : t;
  };
  const debitSetting = asText(settings['payouts.neft_debit_account']);
  const fallbackEmail = asText(settings['payouts.neft_beneficiary_email']);
  const debit = (await db.query<{ account_number: string }>("SELECT account_number FROM banks WHERE is_disbursement_account = TRUE AND is_active = TRUE ORDER BY id LIMIT 1")).rows[0];
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT ds.net_amount, ds.due_date, ds.payee_account, ds.payee_ifsc, c.full_name AS name, c.email, a.application_no
     FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ds.batch_id = $1 AND ds.status = 'Scheduled' ORDER BY c.full_name`, [batchId])).rows;
  const { buildNeftSheet } = await import('../../lib/neft.js');
  const buffer = await buildNeftSheet(
    { debitAccount: debitSetting || debit?.account_number || 'DISBURSEMENT-ACCT',
      sheetName: 'Interest',
      valueDate: new Date() },   // value date = the day the sheet is generated
    rows.map((r) => ({
      amount: Number(r.net_amount), valueDate: String(r.due_date),
      beneAccount: String(r.payee_account ?? ''), beneName: String(r.name), ifsc: String(r.payee_ifsc ?? ''),
      email: ((r.email as string) || fallbackEmail) ?? '', creditRemark: `NCD interest ${r.application_no}`, reference: batch.batch_no,
    }))
  );
  if (batch.status === 'Approved') await db.query("UPDATE payout_batches SET status = 'Downloaded' WHERE id = $1", [batchId]);
  return { buffer, batchNo: batch.batch_no };
}

/** Mark a single schedule row failed (e.g. NEFT bounced). */
export async function markRowFailed(db: Db, actor: AuthUser, scheduleId: number, reason: string) {
  const upd = await db.query("UPDATE disbursement_schedule SET status = 'Failed', failure_reason = $1 WHERE id = $2 AND status = 'Scheduled'", [reason, scheduleId]);
  if (!upd.rowCount) throw errors.conflict('Row is not in a failable state');
  await writeAudit(db, { actorId: actor.id, action: 'payout.row.failed', entityType: 'disbursement_schedule', entityId: scheduleId, after: { reason } });
  return { ok: true };
}
