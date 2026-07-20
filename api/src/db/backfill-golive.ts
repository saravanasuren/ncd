/**
 * Backfill for the investment-approval go-live change (owner spec 2026-07-19),
 * kept as a plain function so it can be tested against PGlite — this touches
 * live money, so "it looked right in the script" isn't good enough.
 *
 * Idempotent: safe to re-run; already-live apps and apps that already have an
 * open approval are skipped.
 *
 *  1. PendingActivation → money was confirmed under the old flow → go live now
 *     (materialising the schedule + accruing incentives needs the TS engine, so
 *     a SQL migration can't do this).
 *  2. In-flight (PendingFundVerification / PendingEsign) → move into the one
 *     approval gate. This ALSO heals apps already sitting in PendingApproval
 *     with no open request: legacy-imported subscriptions arrive that way (the
 *     importer bulk-loads their old status and never creates approval
 *     requests), which strands them — waiting on an approval nobody can give,
 *     so they can never go live and never show in the Approvals queue.
 *  3. Retire leftover batch-activation approvals — that flow is gone.
 */
import type { Db } from './types.js';
import { activateApplication } from '../modules/applications/activate.js';
import { createApprovalRequest } from '../modules/approvals/service.js';

export interface BackfillReport {
  live: number; liveTotal: number; liveFailed: number;
  gated: number; gatedTotal: number; gatedFailed: number;
  retired: number;
}

/** Apps that should be in the approval gate but have no open request. */
const NEEDS_GATE = `
  SELECT a.id, a.application_no FROM applications a
   WHERE a.status IN ('PendingFundVerification','PendingEsign','PendingApproval')
     AND NOT EXISTS (
       SELECT 1 FROM approval_requests ar
        WHERE ar.request_type = 'subscription' AND ar.entity_type = 'applications'
          AND ar.entity_id = a.id::text AND ar.status = 'Pending')
   ORDER BY a.id`;

export async function backfillGoLive(
  db: Db,
  log: (m: string) => void = () => {},
): Promise<BackfillReport> {
  // 1. Funded, awaiting the (now-removed) activation → take live.
  const pendingActivation = (await db.query<{ id: string; application_no: string }>(
    "SELECT id, application_no FROM applications WHERE status = 'PendingActivation' ORDER BY id")).rows;
  let live = 0, liveFailed = 0;
  for (const app of pendingActivation) {
    try {
      await db.withTx((tx) => activateApplication(tx, Number(app.id)));
      live++;
    } catch (e) {
      liveFailed++;
      log(`  ! ${app.application_no} (#${app.id}) failed to go live: ${(e as Error).message}`);
    }
  }
  log(`PendingActivation → Active: ${live}/${pendingActivation.length}${liveFailed ? ` (${liveFailed} failed)` : ''}`);

  // 2. Into the approval gate (and heal stranded PendingApproval apps).
  const inFlight = (await db.query<{ id: string; application_no: string }>(NEEDS_GATE)).rows;
  let gated = 0, gatedFailed = 0;
  for (const app of inFlight) {
    try {
      await db.withTx(async (tx) => {
        await createApprovalRequest(tx, {
          type: 'subscription', entityType: 'applications', entityId: Number(app.id),
          makerUserId: null, metadata: { application_no: app.application_no, source: 'backfill' },
        });
        await tx.query("UPDATE applications SET status = 'PendingApproval', updated_at = now() WHERE id = $1", [app.id]);
      });
      gated++;
    } catch (e) {
      gatedFailed++;
      log(`  ! ${app.application_no} (#${app.id}) failed to gate: ${(e as Error).message}`);
    }
  }
  log(`In-flight → PendingApproval (+ approval): ${gated}/${inFlight.length}${gatedFailed ? ` (${gatedFailed} failed)` : ''}`);

  // 3. Retire leftover batch-activation approvals.
  const retired = await db.query(
    "UPDATE approval_requests SET status = 'Rejected' WHERE request_type = 'activation_batch' AND status = 'Pending'");
  await db.query("UPDATE activation_batches SET status = 'Cancelled' WHERE status = 'PendingChecker'");
  log(`Retired stale activation approvals: ${retired.rowCount ?? 0}`);

  return {
    live, liveTotal: pendingActivation.length, liveFailed,
    gated, gatedTotal: inFlight.length, gatedFailed,
    retired: retired.rowCount ?? 0,
  };
}
