/**
 * TDS applicability on crossing the cumulative-investment threshold
 * (owner 2026-08-07, gaps closed 2026-08-08).
 *
 * A customer can start TDS-not-applicable (Form 121 on file). Once their
 * OUTSTANDING NCD book crosses the threshold (default ₹30L), they must become
 * TDS-applicable, AND the TDS on the interest already paid to them while untaxed
 * has to be recovered — as a ONE-TIME deduction on the next interest payout.
 *
 * Flow (all through Approvals):
 *   1. A nightly scan finds customers over the threshold who are still
 *      not-applicable and have no event on record, computes the recovery, and
 *      raises ONE `tds_threshold` approval (Admin/CXO).
 *   2. On approval: the customer flips to TDS-applicable and the recovery is
 *      written as an APPROVED payout_adjustment (Deduction) on their largest
 *      live investment — the next interest batch consumes it exactly once
 *      (payout_adjustments: Approved → Consumed), so it is never re-charged.
 *   3. tds_threshold_events is the audit trail and the guard against re-raising.
 *
 * TWO DOORS lead to TDS-applicable, and BOTH must recover the past TDS:
 *   - this scan (source 'scan'), and
 *   - the ">₹30L for a No-TDS customer → apply TDS?" prompt staff answer at
 *     enrolment (source 'enrolment', raised via raiseEnrolmentTdsRecovery).
 *     That door used to flip the flag and collect nothing.
 *
 * A REJECTED event is FINAL — the scan will not raise it again (before, the
 * 6-hourly cron re-asked within hours of a rejection, forever). `reopenTdsEvent`
 * is the explicit way to put a customer back in scope.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';
import { errors } from '../../lib/errors.js';

const OUT_SQL = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');

/** Statuses that mean "this customer has been dealt with — do not raise again".
 *  Rejected is in here on purpose: the owner said no, and no means no until
 *  someone reopens it. 'Reopened' is deliberately absent. */
const SETTLED_SQL = "('PendingApproval','Applied','Rejected')";

interface TdsConfig { threshold: number; rateWithPan: number; rateWithoutPan: number }
async function config(db: Db): Promise<TdsConfig> {
  const s = await getSettingsMap(db);
  return {
    threshold: Number(s['tds.threshold_amount'] ?? 3000000) || 3000000,
    rateWithPan: Number(s['tds.rate_with_pan_pct'] ?? 10) || 10,
    rateWithoutPan: Number(s['tds.rate_without_pan_pct'] ?? 20) || 20,
  };
}

/** Interest ALREADY PAID to a customer with no TDS withheld (i.e. while they
 *  were not-applicable). This is the base the recovery is computed on. */
async function interestPaidUntaxed(db: Db, customerId: number): Promise<number> {
  const r = (await db.query<{ v: string }>(
    `SELECT COALESCE(SUM(ds.gross_amount), 0) AS v
       FROM disbursement_schedule ds
       JOIN application_lines al ON al.id = ds.line_id
       JOIN applications a ON a.id = al.application_id
      WHERE a.customer_id = $1
        AND ds.due_type IN ('Interest','BrokenInterest')
        AND ds.status = 'Paid'
        AND COALESCE(ds.tds_amount, 0) = 0`, [customerId])).rows[0];
  return round2(Number(r?.v ?? 0));
}

/** The customer's live book right now, plus a best-effort crossing date. */
async function bookSnapshot(db: Db, customerId: number): Promise<{ outstanding: number; crossed_on: string | null; pan: string | null }> {
  const r = (await db.query<{ pan: string | null; outstanding: string; crossed_on: string | null }>(
    `SELECT c.pan,
            COALESCE(SUM(al.outstanding_amount) FILTER (WHERE al.status = 'Active'), 0) AS outstanding,
            MAX(a.date_money_received) AS crossed_on
       FROM customers c
       LEFT JOIN applications a ON a.customer_id = c.id AND a.status IN (${OUT_SQL})
       LEFT JOIN application_lines al ON al.application_id = a.id
      WHERE c.id = $1
      GROUP BY c.id, c.pan`, [customerId])).rows[0];
  return { outstanding: round2(Number(r?.outstanding ?? 0)), crossed_on: r?.crossed_on ?? null, pan: r?.pan ?? null };
}

/**
 * Insert the event + raise the approval, inside an existing transaction.
 * Returns null when the customer already has a settled event (the guard against
 * double-charging and against re-asking a question already answered).
 */
async function raiseRecovery(tx: Db, opts: {
  customerId: number; outstanding: number; crossedOn: string | null; base: number;
  rate: number; actorId: number | null; source: 'scan' | 'enrolment'; isEstimate: boolean;
}): Promise<{ id: number; request_no: string; tds: number } | null> {
  const { customerId, outstanding, crossedOn, base, rate, actorId, source, isEstimate } = opts;
  // Re-check inside the tx — a concurrent scan, or a manual flip since the read.
  const settled = (await tx.query(
    `SELECT 1 FROM tds_threshold_events WHERE customer_id = $1 AND status IN ${SETTLED_SQL}`, [customerId])).rowCount;
  if (settled) return null;

  const tds = round2(base * rate / 100);
  const ev = (await tx.query<{ id: string }>(
    `INSERT INTO tds_threshold_events (customer_id, outstanding_at_crossing, crossed_on, interest_paid_untaxed, tds_rate_pct, tds_to_recover, source, is_estimate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [customerId, outstanding, crossedOn, base, rate, tds, source, isEstimate])).rows[0]!;
  const eventId = Number(ev.id);
  const cust = (await tx.query<{ full_name: string; customer_code: string }>(
    'SELECT full_name, customer_code FROM customers WHERE id = $1', [customerId])).rows[0]!;
  const request = await createApprovalRequest(tx, {
    type: 'tds_threshold', entityType: 'tds_threshold_events', entityId: eventId, makerUserId: actorId,
    metadata: {
      event_id: eventId, customer_id: customerId, customer: cust.full_name, customer_code: cust.customer_code,
      outstanding, crossed_on: crossedOn, interest_paid_untaxed: base, tds_rate_pct: rate, tds_to_recover: tds,
      source, is_estimate: isEstimate,
    },
  });
  await tx.query('UPDATE tds_threshold_events SET approval_request_id = $1 WHERE id = $2', [request.id, eventId]);
  await writeAudit(tx, { actorId, action: 'tds.threshold.detected', entityType: 'tds_threshold_events', entityId: eventId,
    after: { customer_id: customerId, outstanding, interest_paid_untaxed: base, tds_rate_pct: rate, tds_to_recover: tds, source, is_estimate: isEstimate } });
  return { id: eventId, request_no: request.request_no, tds };
}

export interface TdsScanResult { scanned: number; raised: number; customers: Array<{ customer_id: number; outstanding: number; tds_to_recover: number; request_no: string }> }

/**
 * Nightly detection. Finds not-applicable customers whose outstanding book is
 * over the threshold and who have no settled event, and raises the approval.
 */
export async function scanTdsThreshold(db: Db, actor?: AuthUser): Promise<TdsScanResult> {
  const cfg = await config(db);
  const candidates = (await db.query<{ id: string; pan: string | null; outstanding: string; crossed_on: string | null }>(
    `SELECT c.id, c.pan,
            COALESCE(SUM(al.outstanding_amount) FILTER (WHERE al.status = 'Active'), 0) AS outstanding,
            MAX(a.date_money_received) AS crossed_on
       FROM customers c
       JOIN applications a ON a.customer_id = c.id AND a.status IN (${OUT_SQL})
       JOIN application_lines al ON al.application_id = a.id
      WHERE c.is_active = TRUE AND c.archived_at IS NULL
        AND COALESCE(c.tds_applicable, TRUE) = FALSE
        -- Senior citizens are out of scope for the ₹30L alert entirely, however
        -- large their book (owner 2026-08-11). 60+ is the SAME definition the
        -- TDS report already uses to choose Form 15H over 15G (§194A) — reused
        -- rather than restated, so the two can never drift apart.
        --
        -- A customer with NO date of birth is NOT treated as senior: we cannot
        -- show that they are, and the two mistakes are not equal. Flagging
        -- someone who turns out to be exempt is visible and reversible on this
        -- screen; NOT flagging someone who is liable loses tax silently.
        AND NOT (c.dob IS NOT NULL AND EXTRACT(YEAR FROM age(current_date, c.dob)) >= 60)
        AND NOT EXISTS (SELECT 1 FROM tds_threshold_events e
                         WHERE e.customer_id = c.id AND e.status IN ${SETTLED_SQL})
      GROUP BY c.id, c.pan
     -- STRICTLY over the threshold: a book sitting exactly ON ₹30L must NOT
     -- flag (owner 2026-08-10) — only ₹30,00,001 and above crosses.
     HAVING COALESCE(SUM(al.outstanding_amount) FILTER (WHERE al.status = 'Active'), 0) > $1`,
    [cfg.threshold])).rows;

  const out: TdsScanResult = { scanned: candidates.length, raised: 0, customers: [] };
  for (const c of candidates) {
    const customerId = Number(c.id);
    const outstanding = round2(Number(c.outstanding));
    const rate = c.pan && String(c.pan).trim() ? cfg.rateWithPan : cfg.rateWithoutPan;
    const base = await interestPaidUntaxed(db, customerId);
    // NOTE: raised even when the recovery works out to ₹0 — this approval's
    // other job is the flip to TDS-applicable, which must still happen.
    const req = await db.withTx((tx) => raiseRecovery(tx, {
      customerId, outstanding, crossedOn: c.crossed_on, base, rate,
      actorId: actor?.id ?? null, source: 'scan', isEstimate: false,
    }));
    if (req) { out.raised++; out.customers.push({ customer_id: customerId, outstanding, tds_to_recover: req.tds, request_no: req.request_no }); }
  }
  return out;
}

/**
 * The OTHER door: staff answered "yes" to the ">₹30L → apply TDS?" prompt while
 * recording an investment, which flips the customer immediately. The past TDS
 * still has to be collected, so raise the same recovery approval.
 *
 * The figure is an ESTIMATE (flagged as such on the approval card): it applies
 * one flat rate to all interest already paid, whereas the historic payouts may
 * each have been taxed differently. The approver eyeballs it before it becomes a
 * deduction.
 *
 * Runs inside the enrolment transaction. Never throws the enrolment away — a
 * customer with nothing paid out yet has nothing to recover and gets no card.
 */
export async function raiseEnrolmentTdsRecovery(tx: Db, customerId: number, actorId: number | null): Promise<number | null> {
  const cfg = await config(tx);
  const base = await interestPaidUntaxed(tx, customerId);
  if (base <= 0) return null; // nothing was ever paid untaxed — nothing to recover
  const snap = await bookSnapshot(tx, customerId);
  const rate = snap.pan && snap.pan.trim() ? cfg.rateWithPan : cfg.rateWithoutPan;
  const req = await raiseRecovery(tx, {
    customerId, outstanding: snap.outstanding, crossedOn: snap.crossed_on, base, rate,
    actorId, source: 'enrolment', isEstimate: true,
  });
  return req ? req.tds : null;
}

export interface TdsEventRow {
  id: number; customer_id: number; customer: string; customer_code: string | null;
  outstanding_at_crossing: number; crossed_on: string | null; interest_paid_untaxed: number;
  tds_rate_pct: number; tds_to_recover: number; status: string; source: string; is_estimate: boolean;
  request_no: string | null; payout_adjustment_id: number | null; created_at: string;
}

/** History: every ₹30L crossing, what it recovered, and how it ended. */
export async function listTdsEvents(db: Db, opts: { status?: string } = {}): Promise<TdsEventRow[]> {
  const params: unknown[] = [];
  // 'Withdrawn' events were auto-flagged in error (e.g. a book sitting exactly
  // ON ₹30L, before the threshold went strictly-over) and pulled back — they
  // are NOT a crossing and must never appear on this list under any filter
  // (owner 2026-08-10). A genuine later crossing raises a fresh event, so this
  // hides only the mistakes, never a real one.
  const conds: string[] = ["e.status <> 'Withdrawn'"];
  if (opts.status) { params.push(opts.status); conds.push(`e.status = $${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT e.id, e.customer_id, c.full_name AS customer, c.customer_code,
            e.outstanding_at_crossing, e.crossed_on, e.interest_paid_untaxed, e.tds_rate_pct,
            e.tds_to_recover, e.status, e.source, e.is_estimate, e.payout_adjustment_id, e.created_at,
            ar.request_no
       FROM tds_threshold_events e
       JOIN customers c ON c.id = e.customer_id
       LEFT JOIN approval_requests ar ON ar.id = e.approval_request_id
       ${where}
      ORDER BY e.created_at DESC, e.id DESC`, params)).rows;
  return rows.map((r) => ({
    id: Number(r.id), customer_id: Number(r.customer_id), customer: String(r.customer),
    customer_code: (r.customer_code as string) ?? null,
    outstanding_at_crossing: Number(r.outstanding_at_crossing), crossed_on: (r.crossed_on as string) ?? null,
    interest_paid_untaxed: Number(r.interest_paid_untaxed), tds_rate_pct: Number(r.tds_rate_pct),
    tds_to_recover: Number(r.tds_to_recover), status: String(r.status), source: String(r.source ?? 'scan'),
    is_estimate: Boolean(r.is_estimate), request_no: (r.request_no as string) ?? null,
    payout_adjustment_id: r.payout_adjustment_id ? Number(r.payout_adjustment_id) : null,
    created_at: String(r.created_at),
  }));
}

/**
 * Un-dismiss a rejected event: the customer goes back in scope and the next scan
 * may raise a fresh approval. Only a Rejected event can be reopened — Applied is
 * done and PendingApproval is already in front of someone.
 */
export async function reopenTdsEvent(db: Db, actor: AuthUser, eventId: number): Promise<{ id: number; status: string }> {
  return db.withTx(async (tx) => {
    const ev = (await tx.query<{ status: string; customer_id: string }>(
      'SELECT status, customer_id FROM tds_threshold_events WHERE id = $1', [eventId])).rows[0];
    if (!ev) throw errors.notFound('TDS event not found');
    if (ev.status !== 'Rejected') throw errors.badRequest(`Only a rejected event can be reopened (this one is ${ev.status})`);
    await tx.query(
      "UPDATE tds_threshold_events SET status = 'Reopened', reopened_at = now(), reopened_by_user_id = $1, updated_at = now() WHERE id = $2",
      [actor.id, eventId]);
    await writeAudit(tx, { actorId: actor.id, action: 'tds.threshold.reopened', entityType: 'tds_threshold_events', entityId: eventId,
      before: { status: 'Rejected' }, after: { status: 'Reopened', customer_id: Number(ev.customer_id) } });
    return { id: eventId, status: 'Reopened' };
  });
}

// On approval: flip the customer to TDS-applicable and write the recovery as an
// APPROVED one-time Deduction on their largest live investment (consumed once by
// the next interest batch). Runs inside the approval transaction.
registerOnFinalApprove('tds_threshold', async (tx, req) => {
  const eventId = req.metadata.event_id ? Number(req.metadata.event_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!eventId) return;
  const ev = (await tx.query<Record<string, unknown>>(
    "SELECT * FROM tds_threshold_events WHERE id = $1 AND status = 'PendingApproval'", [eventId])).rows[0];
  if (!ev) return; // already handled
  const customerId = Number(ev.customer_id);
  const tds = round2(Number(ev.tds_to_recover));

  // Who approved (the checker, from approval_actions — ApprovalRow carries the maker).
  const act = (await tx.query<{ approver_user_id: string }>(
    "SELECT approver_user_id FROM approval_actions WHERE approval_request_id = $1 AND action = 'approve' ORDER BY id DESC LIMIT 1", [req.id])).rows[0];
  const approverId = act ? Number(act.approver_user_id) : null;

  await tx.query('UPDATE customers SET tds_applicable = TRUE, updated_at = now() WHERE id = $1', [customerId]);

  let adjustmentId: number | null = null;
  if (tds > 0) {
    // Attach to the customer's largest live investment — most likely to have
    // enough interest next cycle to absorb the deduction (the batch guards that).
    const app = (await tx.query<{ id: string }>(
      `SELECT a.id FROM applications a
        WHERE a.customer_id = $1 AND a.status IN (${OUT_SQL})
        ORDER BY a.total_amount DESC, a.id LIMIT 1`, [customerId])).rows[0];
    if (app) {
      const adj = (await tx.query<{ id: string }>(
        `INSERT INTO payout_adjustments (application_id, kind, amount, narration, status, approval_request_id, created_by_user_id)
         VALUES ($1, 'Deduction', $2, $3, 'Approved', $4, $5) RETURNING id`,
        [Number(app.id), tds, `TDS recovery on interest paid before ₹30L threshold (${Number(ev.tds_rate_pct)}%)`, req.id, approverId])).rows[0]!;
      adjustmentId = Number(adj.id);
    }
  }
  await tx.query("UPDATE tds_threshold_events SET status = 'Applied', payout_adjustment_id = $1, updated_at = now() WHERE id = $2", [adjustmentId, eventId]);
  await writeAudit(tx, { actorId: approverId, action: 'tds.threshold.applied', entityType: 'tds_threshold_events', entityId: eventId,
    after: { customer_id: customerId, tds_to_recover: tds, payout_adjustment_id: adjustmentId, tds_applicable: true } });
});

// Rejected is FINAL — the scan skips this customer from now on. Reopening from
// the TDS page is the only way back.
registerOnReject('tds_threshold', async (tx, req) => {
  const eventId = req.metadata.event_id ? Number(req.metadata.event_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!eventId) return;
  await tx.query("UPDATE tds_threshold_events SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [eventId]);
});
