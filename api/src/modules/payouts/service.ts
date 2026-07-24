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
import { emitForApplication } from '../../integrations/lockerhub/customerEvents.js';
import { getSettingsMap } from '../settings/service.js';
import { enqueue, drainOnce } from '../notifications/service.js';

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
      addition_amount: 0, deduction_amount: 0, total_amount: net,
    });
  }

  // Redemption slices (owner 2026-07-24): a redemption's broken-period interest
  // is paid in THAT month's batch, not bundled into the redemption transfer. Its
  // row already exists with exact gross/TDS/net from the redemption request, so
  // it is taken AS IS — never recomputed — and rides along typed 'Redemption'.
  // Not line-status-filtered: a fully redeemed line is no longer Active, but its
  // interest is still owed.
  const { rows: redemptionSlices } = await db.query<Record<string, unknown>>(
    `SELECT ds.id AS schedule_id, ds.line_id, ds.application_id, ds.due_date,
            ds.gross_amount, ds.tds_amount, ds.net_amount,
            a.application_no, c.full_name AS customer_name,
            COALESCE((SELECT max(p.due_date) FROM disbursement_schedule p
                       WHERE p.line_id = ds.line_id AND p.due_date < ds.due_date
                         AND p.due_type IN ${DUE_TYPES} AND p.status = 'Paid'),
                     a.interest_start_date) AS from_date
       FROM disbursement_schedule ds
       JOIN applications a ON a.id = ds.application_id
       JOIN customers c ON c.id = a.customer_id
      WHERE ds.due_type = 'BrokenInterest' AND ds.status = 'Scheduled'
        AND ds.batch_id IS NULL AND ds.due_date <= $1::date
      ORDER BY c.full_name`, [payoutDate]);
  for (const r of redemptionSlices) {
    const gross = Number(r.gross_amount);
    if (!(gross > 0)) continue;
    const from = toISODate(r.from_date as string | null);
    totals.gross += gross; totals.tds += Number(r.tds_amount); totals.net += Number(r.net_amount);
    out.push({
      schedule_id: Number(r.schedule_id),
      line_id: Number(r.line_id), application_id: Number(r.application_id),
      application_no: r.application_no, customer_name: r.customer_name,
      due_date: toISODate(r.due_date as string | null), due_type: 'BrokenInterest',
      row_type: 'Redemption',
      from_date: from, days: from ? daysBetween(from, toISODate(r.due_date as string | null)!) : null,
      gross_amount: gross, tds_amount: Number(r.tds_amount), net_amount: Number(r.net_amount),
      addition_amount: 0, deduction_amount: 0, total_amount: Number(r.net_amount),
    });
  }

  // One-time APPROVED adjustments (owner 2026-07-23) land on the application's
  // next settlement. Net-only: gross/TDS stay pure interest math — gross 1000,
  // TDS 10, net 990, +100 addition → the bank pays 1090. Attached to the
  // application's lowest line_id so a multi-line application applies it once;
  // an application with no accrual this cut-off keeps its adjustment Approved
  // for the next one.
  const appIds = [...new Set(out.map((r) => Number(r.application_id)))];
  const adj = appIds.length
    ? (await db.query<Record<string, unknown>>(
        `SELECT application_id,
                COALESCE(sum(amount) FILTER (WHERE kind = 'Addition'), 0)  AS addition,
                COALESCE(sum(amount) FILTER (WHERE kind = 'Deduction'), 0) AS deduction
           FROM payout_adjustments
          WHERE status = 'Approved' AND application_id = ANY($1)
          GROUP BY application_id`, [appIds])).rows
    : [];
  const firstRowOfApp = new Map<number, Record<string, unknown>>();
  for (const r of out) {
    const prev = firstRowOfApp.get(Number(r.application_id));
    if (!prev || Number(r.line_id) < Number(prev.line_id)) firstRowOfApp.set(Number(r.application_id), r);
  }
  let addTotal = 0, dedTotal = 0;
  for (const a of adj) {
    const row = firstRowOfApp.get(Number(a.application_id));
    if (!row) continue;
    row.addition_amount = round2(Number(a.addition));
    row.deduction_amount = round2(Number(a.deduction));
    row.total_amount = round2(Number(row.net_amount) + Number(a.addition) - Number(a.deduction));
    addTotal += Number(a.addition); dedTotal += Number(a.deduction);
  }

  return {
    rows: out,
    totals: {
      gross: round2(totals.gross), tds: round2(totals.tds), net: round2(totals.net),
      addition: round2(addTotal), deduction: round2(dedTotal),
      total: round2(totals.net + addTotal - dedTotal),
    },
    count: out.length,
  };
}

export async function createInterestBatch(db: Db, actor: AuthUser, payoutDate: string, utr?: string) {
  return db.withTx(async (tx) => {
    const due = await previewDue(tx, payoutDate);
    if (due.count === 0) throw errors.unprocessable(`No interest has accrued up to ${payoutDate} — every investment is already settled to that date or beyond. Pick a later date.`);
    // An approved deduction larger than what has accrued cannot settle — refuse
    // with the application named rather than writing a negative payment.
    const neg = (due.rows as Record<string, unknown>[]).find((r) => Number(r.total_amount) < 0);
    if (neg) throw errors.unprocessable(`Deduction (₹${neg.deduction_amount}) exceeds the interest accrued for ${neg.application_no} (net ₹${neg.net_amount}) — edit or cancel the adjustment first.`);
    const batchNo = await nextCode(tx, 'redemption', 'NEFT-{yyyy}-{seq:6}');
    // total_net is what the bank actually pays — net interest plus additions
    // minus deductions. gross/tds stay pure interest.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payout_batches (batch_no, kind, payout_date, total_gross, total_tds, total_net, status, created_by_user_id)
       VALUES ($1,'interest',$2,$3,$4,$5,'PendingChecker',$6) RETURNING id`,
      [batchNo, payoutDate, due.totals.gross, due.totals.tds, due.totals.total, actor.id]
    );
    const batchId = Number(rows[0]!.id);

    // Materialise each pro-rata amount as a schedule row at the payout date and
    // attach it to the batch. Downstream (approve -> Paid, NEFT sheet,
    // reconciliation) already works off batch_id, so it needs no change. Paying
    // the row advances the line's paid-through watermark, so the next sheet
    // starts fresh from this date.
    // Redemption slices FIRST: they are existing rows, so attaching them stamps
    // batch_id before the pro-rata pass runs its supersede sweep — which only
    // touches rows still `batch_id IS NULL`. Reversed, a partially-withdrawn
    // line's own slice would be Skipped by its pro-rata sibling and never paid.
    for (const r of (due.rows as Record<string, unknown>[]).filter((x) => x.schedule_id)) {
      const bank = (await tx.query<{ account_number: string; ifsc: string }>(
        `SELECT COALESCE(pb.account_number, cb.account_number) AS account_number,
                COALESCE(pb.ifsc, cb.ifsc) AS ifsc
           FROM applications a
           LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
           LEFT JOIN customer_bank_accounts cb ON cb.customer_id = a.customer_id AND cb.is_active = TRUE
          WHERE a.id = $1 LIMIT 1`, [r.application_id])).rows[0];
      await tx.query(
        `UPDATE disbursement_schedule
            SET batch_id = $2, payee_account = COALESCE($3, payee_account), payee_ifsc = COALESCE($4, payee_ifsc)
          WHERE id = $1 AND status = 'Scheduled' AND batch_id IS NULL`,
        [r.schedule_id, batchId, bank?.account_number ?? null, bank?.ifsc ?? null]);
    }

    for (const r of (due.rows as Record<string, unknown>[]).filter((x) => !x.schedule_id)) {
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
            adjustment_amount, status, batch_id, payee_account, payee_ifsc)
         VALUES ($1,$2,$3,'Interest',$4,$5,$6,$7,'Scheduled',$8,$9,$10)
         ON CONFLICT (line_id, due_date, due_type) DO UPDATE
           SET gross_amount = EXCLUDED.gross_amount, tds_amount = EXCLUDED.tds_amount,
               net_amount = EXCLUDED.net_amount, adjustment_amount = EXCLUDED.adjustment_amount,
               batch_id = EXCLUDED.batch_id,
               -- The bank resolved just now beats whatever the projected row was
               -- carrying. Without these two the INSERT's fresh details are
               -- discarded on collision, and a row projected before the customer
               -- had an account stays blank all the way to the bank.
               payee_account = EXCLUDED.payee_account, payee_ifsc = EXCLUDED.payee_ifsc`,
        // net_amount = what the bank pays (net ± adjustments); the applied delta
        // sits in adjustment_amount so chk_ds_net still proves the three agree.
        [r.line_id, r.application_id, payoutDate, r.gross_amount, r.tds_amount, r.total_amount,
         round2(Number(r.addition_amount) - Number(r.deduction_amount)),
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

    // Consume the one-time adjustments this batch applied: they rode into the
    // rows above, so from here they must never apply again. A rejected or
    // cancelled batch releases them back to Approved.
    const appsInBatch = [...new Set((due.rows as Record<string, unknown>[]).map((r) => Number(r.application_id)))];
    if (appsInBatch.length) {
      await tx.query(
        `UPDATE payout_adjustments SET status = 'Consumed', batch_id = $1, updated_at = now()
          WHERE status = 'Approved' AND application_id = ANY($2)`, [batchId, appsInBatch]);
    }

    // Creating a batch IS the maker's "this was paid" claim, so it raises the
    // approval right here. Generating/downloading a sheet stays stateless and
    // free (neftSheetForDate) — nothing is reserved until you claim payment.
    const req = await createApprovalRequest(tx, {
      type: 'interest_batch', entityType: 'payout_batches', entityId: batchId, makerUserId: actor.id,
      metadata: { batch_id: batchId, payout_date: payoutDate, net: due.totals.total, count: due.count, utr: utr ?? null },
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
  // Tell LockerHub each customer's interest was paid (contract event, one per
  // application in the batch). No-op unless the event webhook is configured.
  const paidApps = (await tx.query<{ application_id: string }>(
    'SELECT DISTINCT application_id FROM disbursement_schedule WHERE batch_id = $1', [batchId])).rows;
  for (const a of paidApps) await emitForApplication(tx, 'interest.paid', Number(a.application_id), `batch:${batchId}`);
  // WhatsApp interest-credit messages are NOT sent here: settling a batch fans
  // out one message per paid customer, so it's an explicit staff action instead
  // (POST /payouts/:id/whatsapp-interest → notifyInterestOnWhatsapp) rather than
  // an automatic side effect of the approval.
});

/**
 * Queue + send one WhatsApp per customer paid in a SETTLED batch — their TOTAL
 * net interest for the cut-off (approved ncd_interest_final template). Staff
 * trigger (a settled batch can fan out hundreds of sends, so it's a deliberate
 * click, not an approval side effect). Skips customers with no phone on file.
 */
export async function notifyInterestOnWhatsapp(db: Db, batchId: number): Promise<{ queued: number; skipped: number; sent: number }> {
  const batch = (await db.query<{ status: string; payout_date: string }>(
    'SELECT status, payout_date FROM payout_batches WHERE id = $1', [batchId])).rows[0];
  if (!batch) throw errors.notFound('Batch not found');
  if (batch.status !== 'Paid') throw errors.conflict('Batch is not settled yet — settle it before notifying customers.');

  const { rows } = await db.query<{ full_name: string; phone: string | null; interest: string; month_credit: string; credit_date: string }>(
    `SELECT c.full_name, c.phone,
            SUM(ds.net_amount)::numeric        AS interest,
            to_char($2::date, 'FMMonth YYYY')  AS month_credit,
            to_char($2::date, 'DD-Mon-YYYY')   AS credit_date
       FROM disbursement_schedule ds
       JOIN applications a ON a.id = ds.application_id
       JOIN customers c    ON c.id = a.customer_id
      WHERE ds.batch_id = $1 AND ds.due_type IN ${DUE_TYPES} AND ds.status = 'Paid'
      GROUP BY c.id, c.full_name, c.phone`,
    [batchId, batch.payout_date]);
  const ids: number[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.phone) { skipped++; continue; } // no usable number
    const amount = Number(r.interest).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    ids.push(await enqueue(db, {
      channel: 'whatsapp', template: 'interest_paid', to: r.phone,
      payload: { name: r.full_name, amount, month: r.month_credit, date: r.credit_date },
    }));
  }
  if (ids.length) await drainOnce(db, ids.length + 5); // send now rather than waiting for the cron
  const sent = ids.length
    ? Number((await db.query<{ n: string }>("SELECT count(*)::int n FROM notifications_queue WHERE id = ANY($1) AND status = 'Sent'", [ids])).rows[0]!.n)
    : 0;
  return { queued: ids.length, skipped, sent };
}

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
  // 3) Release the one-time adjustments this batch had consumed — they were
  //    never paid, so they apply to the next settlement instead.
  await tx.query("UPDATE payout_adjustments SET status = 'Approved', batch_id = NULL, updated_at = now() WHERE batch_id = $1 AND status = 'Consumed'", [batchId]);
  // 4) Mark the batch failed.
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
  if (due.count === 0) throw errors.unprocessable(`No interest has accrued up to ${payoutDate} — every investment is already settled to that date or beyond. Pick a later date.`);
  const neg = (due.rows as Record<string, unknown>[]).find((r) => Number(r.total_amount) < 0);
  if (neg) throw errors.unprocessable(`Deduction (₹${neg.deduction_amount}) exceeds the interest accrued for ${neg.application_no} (net ₹${neg.net_amount}) — edit or cancel the adjustment first.`);
  const { debitAccount, fallbackEmail } = await neftHeaderBits(db);
  const withBank = await db.query<Record<string, unknown>>(
    `SELECT l.id AS line_id, c.email,
            COALESCE(pb.account_number, cb.account_number) AS payee_account,
            COALESCE(pb.ifsc, cb.ifsc) AS payee_ifsc,
            COALESCE(pb.holder_name, cb.holder_name) AS beneficiary_name,
            s.name AS series_name
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN series s ON s.id = a.series_id
       LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
       LEFT JOIN customer_bank_accounts cb ON cb.customer_id = a.customer_id AND cb.is_active = TRUE`);
  const bank = new Map(withBank.rows.map((b) => [Number(b.line_id), b]));
  const { buildNeftSheet } = await import('../../lib/neft.js');
  return buildNeftSheet(
    { debitAccount, sheetName: 'Sheet 1', valueDate: new Date(), beneficiaryEmail: fallbackEmail },
    (due.rows as Record<string, unknown>[])
      // A fully-deducted row settles at ₹0 — it can't appear in a bank file.
      .filter((r) => Number(r.total_amount) > 0)
      .map((r) => {
      const b = bank.get(Number(r.line_id)) ?? {};
      return {
        amount: Number(r.total_amount), valueDate: payoutDate,
        beneAccount: String(b.payee_account ?? ''),
        beneName: String(b.beneficiary_name || r.customer_name || ''),
        ifsc: String(b.payee_ifsc ?? ''),
        seriesName: String(b.series_name ?? ''), reference: `UPTO-${payoutDate}`,
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
    // Beneficiary name MUST come from the account the money is actually going
    // to (ds.payee_account), not from whichever account happens to be the
    // customer's default: a customer routing one NCD to another bank would
    // otherwise get that account's number paired with the default's holder
    // name. LATERAL … LIMIT 1 also guarantees one row per payout — a plain
    // join on customer_id could duplicate a row, and a duplicated row in a
    // bank file is a duplicated payment.
    `SELECT ds.net_amount, ds.due_date, ds.payee_account, ds.payee_ifsc, c.full_name AS name, c.email, a.application_no,
            bn.holder_name AS beneficiary_name, s.name AS series_name
     FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id JOIN customers c ON c.id = a.customer_id
     LEFT JOIN series s ON s.id = a.series_id
     LEFT JOIN LATERAL (
       SELECT cba.holder_name FROM customer_bank_accounts cba
        WHERE cba.customer_id = c.id
          AND regexp_replace(COALESCE(cba.account_number,''), '\\s', '', 'g')
            = regexp_replace(COALESCE(ds.payee_account,''), '\\s', '', 'g')
        ORDER BY cba.id DESC LIMIT 1
     ) bn ON TRUE
     WHERE ds.batch_id = $1 AND ds.status = 'Scheduled'
       AND ds.net_amount > 0  -- a fully-deducted row settles at ₹0; banks can't move ₹0
     ORDER BY c.full_name`, [batchId])).rows;
  const { buildNeftSheet } = await import('../../lib/neft.js');
  const buffer = await buildNeftSheet(
    { debitAccount: debitSetting || debit?.account_number || 'DISBURSEMENT-ACCT',
      sheetName: 'Sheet 1',
      valueDate: new Date(),     // value date = the day the sheet is generated
      beneficiaryEmail: fallbackEmail },
    rows.map((r) => ({
      amount: Number(r.net_amount), valueDate: String(r.due_date),
      beneAccount: String(r.payee_account ?? ''),
      beneName: String(r.beneficiary_name || r.name || ''), ifsc: String(r.payee_ifsc ?? ''),
      seriesName: String(r.series_name ?? ''), reference: batch.batch_no,
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

// ── Summary sheet (wealth parity) ─────────────────────────────────────────
// The human companion to the bank NEFT file. Ops reconcile one against the
// other, so it names the customer, the interest period and the gross/TDS/net
// split that the bank sheet (net only) can't show.
const SUMMARY_SELECT = `
  SELECT a.application_no, c.full_name AS customer_name, c.dob AS date_of_birth, c.pan,
         c.gender, c.investor_category AS category,
         s.name AS series_name, l.amount AS investment_amount, l.coupon_rate_pct,
         COALESCE(pb.holder_name, cb.holder_name) AS beneficiary_name,
         COALESCE(ds.payee_account, pb.account_number, cb.account_number) AS account_number,
         COALESCE(ds.payee_ifsc, pb.ifsc, cb.ifsc) AS ifsc,
         ds.due_date AS period_to, ds.gross_amount, ds.tds_amount,
         -- Net = pure interest (gross − TDS). What the bank actually pays is
         -- ds.net_amount, which carries any one-time adjustment — shown as Total.
         (ds.gross_amount - ds.tds_amount) AS net_amount,
         COALESCE(adj.addition, 0)  AS addition_amount,
         COALESCE(adj.deduction, 0) AS deduction_amount,
         ds.net_amount AS total_amount,
         -- Days accrued = this due date minus the previous PAID cut-off for the
         -- same line (or the interest start for a brand-new investment).
         (ds.due_date - COALESCE(
            (SELECT max(p.due_date) FROM disbursement_schedule p
              WHERE p.line_id = ds.line_id AND p.due_date < ds.due_date
                AND p.due_type IN ('Interest','BrokenInterest') AND p.status = 'Paid'),
            a.interest_start_date)) AS period_days,
         CASE
           -- The redemption slice: a BrokenInterest row swept into this batch.
           -- (An interest batch never holds 'Redemption'/'Premature' due_types —
           -- it materialises 'Interest' — so keying off those never fired.)
           WHEN ds.due_type IN ('BrokenInterest','Redemption','Premature') THEN 'Redemption'
           WHEN NOT EXISTS (SELECT 1 FROM disbursement_schedule q
                             WHERE q.line_id = ds.line_id AND q.due_date < ds.due_date AND q.status = 'Paid')
             THEN 'Addition'
           ELSE 'Balance After Redemption'
         END AS row_type
    FROM disbursement_schedule ds
    JOIN applications a ON a.id = ds.application_id
    JOIN application_lines l ON l.id = ds.line_id
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN series s ON s.id = a.series_id
    LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
    LEFT JOIN customer_bank_accounts cb ON cb.customer_id = c.id AND cb.is_active = TRUE
    -- Adjustments consumed by this row's batch, shown ONLY on the application's
    -- first (lowest line_id) row — the row their amount was applied to.
    LEFT JOIN LATERAL (
      SELECT sum(pa.amount) FILTER (WHERE pa.kind = 'Addition')  AS addition,
             sum(pa.amount) FILTER (WHERE pa.kind = 'Deduction') AS deduction
        FROM payout_adjustments pa
       WHERE pa.batch_id = ds.batch_id AND pa.application_id = ds.application_id
         AND pa.status = 'Consumed'
         AND ds.line_id = (SELECT min(d2.line_id) FROM disbursement_schedule d2
                            WHERE d2.batch_id = ds.batch_id AND d2.application_id = ds.application_id
                              AND d2.status <> 'Skipped')
    ) adj ON TRUE`;

/** Summary sheet for a stored batch. */
export async function summaryForBatch(db: Db, batchId: number): Promise<{ buffer: Buffer; batchNo: string }> {
  const batch = (await db.query<{ batch_no: string }>('SELECT batch_no FROM payout_batches WHERE id = $1', [batchId])).rows[0];
  if (!batch) throw errors.notFound('Batch not found');
  const { rows } = await db.query<Record<string, unknown>>(
    `${SUMMARY_SELECT} WHERE ds.batch_id = $1 AND ds.status <> 'Skipped' ORDER BY c.full_name`, [batchId]);
  const { buildSummarySheet } = await import('../../lib/payout-summary.js');
  return { buffer: await buildSummarySheet(rows as never[]), batchNo: batch.batch_no };
}

/**
 * Preview summary/PDF rows — built from previewDue, the SAME pro-rata rows the
 * preview NEFT sheet pays, enriched with the static per-line fields.
 *
 * They used to read projected schedule rows (due_date <= cut-off) instead,
 * which is a different universe: projections sit on month-ends, so mid-cycle
 * the summary 422'd "no interest accrued" while the NEFT sheet for the very
 * same date happily produced 655 rows — and when both did produce, the row
 * sets (and totals) disagreed. Ops reconcile these two documents against each
 * other; they must be two views of one dataset.
 */
async function summaryRowsForDate(db: Db, payoutDate: string): Promise<Record<string, unknown>[]> {
  const due = await previewDue(db, payoutDate);
  if (due.count === 0) throw errors.unprocessable(`No interest has accrued up to ${payoutDate} — every investment is already settled to that date or beyond. Pick a later date.`);
  const lineIds = (due.rows as Record<string, unknown>[]).map((r) => Number(r.line_id));
  const statics = (await db.query<Record<string, unknown>>(
    `SELECT l.id AS line_id, c.dob AS date_of_birth, c.pan, c.gender, c.investor_category AS category,
            s.name AS series_name, l.amount AS investment_amount, l.coupon_rate_pct,
            COALESCE(pb.holder_name, cb.holder_name) AS beneficiary_name,
            COALESCE(pb.account_number, cb.account_number) AS account_number,
            COALESCE(pb.ifsc, cb.ifsc) AS ifsc,
            EXISTS (SELECT 1 FROM disbursement_schedule q
                     WHERE q.line_id = l.id AND q.due_type IN ('Interest','BrokenInterest')
                       AND q.status = 'Paid') AS paid_before
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN series s ON s.id = a.series_id
       LEFT JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id
       LEFT JOIN customer_bank_accounts cb ON cb.customer_id = c.id AND cb.is_active = TRUE
      WHERE l.id = ANY($1)`, [lineIds])).rows;
  const byLine = new Map(statics.map((r) => [Number(r.line_id), r]));
  return (due.rows as Record<string, unknown>[]).map((r) => {
    const st = byLine.get(Number(r.line_id)) ?? {};
    return {
      ...st,
      application_no: r.application_no,
      customer_name: r.customer_name,
      row_type: r.row_type ?? ((st as Record<string, unknown>).paid_before ? 'Balance After Redemption' : 'Addition'),
      period_from: r.from_date,
      period_to: r.due_date,
      period_days: r.days,
      gross_amount: r.gross_amount,
      tds_amount: r.tds_amount,
      net_amount: r.net_amount,
      addition_amount: r.addition_amount,
      deduction_amount: r.deduction_amount,
      total_amount: r.total_amount,
    };
  });
}

/** Summary sheet for the un-batched preview up to a cut-off date. */
export async function summaryForDate(db: Db, payoutDate: string): Promise<Buffer> {
  const rows = await summaryRowsForDate(db, payoutDate);
  const { buildSummarySheet } = await import('../../lib/payout-summary.js');
  return buildSummarySheet(rows as never[]);
}

// ── PDF variants of the two sheets ────────────────────────────────────────
// Same data, printable — ops sign/file these rather than the spreadsheet.
async function summaryPdf(rows: Record<string, unknown>[], title: string, subtitle: string): Promise<Buffer> {
  const { renderPdf, letterhead } = await import('../../lib/pdf.js');
  const money = (v: unknown) => Math.round(Number(v ?? 0)).toLocaleString('en-IN');
  const totals = rows.reduce<{ gross: number; tds: number; net: number }>((t, r) => ({
    gross: t.gross + Number(r.gross_amount ?? 0),
    tds: t.tds + Number(r.tds_amount ?? 0),
    // Payable = what the bank moves: net ± one-time adjustments when present.
    net: t.net + Number(r.total_amount ?? r.net_amount ?? 0),
  }), { gross: 0, tds: 0, net: 0 });

  return renderPdf((doc) => {
    letterhead(doc, title, subtitle);
    const cols = [
      { h: '#', w: 22 }, { h: 'Application', w: 92 }, { h: 'Customer', w: 116 },
      { h: 'Series', w: 66 }, { h: 'Type', w: 50 }, { h: 'Days', w: 30 },
      { h: 'Gross', w: 62 }, { h: 'TDS', w: 52 }, { h: 'Payable', w: 62 },
    ];
    const x0 = doc.page.margins.left;
    const header = (y: number) => {
      doc.fontSize(7.5).font('Helvetica-Bold');
      let x = x0;
      for (const c of cols) { doc.text(c.h, x, y, { width: c.w }); x += c.w; }
      doc.moveTo(x0, y + 11).lineTo(x, y + 11).stroke();
      doc.font('Helvetica');
    };
    let y = doc.y + 6;
    header(y); y += 15;
    rows.forEach((r, i) => {
      if (y > doc.page.height - doc.page.margins.bottom - 46) {
        doc.addPage(); y = doc.page.margins.top; header(y); y += 15;
      }
      const cells = [
        String(i + 1), String(r.application_no ?? ''), String(r.customer_name ?? ''),
        String(r.series_name ?? ''), String(r.row_type ?? 'Balance After Redemption'), String(r.period_days ?? ''),
        money(r.gross_amount), money(r.tds_amount), money(r.total_amount ?? r.net_amount),
      ];
      doc.fontSize(7.5);
      let x = x0;
      cells.forEach((v, ci) => {
        const align = ci >= 5 ? 'right' as const : 'left' as const;
        doc.text(v, x, y, { width: cols[ci]!.w - 4, align, ellipsis: true, lineBreak: false });
        x += cols[ci]!.w;
      });
      y += 12;
    });
    doc.moveTo(x0, y + 2).lineTo(x0 + cols.reduce((s, c) => s + c.w, 0), y + 2).stroke();
    y += 7;
    doc.fontSize(8).font('Helvetica-Bold')
      .text(`${rows.length} row(s)   ·   Gross ₹${money(totals.gross)}   ·   TDS ₹${money(totals.tds)}   ·   Payable ₹${money(totals.net)}`, x0, y);
  });
}

export async function summaryPdfForBatch(db: Db, batchId: number): Promise<{ buffer: Buffer; batchNo: string }> {
  const batch = (await db.query<{ batch_no: string; payout_date: string }>(
    'SELECT batch_no, payout_date FROM payout_batches WHERE id = $1', [batchId])).rows[0];
  if (!batch) throw errors.notFound('Batch not found');
  const { rows } = await db.query<Record<string, unknown>>(`${SUMMARY_SELECT} WHERE ds.batch_id = $1 AND ds.status <> 'Skipped' ORDER BY c.full_name`, [batchId]);
  return {
    buffer: await summaryPdf(rows, 'Interest payout summary', `${batch.batch_no} · payout date ${String(batch.payout_date).slice(0, 10)}`),
    batchNo: batch.batch_no,
  };
}

export async function previewPdf(db: Db, payoutDate: string): Promise<Buffer> {
  // Same rows as the preview NEFT + summary sheets — one dataset, three views.
  const rows = await summaryRowsForDate(db, payoutDate);
  return summaryPdf(rows, 'Interest payout preview', `Everything accrued up to ${payoutDate} · not yet batched`);
}

/**
 * Cancel a batch that hasn't settled: unlink its rows so the interest returns
 * to the un-batched pool and can be re-batched. A settled (Paid) batch is past
 * the point of no return — that needs the reversal path, not this.
 */
export async function cancelBatch(db: Db, actor: AuthUser, batchId: number, reason: string) {
  return db.withTx(async (tx) => {
    const batch = (await tx.query<{ batch_no: string; status: string }>(
      'SELECT batch_no, status FROM payout_batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
    if (!batch) throw errors.notFound('Batch not found');
    if (batch.status === 'Paid') throw errors.conflict('This batch is already settled — it cannot be cancelled.');
    if (batch.status === 'Cancelled') throw errors.conflict('This batch is already cancelled.');
    const paid = (await tx.query('SELECT 1 FROM disbursement_schedule WHERE batch_id = $1 AND status = $2 LIMIT 1', [batchId, 'Paid'])).rowCount;
    if (paid) throw errors.conflict('Some rows in this batch are already Paid — cancel would orphan them.');

    const freed = await tx.query('UPDATE disbursement_schedule SET batch_id = NULL WHERE batch_id = $1', [batchId]);
    // Un-consume the one-time adjustments — nothing was paid, so they apply to
    // the next settlement instead.
    await tx.query("UPDATE payout_adjustments SET status = 'Approved', batch_id = NULL, updated_at = now() WHERE batch_id = $1 AND status = 'Consumed'", [batchId]);
    await tx.query("UPDATE payout_batches SET status = 'Cancelled' WHERE id = $1", [batchId]);
    // Withdraw the pending "mark paid" claim, if one is open.
    await tx.query(
      "UPDATE approval_requests SET status = 'Cancelled' WHERE entity_type = 'payout_batches' AND entity_id = $1 AND status = 'Pending'",
      [String(batchId)]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'payout.batch.cancel', entityType: 'payout_batches', entityId: batchId,
      after: { batch_no: batch.batch_no, from_status: batch.status, reason, rows_released: freed.rowCount ?? 0 },
    });
    return { ok: true, batch_no: batch.batch_no, rows_released: freed.rowCount ?? 0 };
  });
}

/** Settled-cut-off history: which periods have been paid, by whom, for how much. */
export async function cutoffHistory(db: Db, page = 0, pageSize = 20) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT b.id AS batch_id, b.batch_no, b.payout_date AS cutoff_date, b.status,
            b.total_gross AS gross_paid, b.total_tds AS tds_paid, b.total_net AS net_paid,
            b.created_at, u.full_name AS created_by,
            (SELECT count(*) FROM disbursement_schedule d WHERE d.batch_id = b.id) AS rows_paid,
            (SELECT count(DISTINCT d.application_id) FROM disbursement_schedule d WHERE d.batch_id = b.id) AS customers,
            (SELECT max(d.paid_at) FROM disbursement_schedule d WHERE d.batch_id = b.id AND d.status = 'Paid') AS settled_on
       FROM payout_batches b
       LEFT JOIN users u ON u.id = b.created_by_user_id
      WHERE b.kind = 'interest'
      ORDER BY b.payout_date DESC, b.id DESC
      LIMIT $1 OFFSET $2`, [pageSize + 1, page * pageSize]);
  const hasMore = rows.length > pageSize;
  if (hasMore) rows.pop();
  return { rows, page, page_size: pageSize, has_more: hasMore };
}

// ── One-time payout adjustments (owner 2026-07-23) ────────────────────────
// NCD Manager+ records an Addition or Deduction against ONE investment's NEXT
// interest settlement, with a mandatory narration. Admin/CXO approves it in
// the approvals queue; the next batch that pays the application consumes it
// (stamped with the batch) and it never applies again. Net-only — gross/TDS
// stay pure interest: gross 1000, TDS 10, net 990, +100 → the bank pays 1090.

export interface CreateAdjustmentInput {
  application_id: number;
  kind: 'Addition' | 'Deduction';
  amount: number;
  narration: string;
}

export async function createAdjustment(db: Db, actor: AuthUser, input: CreateAdjustmentInput) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<Record<string, unknown>>(
      `SELECT a.id, a.application_no, a.status, c.full_name AS customer
         FROM applications a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1`,
      [input.application_id])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (!OUTSTANDING_APPLICATION_STATUSES.includes(app.status as never)) {
      throw errors.unprocessable(`${app.application_no} is ${app.status} — adjustments apply to live investments only`);
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payout_adjustments (application_id, kind, amount, narration, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.application_id, input.kind, input.amount, input.narration.trim(), actor.id]);
    const adjId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, {
      type: 'payout_adjustment', entityType: 'payout_adjustments', entityId: adjId, makerUserId: actor.id,
      metadata: {
        adjustment_id: adjId, application_id: input.application_id, application_no: app.application_no,
        customer: app.customer, kind: input.kind, amount: input.amount, narration: input.narration.trim(),
      },
    });
    await tx.query('UPDATE payout_adjustments SET approval_request_id = $1 WHERE id = $2', [req.id, adjId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'payout.adjustment.create', entityType: 'payout_adjustments', entityId: adjId,
      after: { application_no: app.application_no, kind: input.kind, amount: input.amount, narration: input.narration.trim() },
    });
    return { id: adjId, request_id: req.id, request_no: req.request_no, status: 'PendingApproval' };
  });
}

registerOnFinalApprove('payout_adjustment', async (tx, req) => {
  const id = req.metadata.adjustment_id ? Number(req.metadata.adjustment_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE payout_adjustments SET status = 'Approved', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [id]);
});

registerOnReject('payout_adjustment', async (tx, req) => {
  const id = req.metadata.adjustment_id ? Number(req.metadata.adjustment_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE payout_adjustments SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [id]);
});

/** Open (pending + approved) adjustments by default; `all` includes history. */
export async function listAdjustments(db: Db, opts: { all?: boolean } = {}) {
  const where = opts.all ? '' : "WHERE pa.status IN ('PendingApproval','Approved')";
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT pa.id, pa.application_id, pa.kind, pa.amount, pa.narration, pa.status, pa.created_at,
            a.application_no, c.full_name AS customer_name, c.customer_code,
            u.full_name AS created_by, b.batch_no
       FROM payout_adjustments pa
       JOIN applications a ON a.id = pa.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users u ON u.id = pa.created_by_user_id
       LEFT JOIN payout_batches b ON b.id = pa.batch_id
       ${where}
      ORDER BY pa.id DESC LIMIT 200`);
  return rows.map((r) => ({ ...r, id: Number(r.id), application_id: Number(r.application_id), amount: Number(r.amount) }));
}

/** Withdraw an adjustment that hasn't settled. Consumed ones are history. */
export async function cancelAdjustment(db: Db, actor: AuthUser, id: number) {
  return db.withTx(async (tx) => {
    const r = (await tx.query<Record<string, unknown>>(
      'SELECT id, status, approval_request_id FROM payout_adjustments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw errors.notFound('Adjustment not found');
    if (r.status !== 'PendingApproval' && r.status !== 'Approved') {
      throw errors.conflict(`This adjustment is ${r.status} — it can no longer be cancelled.`);
    }
    await tx.query("UPDATE payout_adjustments SET status = 'Cancelled', updated_at = now() WHERE id = $1", [id]);
    if (r.approval_request_id) {
      await tx.query("UPDATE approval_requests SET status = 'Cancelled' WHERE id = $1 AND status = 'Pending'", [Number(r.approval_request_id)]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'payout.adjustment.cancel', entityType: 'payout_adjustments', entityId: id, after: { from_status: r.status } });
    return { ok: true };
  });
}
