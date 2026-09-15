/**
 * One leg, one instrument.
 *
 * A locker's rent and deposit legs can each be settled by a cheque or by an
 * offline (cash/transfer) payment. Both paths guarded only their OWN table, and
 * only the OPEN state — `status='Pending'` for cheques, `'PendingApproval'` for
 * offline payments. So:
 *
 *   - once a cheque cleared, a second cheque on the same leg passed the guard;
 *   - once an offline payment was approved, a second one passed too;
 *   - and neither path ever looked at the other, so a cleared cheque did not
 *     stop a cash payment being recorded for the same rent.
 *
 * Every one of those ends the same way: two real receipts against one leg.
 * LockerHub answers the second settle with `{already:true}`, so nothing upstream
 * complains and the leg is only paid once there — the second collection is real
 * money with no refund record, and the enrolment screen shows only the first
 * (it renders `.find(...)` per leg).
 *
 * The question this asks is "has this leg already been claimed?", not "is one in
 * flight?" — which is the distinction both original guards missed.
 *
 * What does NOT block, deliberately:
 *   - a Bounced or Cancelled cheque, and a Rejected payment: the leg is genuinely
 *     free again and a fresh instrument must be recordable;
 *   - a fee waiver. Every NCD-created locker gets an automatic 100% DEPOSIT
 *     waiver at create, so treating a waived leg as claimed would block deposit
 *     instruments on every locker we make. Waiver-vs-payment overlap is a
 *     separate question (see the 2026-09 audit, M2).
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';

export type Leg = 'rent' | 'deposit';

/** A live or already-settled claim on this leg, or null when it is free. */
export async function legClaim(db: Db, lockerApplicationId: string, leg: Leg): Promise<string | null> {
  const chq = (await db.query<{ status: string; cheque_no: string }>(
    `SELECT status, cheque_no FROM locker_cheques
      WHERE lockerhub_application_id = $1 AND leg = $2 AND status IN ('Pending','Cleared')
      ORDER BY id DESC LIMIT 1`, [lockerApplicationId, leg])).rows[0];
  if (chq) {
    return chq.status === 'Cleared'
      ? `cheque ${chq.cheque_no} has already cleared for the ${leg} leg`
      : `cheque ${chq.cheque_no} is already pending clearance for the ${leg} leg`;
  }

  const off = (await db.query<{ status: string; method: string }>(
    `SELECT status, method FROM locker_offline_payments
      WHERE lockerhub_application_id = $1 AND leg = $2 AND status IN ('PendingApproval','Approved')
      ORDER BY id DESC LIMIT 1`, [lockerApplicationId, leg])).rows[0];
  if (off) {
    return off.status === 'Approved'
      ? `a ${off.method} payment has already been approved for the ${leg} leg`
      : `a ${off.method} payment for the ${leg} leg is already awaiting approval`;
  }
  return null;
}

/** Refuse a second instrument on a leg that is already claimed. */
export async function assertLegUnclaimed(db: Db, lockerApplicationId: string, leg: Leg): Promise<void> {
  const held = await legClaim(db, lockerApplicationId, leg);
  if (held) {
    throw errors.conflict(
      `Not recorded — ${held} on ${lockerApplicationId}. Recording another would collect the same money twice. `
      + 'If that instrument failed, mark it bounced or rejected first; the leg is then free again.');
  }
}
