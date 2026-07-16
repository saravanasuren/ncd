/**
 * Premature redemption (docs/02 §6, docs/17 old-app bug). 2-level chain
 * (NCD Manager → CXO). Net Payment = Principal − Penalty; broken interest is
 * paid separately. On final approval the application is RELIABLY closed
 * (Redeemed + line PrematureWithdrawn + future rows Skipped) — regression
 * tested, because the old app sometimes left it Active.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { nextCode } from '../../lib/sequences.js';
import { computeRedemption } from '../../lib/redemption.js';
import type { RateSpec } from '../../lib/incentive.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';

export async function initiatePremature(db: Db, actor: AuthUser, input: { application_id: number; redemption_date?: string; reason: string }) {
  const settings = await getSettingsMap(db);
  const penalty = (settings['redemption.premature_penalty'] as RateSpec) ?? { mode: 'pct', value: 1.0 };
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [input.application_id])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active') throw errors.unprocessable('Only Active applications can be prematurely redeemed');

    const principal = Number((await tx.query<{ p: string }>("SELECT COALESCE(sum(outstanding_amount),0) AS p FROM application_lines WHERE application_id = $1 AND status = 'Active'", [input.application_id])).rows[0]!.p);
    const calc = computeRedemption({ principal, penalty });
    const redDate = input.redemption_date ?? new Date().toISOString().slice(0, 10);
    const redNo = await nextCode(tx, 'redemption', 'MCR-{yyyy}-{seq:6}');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, penalty, net_payment, broken_interest, requested_date, redemption_date, reason, status, created_by_user_id)
       VALUES ($1,$2,'premature',$3,$4,$5,$6,$7,$8,$9,'Requested',$10) RETURNING id`,
      [redNo, input.application_id, calc.principal, calc.penalty, calc.netPayment, calc.brokenInterest, redDate, redDate, input.reason, actor.id]
    );
    const redId = Number(rows[0]!.id);
    const req = await createApprovalRequest(tx, {
      type: 'premature_redemption', entityType: 'redemptions', entityId: redId, makerUserId: actor.id,
      metadata: { application_id: input.application_id, redemption_id: redId, redemption_date: redDate, net_payment: calc.netPayment, penalty: calc.penalty },
    });
    await tx.query('UPDATE redemptions SET approval_request_id = $1 WHERE id = $2', [req.id, redId]);
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.initiate', entityType: 'redemptions', entityId: redId, after: { redNo, principal, net: calc.netPayment } });
    return { redemption_id: redId, redemption_no: redNo, request: req, ...calc };
  });
}

registerOnFinalApprove('premature_redemption', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const redId = Number(req.metadata.redemption_id);
  const redDate = String(req.metadata.redemption_date ?? new Date().toISOString().slice(0, 10));

  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return;

  // CLOSE THE APPLICATION — the fix. Active → Redeemed.
  assertTransition('application', app.status, 'Redeemed');
  await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = $1, updated_at = now() WHERE id = $2", [redDate, appId]);

  // Close lines.
  await tx.query("UPDATE application_lines SET status = 'PrematureWithdrawn', outstanding_amount = 0 WHERE application_id = $1 AND status = 'Active'", [appId]);

  // Skip all future scheduled rows (they no longer pay out).
  await tx.query("UPDATE disbursement_schedule SET status = 'Skipped' WHERE application_id = $1 AND status = 'Scheduled'", [appId]);

  // Record the premature payout row (net = principal − penalty).
  const red = (await tx.query<{ net_payment: string; principal: string }>('SELECT net_payment, principal FROM redemptions WHERE id = $1', [redId])).rows[0]!;
  const lineId = (await tx.query<{ id: string }>('SELECT id FROM application_lines WHERE application_id = $1 ORDER BY id LIMIT 1', [appId])).rows[0]?.id;
  if (lineId) {
    await tx.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status)
       VALUES ($1,$2,$3,'Premature',$4,0,$4,'Scheduled') ON CONFLICT (line_id, due_date, due_type) DO NOTHING`,
      [Number(lineId), appId, redDate, red.net_payment]
    );
  }

  await tx.query("UPDATE redemptions SET status = 'Approved', redemption_date = $1 WHERE id = $2", [redDate, redId]);
});

export async function listRedemptions(db: Db) {
  return (await db.query(
    `SELECT r.*, a.application_no, c.full_name AS customer_name
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     ORDER BY r.created_at DESC LIMIT 200`
  )).rows;
}
