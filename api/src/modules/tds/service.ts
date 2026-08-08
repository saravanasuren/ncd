/**
 * TDS applicability on crossing the cumulative-investment threshold
 * (owner 2026-08-07).
 *
 * A customer can start TDS-not-applicable (Form 121 on file). Once their
 * OUTSTANDING NCD book crosses the threshold (default ₹30L), they must become
 * TDS-applicable, AND the TDS on the interest already paid to them while untaxed
 * has to be recovered — as a ONE-TIME deduction on the next interest payout.
 *
 * Flow (all through Approvals):
 *   1. A nightly scan finds customers over the threshold who are still
 *      not-applicable and have no open event, computes the recovery, and raises
 *      ONE `tds_threshold` approval (Admin/CXO).
 *   2. On approval: the customer flips to TDS-applicable and the recovery is
 *      written as an APPROVED payout_adjustment (Deduction) on their largest
 *      live investment — the next interest batch consumes it exactly once
 *      (payout_adjustments: Approved → Consumed), so it is never re-charged.
 *   3. tds_threshold_events is the audit trail and the guard against re-raising.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

const OUT_SQL = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');

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

export interface TdsScanResult { scanned: number; raised: number; customers: Array<{ customer_id: number; outstanding: number; tds_to_recover: number; request_no: string }> }

/**
 * Nightly detection. Finds not-applicable customers whose outstanding book is
 * over the threshold and who have no event in flight, and raises the approval.
 */
export async function scanTdsThreshold(db: Db, actor?: AuthUser): Promise<TdsScanResult> {
  const cfg = await config(db);
  // Candidates: active, not-applicable customers whose live book is over the
  // threshold and who don't already have an open/applied event.
  const candidates = (await db.query<{ id: string; pan: string | null; outstanding: string; crossed_on: string | null }>(
    `SELECT c.id, c.pan,
            COALESCE(SUM(al.outstanding_amount) FILTER (WHERE al.status = 'Active'), 0) AS outstanding,
            MAX(a.date_money_received) AS crossed_on
       FROM customers c
       JOIN applications a ON a.customer_id = c.id AND a.status IN (${OUT_SQL})
       JOIN application_lines al ON al.application_id = a.id
      WHERE c.is_active = TRUE AND c.archived_at IS NULL
        AND COALESCE(c.tds_applicable, TRUE) = FALSE
        AND NOT EXISTS (SELECT 1 FROM tds_threshold_events e
                         WHERE e.customer_id = c.id AND e.status IN ('PendingApproval','Applied'))
      GROUP BY c.id, c.pan
     HAVING COALESCE(SUM(al.outstanding_amount) FILTER (WHERE al.status = 'Active'), 0) >= $1`,
    [cfg.threshold])).rows;

  const out: TdsScanResult = { scanned: candidates.length, raised: 0, customers: [] };
  for (const c of candidates) {
    const customerId = Number(c.id);
    const outstanding = round2(Number(c.outstanding));
    const rate = c.pan && String(c.pan).trim() ? cfg.rateWithPan : cfg.rateWithoutPan;
    const base = await interestPaidUntaxed(db, customerId);
    const tds = round2(base * rate / 100);
    const req = await db.withTx(async (tx) => {
      // Re-check the guard inside the tx (a concurrent scan / manual flip).
      const open = (await tx.query('SELECT 1 FROM tds_threshold_events WHERE customer_id = $1 AND status IN (\'PendingApproval\',\'Applied\')', [customerId])).rowCount;
      if (open) return null;
      const ev = (await tx.query<{ id: string }>(
        `INSERT INTO tds_threshold_events (customer_id, outstanding_at_crossing, crossed_on, interest_paid_untaxed, tds_rate_pct, tds_to_recover)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [customerId, outstanding, c.crossed_on, base, rate, tds])).rows[0]!;
      const eventId = Number(ev.id);
      const cust = (await tx.query<{ full_name: string; customer_code: string }>('SELECT full_name, customer_code FROM customers WHERE id = $1', [customerId])).rows[0]!;
      const request = await createApprovalRequest(tx, {
        type: 'tds_threshold', entityType: 'tds_threshold_events', entityId: eventId, makerUserId: actor?.id ?? null,
        metadata: {
          event_id: eventId, customer_id: customerId, customer: cust.full_name, customer_code: cust.customer_code,
          outstanding, crossed_on: c.crossed_on, interest_paid_untaxed: base, tds_rate_pct: rate, tds_to_recover: tds,
        },
      });
      await tx.query('UPDATE tds_threshold_events SET approval_request_id = $1 WHERE id = $2', [request.id, eventId]);
      await writeAudit(tx, { actorId: actor?.id ?? null, action: 'tds.threshold.detected', entityType: 'tds_threshold_events', entityId: eventId,
        after: { customer_id: customerId, outstanding, interest_paid_untaxed: base, tds_rate_pct: rate, tds_to_recover: tds } });
      return request;
    });
    if (req) { out.raised++; out.customers.push({ customer_id: customerId, outstanding, tds_to_recover: tds, request_no: req.request_no }); }
  }
  return out;
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

registerOnReject('tds_threshold', async (tx, req) => {
  const eventId = req.metadata.event_id ? Number(req.metadata.event_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!eventId) return;
  await tx.query("UPDATE tds_threshold_events SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [eventId]);
});
