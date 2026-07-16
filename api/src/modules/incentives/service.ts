/** Incentives payout ledger (docs/02 §5). Balance = Σaccrued − Σpaid;
 * partial payments supported. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';

export async function payeeBalance(db: Db, payeeType: string, payeeId: number) {
  const accrued = Number((await db.query<{ s: string }>('SELECT COALESCE(sum(amount),0) AS s FROM incentive_accruals WHERE payee_type = $1 AND payee_id = $2', [payeeType, payeeId])).rows[0]!.s);
  const paid = Number((await db.query<{ s: string }>('SELECT COALESCE(sum(amount),0) AS s FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2', [payeeType, payeeId])).rows[0]!.s);
  return { accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid) };
}

export async function pay(db: Db, actor: AuthUser, payeeType: string, payeeId: number, amount: number, reference?: string) {
  if (amount <= 0) throw errors.badRequest('Amount must be positive');
  return db.withTx(async (tx) => {
    await tx.query('INSERT INTO incentive_payouts (payee_type, payee_id, amount, reference, created_by_user_id) VALUES ($1,$2,$3,$4,$5)',
      [payeeType, payeeId, amount, reference ?? null, actor.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'incentive.pay', entityType: 'incentive_payouts', entityId: `${payeeType}:${payeeId}`, after: { amount, reference } });
    return payeeBalance(tx, payeeType, payeeId);
  });
}

export async function myEarnings(db: Db, actor: AuthUser) {
  const payeeType = actor.agentId ? 'agent' : 'staff';
  const payeeId = actor.agentId ?? actor.id;
  const bal = await payeeBalance(db, payeeType, payeeId);
  const accruals = (await db.query(
    `SELECT ia.amount, ia.rate_mode, ia.rate_value, ia.accrual_date, ia.paid_at, a.application_no
     FROM incentive_accruals ia JOIN applications a ON a.id = ia.application_id
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 ORDER BY ia.accrual_date DESC`, [payeeType, payeeId])).rows;
  const payouts = (await db.query('SELECT amount, reference, paid_at FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2 ORDER BY paid_at DESC', [payeeType, payeeId])).rows;
  return { ...bal, accruals, payouts };
}

/** Overview for managers: every staff/agent/referrer with a nonzero balance. */
export async function overview(db: Db) {
  const { rows } = await db.query(
    `SELECT ia.payee_type, ia.payee_id, COALESCE(sum(ia.amount),0) AS accrued,
            COALESCE((SELECT sum(p.amount) FROM incentive_payouts p WHERE p.payee_type = ia.payee_type AND p.payee_id = ia.payee_id),0) AS paid
     FROM incentive_accruals ia GROUP BY ia.payee_type, ia.payee_id`
  );
  return rows.map((r) => {
    const accrued = Number((r as any).accrued); const paid = Number((r as any).paid);
    return { payee_type: (r as any).payee_type, payee_id: Number((r as any).payee_id), accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid) };
  });
}
