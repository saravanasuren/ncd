/**
 * Batch activation (docs/02 §4). Maker submits a series' funded apps → checker
 * approves → every PendingActivation app in the series goes Active, its
 * schedule is materialised and incentives accrue. All inside the approval
 * transaction (atomic).
 *
 * This is the point money-in-the-account becomes a live NCD. Allotment is a
 * separate, later series step (see ../allotments) that only stamps
 * allotment_date and locks the series — it no longer populates any book data.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { materializeForApplication } from '../schedule/materialize.js';
import { accrueForApplication } from '../incentives/accrual.js';

export async function pendingBySeriesSummary(db: Db) {
  const { rows } = await db.query(
    `SELECT s.id AS series_id, s.code, s.name, s.status,
            count(a.id) FILTER (WHERE a.status = 'PendingActivation')::int AS pending_count,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status = 'PendingActivation'),0) AS pending_amount
     FROM series s LEFT JOIN applications a ON a.series_id = s.id
     GROUP BY s.id, s.code, s.name, s.status ORDER BY s.code`
  );
  return rows;
}

export async function createActivationBatch(db: Db, actor: AuthUser, input: { series_id: number; notes?: string }) {
  return db.withTx(async (tx) => {
    const n = Number((await tx.query<{ n: string }>("SELECT count(*)::int AS n FROM applications WHERE series_id = $1 AND status = 'PendingActivation'", [input.series_id])).rows[0]!.n);
    if (n === 0) throw errors.unprocessable('No funded applications are pending activation in this series');
    const seriesCode = (await tx.query<{ code: string }>('SELECT code FROM series WHERE id = $1', [input.series_id])).rows[0]?.code ?? null;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO activation_batches (series_id, notes, status, created_by_user_id)
       VALUES ($1,$2,'PendingChecker',$3) RETURNING id`,
      [input.series_id, input.notes ?? null, actor.id]
    );
    const batchId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, {
      type: 'activation_batch',
      entityType: 'activation_batches',
      entityId: batchId,
      makerUserId: actor.id,
      metadata: { series_id: input.series_id, series_code: seriesCode, batch_id: batchId, count: n },
    });
    await tx.query('UPDATE activation_batches SET approval_request_id = $1 WHERE id = $2', [req.id, batchId]);
    await writeAudit(tx, { actorId: actor.id, action: 'activation.submit', entityType: 'activation_batches', entityId: batchId, after: { series_id: input.series_id, count: n } });
    return { batch_id: batchId, request: req, count: n };
  });
}

registerOnFinalApprove('activation_batch', async (tx, req) => {
  const seriesId = Number(req.metadata.series_id);
  const batchId = req.metadata.batch_id ? Number(req.metadata.batch_id) : null;

  const apps = (await tx.query<{ id: string; status: string }>("SELECT id, status FROM applications WHERE series_id = $1 AND status = 'PendingActivation'", [seriesId])).rows;
  for (const app of apps) {
    const appId = Number(app.id);
    assertTransition('application', app.status, 'Active');
    await tx.query("UPDATE applications SET status = 'Active', updated_at = now() WHERE id = $1", [appId]);
    await materializeForApplication(tx, appId);
    await accrueForApplication(tx, appId);
  }

  if (batchId) await tx.query("UPDATE activation_batches SET status = 'Approved' WHERE id = $1", [batchId]);
});
