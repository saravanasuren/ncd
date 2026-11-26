/**
 * An UNPAID commission row sitting on somebody the referrer does not name.
 *
 * WHERE THESE COME FROM. The go-live import computed the right amount and
 * credited the wrong person: whoever created the customer record, rather than
 * the referrer named on the investment. Those rows carry `matrix_cell NULL`,
 * so every repair that scopes itself to `matrix_cell = 'referrer'` is blind to
 * them. A full-book scan on 2026-11-26 found exactly two, Rs 48,000, both on
 * the same staff member, both unpaid — and nothing paid to a wrong person.
 *
 * WHY NOT JUST RE-ACCRUE. The existing repair deletes every accrual on the
 * investment and re-runs the engine. That cannot be used here for two reasons:
 *   - it would delete a CORRECT paid row sitting beside the stale one (it
 *     refuses outright when anything is paid, so it cannot touch these at all)
 *   - these legacy investments were imported with a referrer row and NOTHING
 *     for the enroller. Re-running the engine writes an enroller commission
 *     that has never existed on them — money nobody asked for.
 * So this moves or removes the one offending row and leaves the arithmetic
 * exactly as the import computed it.
 *
 * ONE RULE, which is what makes it safe:
 *   for each UNPAID row in the referrer slot whose payee is not who the
 *   effective referrer resolves to —
 *     the right earner already holds a row here  ->  DELETE it (a duplicate)
 *     the right earner holds nothing             ->  MOVE it (wrong name)
 * The amount is never recomputed and a PAID row is never touched.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export interface StaleRowAction {
  application_no: string;
  referrer_text: string;
  should_be: { kind: 'staff' | 'agent'; id: number; name: string };
  action: 'deleted' | 'moved';
  from: { kind: string; id: number; name: string | null };
  amount: number;
  /** The paid row that proves the earner already had it — only on a delete. */
  alongside_paid: boolean;
}

interface Row {
  id: string; payee_type: string; payee_id: string; payee_name: string | null;
  matrix_cell: string | null; amount: string;
}

export async function fixStaleReferrerRows(
  tx: Db, applicationNo: string, opts: { reason: string; actorId?: number | null },
): Promise<StaleRowAction[]> {
  const reason = String(opts.reason ?? '').trim();
  if (!reason) throw errors.badRequest('A reason is required; it goes into the audit row.');

  const app = (await tx.query<{ id: string; application_no: string; ref: string | null }>(
    `SELECT ap.id, ap.application_no,
            NULLIF(btrim(COALESCE(NULLIF(btrim(ap.referred_by_text), ''), c.referred_by_text)), '') AS ref
       FROM applications ap JOIN customers c ON c.id = ap.customer_id
      WHERE upper(ap.application_no) = upper($1)`, [applicationNo])).rows[0];
  if (!app) throw errors.notFound(`No investment ${applicationNo}`);
  if (!app.ref) {
    throw errors.unprocessable(`${app.application_no} names no referrer, so there is nobody a row could belong to.`);
  }

  const { resolveReferrer } = await import('../agents/service.js');
  const target = await resolveReferrer(tx, app.ref);
  if (!target) {
    throw errors.unprocessable(
      `${app.application_no}: "${app.ref}" matches no agent or staff member, so the right earner cannot be established.`);
  }

  const id = Number(app.id);
  const slot = (await tx.query<Row>(
    `SELECT ia.id, ia.payee_type, ia.payee_id, ia.matrix_cell, ia.amount,
            COALESCE(ag.full_name, u.full_name) AS payee_name
       FROM incentive_accruals ia
       LEFT JOIN agents ag ON ia.payee_type = 'agent' AND ag.id = ia.payee_id
       LEFT JOIN users  u  ON ia.payee_type = 'staff' AND u.id  = ia.payee_id
      WHERE ia.application_id = $1 AND ia.paid_at IS NULL
        AND (ia.matrix_cell = 'referrer' OR ia.matrix_cell IS NULL)
      ORDER BY ia.id`, [id])).rows;

  const done: StaleRowAction[] = [];
  for (const row of slot) {
    if (row.payee_type === target.kind && Number(row.payee_id) === target.id) continue; // already right

    // Does the rightful earner already hold a row on this investment?
    const held = (await tx.query<{ n: string; paid: boolean }>(
      `SELECT count(*) AS n, bool_or(paid_at IS NOT NULL) AS paid FROM incentive_accruals
        WHERE application_id = $1 AND payee_type = $2 AND payee_id = $3`,
      [id, target.kind, target.id])).rows[0]!;
    const duplicate = Number(held.n) > 0;

    if (duplicate) {
      await tx.query('DELETE FROM incentive_accruals WHERE id = $1', [Number(row.id)]);
    } else {
      // The amount the import computed stands; only the name was wrong.
      await tx.query(
        'UPDATE incentive_accruals SET payee_type = $2, payee_id = $3 WHERE id = $1',
        [Number(row.id), target.kind, target.id]);
    }

    const act: StaleRowAction = {
      application_no: app.application_no,
      referrer_text: app.ref,
      should_be: target,
      action: duplicate ? 'deleted' : 'moved',
      from: { kind: row.payee_type, id: Number(row.payee_id), name: row.payee_name },
      amount: Number(row.amount),
      alongside_paid: duplicate && held.paid === true,
    };
    done.push(act);
    await writeAudit(tx, {
      actorId: opts.actorId ?? null,
      action: duplicate ? 'incentive.stale-row-deleted' : 'incentive.stale-row-moved',
      entityType: 'applications',
      entityId: id,
      before: { payee_type: act.from.kind, payee_id: act.from.id, payee_name: act.from.name,
                amount: act.amount, matrix_cell: row.matrix_cell },
      after: { payee_type: target.kind, payee_id: target.id, payee_name: target.name,
               referrer_text: app.ref, reason },
    });
  }
  return done;
}
