/**
 * Accrue staff + referrer incentives for an application at allotment
 * (docs/02 §6 matrix). Idempotent per (application, payee).
 *
 * An UNPAID accrual is REFRESHED, not skipped (owner 2026-09-15). It used to be
 * `DO NOTHING`, which meant the first figure stood forever — and an incentive is
 * a PERCENTAGE OF THE INVESTMENT, so the moment money was clubbed into an
 * application that had already accrued, the two stopped agreeing. APP-2026-001105
 * is the worked example: approved at ₹4,00,000 (2% = ₹8,000), then ₹26,00,000
 * clubbed in four hours later, taking it to ₹30,00,000 — and the accrual still
 * said ₹8,000 while its own stored rate said 2%. Three applications on the book
 * were short by ₹64,000 between them, all still unpaid.
 *
 * Every caller already re-runs this after changing the amount; the write was the
 * only thing standing in the way. The referrer-reassignment path in
 * applications/service.ts had to DELETE the unpaid row first to work around it.
 *
 * PAID rows are still never touched — the `WHERE ... paid_at IS NULL` on the
 * conflict clause is what guarantees it, so a settled incentive can never be
 * restated by a later edit.
 *
 * accrual_date is deliberately NOT refreshed: My Earnings groups by it, so
 * stamping today's date on a correction would move an August incentive into
 * September and make both months wrong.
 */
import type { Db } from '../../db/types.js';
import { computeIncentives } from '../../lib/incentive.js';
import { getMatrix } from './matrix.js';
import { referrerIntroducedCustomer } from './referrer.js';

export async function accrueForApplication(tx: Db, applicationId: number): Promise<void> {
  /**
   * The referrer falls back to the CUSTOMER's when the application carries none
   * (owner 2026-09-07: "geetha s was enrolled by rithiesh but referred by nambi
   * ... why is it showing under rithiesh name").
   *
   * This is the rule the rest of the system already uses —
   * applications/service.ts refCol is
   *   COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)
   * and scoping, visibility and every report read it that way. The accrual
   * engine alone read the application's column on its own, so an investment
   * whose referrer sat on the customer but not on the application paid the
   * WRONG PEOPLE: the referrer earned nothing, and the enroller was paid the
   * full no-referrer rate instead of the reduced with-referrer one.
   *
   * Geetha.S is the worked example: referred by agent NAMBI on the customer,
   * blank on the investment, so ₹70,00,000 paid Rithiesh L staff_new at 2%
   * (₹1,40,000) and NAMBI nothing. Two investments on the book were affected.
   *
   * The customer is the right fallback and not a guess: a referrer introduces a
   * PERSON, and every later investment by that person is theirs on the same
   * footing — which is exactly what referrerIntroducedCustomer below already
   * assumes.
   */
  const app = (await tx.query<Record<string, unknown>>(
    `SELECT a.customer_id, a.total_amount, a.customer_was_new_at_creation,
            COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text) AS referred_by_text,
            a.enrolled_by_user_id, a.enrolled_by_agent_id
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1`,
    [applicationId]
  )).rows[0];
  if (!app) return;

  const amount = Number(app.total_amount);
  const isNew = app.customer_was_new_at_creation === true;
  const referrerName = (app.referred_by_text as string | null)?.trim() ?? '';
  const hasReferrer = referrerName.length > 0;

  const matrix = await getMatrix(tx);
  // The two sides ask DIFFERENT questions (owner rule 2026-08-03).
  // Staff: was the customer new when this was keyed in — unchanged.
  // Referrer: did I bring this customer in? A repeat investment from my own
  // customer is still my money, so it pays the full rate; only a referrer
  // arriving on somebody ELSE'S customer earns the repeat rate. See
  // ./referrer.ts for why row order was the wrong question.
  const staffSide = computeIncentives(matrix, isNew, hasReferrer, amount);
  const referrerSide = hasReferrer
    ? computeIncentives(
        matrix,
        await referrerIntroducedCustomer(tx, Number(app.customer_id), referrerName),
        true,
        amount
      )
    : staffSide;
  const result = { ...staffSide, referrerSpec: referrerSide.referrerSpec, referrerAmount: referrerSide.referrerAmount };
  const today = new Date().toISOString().slice(0, 10);

  // Staff (or agent) side.
  if (result.staffAmount > 0) {
    const payeeType = app.enrolled_by_agent_id ? 'agent' : 'staff';
    const payeeId = app.enrolled_by_agent_id ? Number(app.enrolled_by_agent_id) : app.enrolled_by_user_id ? Number(app.enrolled_by_user_id) : null;
    if (payeeId) {
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE
            SET matrix_cell = EXCLUDED.matrix_cell,
                rate_mode   = EXCLUDED.rate_mode,
                rate_value  = EXCLUDED.rate_value,
                amount      = EXCLUDED.amount
          WHERE incentive_accruals.paid_at IS NULL
         RETURNING (xmax = 0) AS inserted`,
        [applicationId, payeeType, payeeId, isNew ? 'staff_new' : 'staff_existing', result.staffSpec.mode, result.staffSpec.value, result.staffAmount, today]
      );
      // Only on a real INSERT — a refresh must not re-fire the event. xmax is 0
      // on a freshly inserted row and non-zero on one the conflict clause
      // updated, which is the only thing that tells the two apart here.
      if (ins.rows[0]?.inserted === true && payeeType === 'agent') {
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
    const ins = await tx.query<{ inserted: boolean }>(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1,$2,$3,'referrer',$4,$5,$6,$7)
       ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE
          SET matrix_cell = EXCLUDED.matrix_cell,
              rate_mode   = EXCLUDED.rate_mode,
              rate_value  = EXCLUDED.rate_value,
              amount      = EXCLUDED.amount
        WHERE incentive_accruals.paid_at IS NULL
       RETURNING (xmax = 0) AS inserted`,
      [applicationId, payee.kind, payee.id, result.referrerSpec.mode, result.referrerSpec.value, result.referrerAmount, today]
    );
    if (ins.rows[0]?.inserted === true && payee.kind === 'agent') {
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
