/**
 * Batch allotment (docs/02 §4). A LATER, data-neutral series step: maker
 * submits a series batch → checker approves → each already-Active application
 * in the series gets its allotment_date stamped and the series locks. It does
 * NOT change status, materialise schedules or accrue incentives — those all
 * happen earlier, at activation (see ../activations). All inside the approval
 * transaction (atomic).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { canTransition } from '../../lib/statusMachine.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';

/** Apps ready to allot = Active in the series but not yet allotted. */
const READY_TO_ALLOT = "a.status = 'Active' AND a.allotment_date IS NULL";

export async function pendingBySeriesSummary(db: Db) {
  // pending_* = investments still to allot (drives the Allot action).
  // total_*   = every live (Active) investment in the series, so the page shows
  //             each series' real investment amount instead of ₹0 when nothing
  //             is pending (owner spec 2026-07-19).
  const { rows } = await db.query(
    `SELECT s.id AS series_id, s.code, s.name, s.status,
            count(a.id) FILTER (WHERE ${READY_TO_ALLOT})::int AS pending_count,
            COALESCE(sum(a.total_amount) FILTER (WHERE ${READY_TO_ALLOT}),0) AS pending_amount,
            count(a.id) FILTER (WHERE a.status = 'Active')::int AS total_count,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status = 'Active'),0) AS total_amount,
            -- the open allotment approval for this series (drives the "Pending
            -- approval" state + Revert on the Allotments page)
            (SELECT ab.approval_request_id FROM allotment_batches ab
              WHERE ab.series_id = s.id AND ab.status = 'PendingChecker'
              ORDER BY ab.id DESC LIMIT 1) AS pending_request_id
     FROM series s LEFT JOIN applications a ON a.series_id = s.id
     GROUP BY s.id, s.code, s.name, s.status ORDER BY s.code`
  );
  return rows;
}

export async function createAllotmentBatch(db: Db, actor: AuthUser, input: { series_id: number; allotment_date: string; isin?: string; notes?: string }) {
  return db.withTx(async (tx) => {
    const series = (await tx.query<{ status: string; code: string }>('SELECT status, code FROM series WHERE id = $1', [input.series_id])).rows[0];
    if (!series) throw errors.notFound('Series not found');
    // One allotment approval per series at a time — clicking Allot twice must not
    // stack duplicate requests (owner 2026-07-21). Cancel the pending one first.
    const already = await tx.query("SELECT 1 FROM allotment_batches WHERE series_id = $1 AND status = 'PendingChecker'", [input.series_id]);
    if (already.rowCount) throw errors.conflict('An allotment approval is already pending for this series');
    const n = Number((await tx.query<{ n: string }>(`SELECT count(*)::int AS n FROM applications a WHERE a.series_id = $1 AND ${READY_TO_ALLOT}`, [input.series_id])).rows[0]!.n);
    // Allow allotting a series that has nothing pending, as long as it can still
    // be moved to Allotted (Open/Closing/Closed) — this just formally closes the
    // series to new money (e.g. a migrated series whose apps already carry an
    // allotment date). Only block when there's genuinely nothing to do: no
    // pending apps AND the series can't move to Allotted (already Allotted/Withdrawn).
    if (n === 0 && !canTransition('series', series.status, 'Allotted')) {
      throw errors.unprocessable('This series is already allotted — nothing to allot');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO allotment_batches (series_id, allotment_date, isin, notes, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,'PendingChecker',$5) RETURNING id`,
      [input.series_id, input.allotment_date, input.isin ?? null, input.notes ?? null, actor.id]
    );
    const batchId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, {
      type: 'allotment_batch',
      entityType: 'allotment_batches',
      entityId: batchId,
      makerUserId: actor.id,
      metadata: { series_id: input.series_id, series_code: series.code, allotment_date: input.allotment_date, isin: input.isin ?? null, batch_id: batchId, count: n },
    });
    await tx.query('UPDATE allotment_batches SET approval_request_id = $1 WHERE id = $2', [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'allotment.submit', entityType: 'allotment_batches', entityId: batchId, after: { series_id: input.series_id, count: n } });
    return { batch_id: batchId, request: req, count: n };
  });
}

/** Revert a series allotment (Super Admin): un-stamp allotment_date and reopen
 * the series. Apps stay Active — their schedules and incentives (booked at
 * activation) are untouched, so this is safe even after interest has paid. */
export async function revertSeriesAllotment(db: Db, actor: AuthUser, seriesId: number, reason: string) {
  return db.withTx(async (tx) => {
    const upd = await tx.query(
      "UPDATE applications SET allotment_date = NULL, batch_allotment_id = NULL, updated_at = now() WHERE series_id = $1 AND allotment_date IS NOT NULL",
      [seriesId]
    );
    if (!upd.rowCount) throw errors.unprocessable('No allotted applications in this series');
    await tx.query("UPDATE series SET status = 'Closing', allotted_at = NULL WHERE id = $1", [seriesId]);
    await writeAudit(tx, { actorId: actor.id, action: 'allotment.revert', entityType: 'series', entityId: seriesId, after: { reason, apps: upd.rowCount } });
    return { reverted: upd.rowCount };
  });
}

/** Cancel the pending allotment approval(s) for a series (allotments:execute) —
 * the "Revert" on the Allotments page while a request is awaiting a checker.
 * Cancels ALL PendingChecker batches (defensive: cleans up any duplicates) and
 * closes their approval requests, so the Allot button re-enables. */
export async function cancelPendingAllotment(db: Db, actor: AuthUser, seriesId: number) {
  return db.withTx(async (tx) => {
    const batches = (await tx.query<{ id: string; approval_request_id: string | null }>(
      "SELECT id, approval_request_id FROM allotment_batches WHERE series_id = $1 AND status = 'PendingChecker'", [seriesId])).rows;
    if (!batches.length) throw errors.notFound('No pending allotment for this series');
    for (const b of batches) {
      await tx.query("UPDATE allotment_batches SET status = 'Cancelled' WHERE id = $1", [b.id]);
      if (b.approval_request_id) {
        await tx.query("UPDATE approval_requests SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'Pending'", [Number(b.approval_request_id)]);
      }
    }
    await writeAudit(tx, { actorId: actor.id, action: 'allotment.cancel-pending', entityType: 'series', entityId: seriesId, after: { cancelled: batches.length } });
    return { cancelled: batches.length };
  });
}

registerOnFinalApprove('allotment_batch', async (tx, req) => {
  const seriesId = Number(req.metadata.series_id);
  // The approver may override the maker's date at approval time (incl. a past
  // date) — it's merged into metadata by approve(). Allotment is a data-neutral
  // stamp (no schedule/maturity recompute), so a backdated date is safe.
  const allotmentDate = String(req.metadata.allotment_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(allotmentDate)) throw errors.badRequest('Invalid allotment date (expected YYYY-MM-DD)');
  const isin = (req.metadata.isin as string | null) ?? null;
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;

  // Stamp allotment_date on the already-Active, not-yet-allotted apps. No
  // status change, no schedule/incentive work — those ran at activation.
  await tx.query(
    `UPDATE applications AS a SET allotment_date = $1, batch_allotment_id = $2, updated_at = now()
      WHERE a.series_id = $3 AND ${READY_TO_ALLOT}`,
    [allotmentDate, batchId, seriesId]
  );

  if (batchId) await tx.query("UPDATE allotment_batches SET status = 'Approved' WHERE id = $1", [batchId]);

  // Lock the series (Open/Closing → Allotted). Tolerate already-Allotted.
  const series = (await tx.query<{ status: string }>('SELECT status FROM series WHERE id = $1', [seriesId])).rows[0];
  if (series && canTransition('series', series.status, 'Allotted')) {
    await tx.query("UPDATE series SET status = 'Allotted', allotted_at = now()" + (isin ? ', isin = $2' : '') + ' WHERE id = $1', isin ? [seriesId, isin] : [seriesId]);
  } else if (isin) {
    await tx.query('UPDATE series SET isin = $2 WHERE id = $1', [seriesId, isin]);
  }
});

