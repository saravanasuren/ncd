/**
 * Accrue staff + referrer incentives for an application at allotment
 * (docs/02 §6 matrix). Idempotent per (application, payee). Paid rows are
 * never touched.
 */
import type { Db } from '../../db/types.js';
import { computeIncentives } from '../../lib/incentive.js';
import { getMatrix } from './matrix.js';

export async function accrueForApplication(tx: Db, applicationId: number): Promise<void> {
  const app = (await tx.query<Record<string, unknown>>(
    'SELECT total_amount, customer_was_new_at_creation, referred_by_text, enrolled_by_user_id, enrolled_by_agent_id FROM applications WHERE id = $1',
    [applicationId]
  )).rows[0];
  if (!app) return;

  const amount = Number(app.total_amount);
  const isNew = app.customer_was_new_at_creation === true;
  const referrerName = (app.referred_by_text as string | null)?.trim() ?? '';
  const hasReferrer = referrerName.length > 0;

  const matrix = await getMatrix(tx);
  const result = computeIncentives(matrix, isNew, hasReferrer, amount);
  const today = new Date().toISOString().slice(0, 10);

  // Staff (or agent) side.
  if (result.staffAmount > 0) {
    const payeeType = app.enrolled_by_agent_id ? 'agent' : 'staff';
    const payeeId = app.enrolled_by_agent_id ? Number(app.enrolled_by_agent_id) : app.enrolled_by_user_id ? Number(app.enrolled_by_user_id) : null;
    if (payeeId) {
      const ins = await tx.query(
        `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (application_id, payee_type, payee_id) DO NOTHING`,
        [applicationId, payeeType, payeeId, isNew ? 'staff_new' : 'staff_existing', result.staffSpec.mode, result.staffSpec.value, result.staffAmount, today]
      );
      // Only on a real insert — re-running accrual must not re-fire the event.
      if (ins.rowCount && payeeType === 'agent') {
        await emitAccrued(tx, payeeId, applicationId, result.staffAmount, today, isNew ? 'staff_new' : 'staff_existing');
      }
    }
  }

  // Referrer side. The referred-by value (code or name) resolves to a real
  // payee — an agent or a staff user — so the person mapped to the code earns
  // the incentive (owner spec 2026-07-18). A name that matches nobody becomes a
  // single (deduped) agent: there is only one kind of external earner, so an
  // unresolved referrer is just a not-yet-approved agent, never a separate row.
  if (result.referrerAmount > 0 && hasReferrer) {
    const { resolveReferrer, ensureReferralAgent } = await import('../agents/service.js');
    const payee = await resolveReferrer(tx, referrerName)
      ?? { kind: 'agent' as const, id: await ensureReferralAgent(tx, referrerName) };
    const ins = await tx.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1,$2,$3,'referrer',$4,$5,$6,$7) ON CONFLICT (application_id, payee_type, payee_id) DO NOTHING`,
      [applicationId, payee.kind, payee.id, result.referrerSpec.mode, result.referrerSpec.value, result.referrerAmount, today]
    );
    if (ins.rowCount && payee.kind === 'agent') {
      await emitAccrued(tx, payee.id, applicationId, result.referrerAmount, today, 'referrer');
    }
  }
}

/**
 * Agent-event webhook (contract §Events channel 1, `incentive_accrued`). Inert
 * unless LOCKERHUB_WEBHOOK_URL + _SECRET are set, and skipped for agents that
 * did not come from LockerHub — both guards live in enqueueEvent.
 *
 * NB: LockerHub's payload lists `application_line_id`; our accruals are per
 * APPLICATION (unique on application+payee), not per line, so it is sent null.
 */
async function emitAccrued(tx: Db, agentId: number, applicationId: number, amount: number, accrualDate: string, matrixCell: string) {
  const { enqueueEvent } = await import('../../integrations/lockerhub/dispatcher.js');
  await enqueueEvent(tx, {
    eventType: 'incentive_accrued',
    targetAgentId: agentId,
    dedupKey: `incentive_accrued:${applicationId}:agent:${agentId}`,
    payload: { application_id: applicationId, application_line_id: null, accrual_date: accrualDate, amount, matrix_cell: matrixCell },
  });
}
