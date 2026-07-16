/**
 * Interest NEFT payout batches (docs/02 §5). Maker previews due interest,
 * creates a batch (maker-checker); on approval it unlocks; admin marks paid,
 * which flips the schedule rows to Paid at value date.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';
import { nextCode } from '../../lib/sequences.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';

const DUE_TYPES = "('Interest','BrokenInterest')";

export async function previewDue(db: Db, payoutDate: string) {
  const { rows } = await db.query(
    `SELECT ds.id, ds.application_id, ds.due_date, ds.due_type, ds.gross_amount, ds.tds_amount, ds.net_amount,
            a.application_no, c.full_name AS customer_name
     FROM disbursement_schedule ds
     JOIN applications a ON a.id = ds.application_id
     JOIN customers c ON c.id = a.customer_id
     WHERE ds.status = 'Scheduled' AND ds.batch_id IS NULL AND ds.due_type IN ${DUE_TYPES} AND ds.due_date <= $1
     ORDER BY ds.due_date`,
    [payoutDate]
  );
  const totals = { gross: 0, tds: 0, net: 0 };
  for (const r of rows) {
    totals.gross += Number(r.gross_amount);
    totals.tds += Number(r.tds_amount);
    totals.net += Number(r.net_amount);
  }
  return { rows, totals: { gross: round2(totals.gross), tds: round2(totals.tds), net: round2(totals.net) }, count: rows.length };
}

export async function createInterestBatch(db: Db, actor: AuthUser, payoutDate: string) {
  return db.withTx(async (tx) => {
    const due = await previewDue(tx, payoutDate);
    if (due.count === 0) throw errors.unprocessable('No interest is due on or before that date');
    const batchNo = await nextCode(tx, 'redemption', 'NEFT-{yyyy}-{seq:6}');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payout_batches (batch_no, kind, payout_date, total_gross, total_tds, total_net, status, created_by_user_id)
       VALUES ($1,'interest',$2,$3,$4,$5,'PendingChecker',$6) RETURNING id`,
      [batchNo, payoutDate, due.totals.gross, due.totals.tds, due.totals.net, actor.id]
    );
    const batchId = Number(rows[0]!.id);
    await tx.query(
      `UPDATE disbursement_schedule SET batch_id = $1 WHERE status = 'Scheduled' AND batch_id IS NULL AND due_type IN ${DUE_TYPES} AND due_date <= $2`,
      [batchId, payoutDate]
    );
    const req = await createApprovalRequest(tx, {
      type: 'interest_batch', entityType: 'payout_batches', entityId: batchId, makerUserId: actor.id,
      metadata: { batch_id: batchId, payout_date: payoutDate, net: due.totals.net, count: due.count },
    });
    await tx.query('UPDATE payout_batches SET approval_request_id = $1 WHERE id = $2', [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'payout.batch.create', entityType: 'payout_batches', entityId: batchId, after: { batchNo, net: due.totals.net } });
    return { batch_id: batchId, batch_no: batchNo, request: req, ...due };
  });
}

registerOnFinalApprove('interest_batch', async (tx, req) => {
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;
  if (batchId) await tx.query("UPDATE payout_batches SET status = 'Approved' WHERE id = $1", [batchId]);
});

export async function markBatchPaid(db: Db, actor: AuthUser, batchId: number, utrPrefix?: string) {
  return db.withTx(async (tx) => {
    const batch = (await tx.query<{ status: string; payout_date: string }>('SELECT status, payout_date FROM payout_batches WHERE id = $1', [batchId])).rows[0];
    if (!batch) throw errors.notFound('Batch not found');
    if (batch.status !== 'Approved') throw errors.conflict('Batch must be Approved before it can be marked paid');
    const upd = await tx.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $1, utr = COALESCE(utr, $2) WHERE batch_id = $3 AND status = 'Scheduled'",
      [batch.payout_date, utrPrefix ?? null, batchId]);
    await tx.query("UPDATE payout_batches SET status = 'Reconciled' WHERE id = $1", [batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'payout.batch.paid', entityType: 'payout_batches', entityId: batchId, after: { rows: upd.rowCount } });
    return { paid: upd.rowCount };
  });
}

export async function listBatches(db: Db) {
  return (await db.query('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 200')).rows;
}
