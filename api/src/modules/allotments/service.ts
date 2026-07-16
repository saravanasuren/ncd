/**
 * Batch allotment (docs/02 §4). Maker submits a series batch → checker
 * approves → every PendingAllotment app in the series goes Active, its
 * schedule is materialised, incentives accrue, and the series locks.
 * All inside the approval transaction (atomic).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition, canTransition } from '../../lib/statusMachine.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { materializeForApplication } from '../schedule/materialize.js';
import { accrueForApplication } from '../incentives/accrual.js';

export async function pendingBySeriesSummary(db: Db) {
  const { rows } = await db.query(
    `SELECT s.id AS series_id, s.code, s.name, s.status,
            count(a.id) FILTER (WHERE a.status = 'PendingAllotment')::int AS pending_count,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status = 'PendingAllotment'),0) AS pending_amount
     FROM series s LEFT JOIN applications a ON a.series_id = s.id
     GROUP BY s.id, s.code, s.name, s.status ORDER BY s.code`
  );
  return rows;
}

export async function createAllotmentBatch(db: Db, actor: AuthUser, input: { series_id: number; allotment_date: string; isin?: string; notes?: string }) {
  return db.withTx(async (tx) => {
    const n = Number((await tx.query<{ n: string }>("SELECT count(*)::int AS n FROM applications WHERE series_id = $1 AND status = 'PendingAllotment'", [input.series_id])).rows[0]!.n);
    if (n === 0) throw errors.unprocessable('No applications are pending allotment in this series');
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
      metadata: { series_id: input.series_id, allotment_date: input.allotment_date, isin: input.isin ?? null, batch_id: batchId, count: n },
    });
    await tx.query('UPDATE allotment_batches SET approval_request_id = $1 WHERE id = $2', [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'allotment.submit', entityType: 'allotment_batches', entityId: batchId, after: { series_id: input.series_id, count: n } });
    return { batch_id: batchId, request: req, count: n };
  });
}

/** Revert a series allotment (Super Admin). Blocked once real interest/
 * incentive money has moved. Undoes activation + schedules + accruals. */
export async function revertSeriesAllotment(db: Db, actor: AuthUser, seriesId: number, reason: string) {
  return db.withTx(async (tx) => {
    const apps = (await tx.query<{ id: string }>("SELECT id FROM applications WHERE series_id = $1 AND status = 'Active'", [seriesId])).rows;
    if (!apps.length) throw errors.unprocessable('No allotted applications in this series');
    const appIds = apps.map((a) => Number(a.id));
    // Block if any real payout has happened.
    const paid = await tx.query("SELECT 1 FROM disbursement_schedule WHERE application_id = ANY($1) AND status = 'Paid' LIMIT 1", [appIds]);
    if (paid.rowCount) throw errors.conflict('Cannot revert — interest has already been paid');
    const paidInc = await tx.query('SELECT 1 FROM incentive_accruals WHERE application_id = ANY($1) AND paid_at IS NOT NULL LIMIT 1', [appIds]);
    if (paidInc.rowCount) throw errors.conflict('Cannot revert — incentives have already been paid');

    for (const appId of appIds) {
      await tx.query('DELETE FROM disbursement_schedule WHERE application_id = $1', [appId]);
      await tx.query('DELETE FROM incentive_accruals WHERE application_id = $1', [appId]);
      await tx.query("UPDATE application_lines SET status = 'Active', maturity_date = NULL WHERE application_id = $1", [appId]);
      await tx.query("UPDATE applications SET status = 'PendingAllotment', allotment_date = NULL, maturity_date = NULL, batch_allotment_id = NULL, updated_at = now() WHERE id = $1", [appId]);
    }
    await tx.query("UPDATE series SET status = 'Closing', allotted_at = NULL WHERE id = $1", [seriesId]);
    await writeAudit(tx, { actorId: actor.id, action: 'allotment.revert', entityType: 'series', entityId: seriesId, after: { reason, apps: appIds.length } });
    return { reverted: appIds.length };
  });
}

registerOnFinalApprove('allotment_batch', async (tx, req) => {
  const seriesId = Number(req.metadata.series_id);
  const allotmentDate = String(req.metadata.allotment_date);
  const isin = (req.metadata.isin as string | null) ?? null;
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;

  const apps = (await tx.query<{ id: string; status: string }>("SELECT id, status FROM applications WHERE series_id = $1 AND status = 'PendingAllotment'", [seriesId])).rows;
  for (const app of apps) {
    const appId = Number(app.id);
    assertTransition('application', app.status, 'Active');
    await tx.query("UPDATE applications SET status = 'Active', allotment_date = $1, batch_allotment_id = $2, updated_at = now() WHERE id = $3", [allotmentDate, batchId, appId]);
    await materializeForApplication(tx, appId);
    await accrueForApplication(tx, appId);
  }

  if (batchId) await tx.query("UPDATE allotment_batches SET status = 'Approved' WHERE id = $1", [batchId]);

  // Lock the series (Open/Closing → Allotted). Tolerate already-Allotted.
  const series = (await tx.query<{ status: string }>('SELECT status FROM series WHERE id = $1', [seriesId])).rows[0];
  if (series && canTransition('series', series.status, 'Allotted')) {
    await tx.query("UPDATE series SET status = 'Allotted', allotted_at = now()" + (isin ? ', isin = $2' : '') + ' WHERE id = $1', isin ? [seriesId, isin] : [seriesId]);
  } else if (isin) {
    await tx.query('UPDATE series SET isin = $2 WHERE id = $1', [seriesId, isin]);
  }
});

