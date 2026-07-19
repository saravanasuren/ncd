/**
 * One-time backfill for the investment-approval go-live change (owner spec
 * 2026-07-19). The old flow parked funded apps in PendingActivation awaiting a
 * batch activation; that step is gone, so those apps must be taken live here
 * (materialising the schedule + accruing incentives needs the TS engine, which
 * a SQL migration cannot do). Run once after `migrate`, e.g. on deploy:
 *
 *     npm run backfill:golive -w @new-wealth/api      (built)
 *     npm run backfill:golive:dev -w @new-wealth/api  (tsx)
 *
 * Idempotent: already-live apps are skipped, and a second run is a no-op.
 *
 *  - PendingActivation  → money was confirmed under the old flow → go live now.
 *  - PendingFundVerification / PendingEsign → in-flight, money not yet
 *    confirmed → move into the one approval gate (PendingApproval + an
 *    investment approval) so an admin can approve → go live.
 */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
const { createDb } = await import('./index.js');
const { activateApplication } = await import('../modules/applications/activate.js');
const { createApprovalRequest } = await import('../modules/approvals/service.js');

const db = createDb();

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
    console.error(`  ! ${app.application_no} (#${app.id}) failed to go live: ${(e as Error).message}`);
  }
}
console.log(`PendingActivation → Active: ${live}/${pendingActivation.length}${liveFailed ? ` (${liveFailed} failed)` : ''}`);

// 2. In-flight, money not confirmed → route into the one approval gate.
const inFlight = (await db.query<{ id: string; application_no: string }>(
  "SELECT id, application_no FROM applications WHERE status IN ('PendingFundVerification','PendingEsign') ORDER BY id")).rows;
let gated = 0, gatedFailed = 0;
for (const app of inFlight) {
  try {
    await db.withTx(async (tx) => {
      // Only raise an approval if one isn't already open for this app.
      const existing = await tx.query(
        "SELECT 1 FROM approval_requests WHERE request_type = 'subscription' AND entity_type = 'applications' AND entity_id = $1 AND status = 'Pending'",
        [app.id]);
      if (!existing.rowCount) {
        await createApprovalRequest(tx, { type: 'subscription', entityType: 'applications', entityId: Number(app.id), makerUserId: null, metadata: { application_no: app.application_no, source: 'backfill' } });
      }
      await tx.query("UPDATE applications SET status = 'PendingApproval', updated_at = now() WHERE id = $1", [app.id]);
    });
    gated++;
  } catch (e) {
    gatedFailed++;
    console.error(`  ! ${app.application_no} (#${app.id}) failed to gate: ${(e as Error).message}`);
  }
}
console.log(`In-flight → PendingApproval (+ approval): ${gated}/${inFlight.length}${gatedFailed ? ` (${gatedFailed} failed)` : ''}`);

await db.close();
console.log('backfill:golive done.');
