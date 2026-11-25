/**
 * Make an investment's referrer agree with its customer's — and move the
 * commission with it.
 *
 * THE DRIFT THIS REPAIRS. Correcting a customer's referrer updates the
 * CUSTOMER and stops there. The incentive engine reads
 *   COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)
 * — the INVESTMENT first — so the old referrer keeps earning while every
 * screen shows the new one. Found in production 2026-11-25: 17 investments
 * across 13 customers, Rs 1,37,750 of commission paid to the wrong side of a
 * correction somebody had already made.
 *
 * TWO MODES, one operation:
 *   align  — the investments adopt whatever the customer record says. This is
 *            the repair for a correction that only went half way.
 *   set    — a new referrer is written to the customer AND its investments,
 *            for a change being made now.
 *
 * THE STALE ACCRUAL IS DELETED BEFORE THE ENGINE RE-RUNS. The upsert keys on
 * (application_id, payee_type, payee_id), so re-running for a new payee
 * INSERTS beside the old row rather than replacing it — the same commission
 * credited to two people. The old row has to go first for this to be a move
 * and not a duplication.
 *
 * DELETING THE `referrer` ROW IS NOT ENOUGH. An IMPORTED accrual carries
 * matrix_cell NULL — 718 of 889 on production — so a delete scoped to
 * matrix_cell = 'referrer' walks straight past it. A production dry run on
 * 2026-11-25 showed what that costs: 7 investments across 4 customers would
 * have kept the old earner's imported row AND gained a row for the new one,
 * Rs 45,250 credited twice, including the very case this was built to repair.
 * So the previously-named referrer is resolved to a payee and THAT payee's
 * unpaid row is removed, whatever its matrix_cell. The unique key is
 * (application_id, payee_type, payee_id), so one payee holds at most one row
 * per investment — deleting by payee cannot catch a bystander, and anything
 * the engine still owns it rebuilds on the spot.
 *
 * PAID MONEY IS NEVER TOUCHED, AND THE CHECK IS PER INVESTMENT. Only the
 * investments whose earner actually changes are examined: a sibling
 * investment that was already correct and already paid is no reason to refuse
 * the repair (DHN0330 was blocked by exactly that). Where an investment that
 * does change has been paid, that customer aborts — moving commission
 * somebody has already received is a decision for a person. Where the
 * duplicate is really one human recorded twice, the agent-merge path handles
 * paid history deliberately — use that instead.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { accrueForApplication } from './accrual.js';

export interface AccrualRow {
  payee_type: string; payee_id: string; matrix_cell: string | null; amount: string; paid_at: string | null;
}
export interface Payee { kind: 'staff' | 'agent'; id: number; name: string }
export interface AlignReport {
  customer_code: string;
  customer_name: string;
  referrer: string;
  changed_customer: boolean;
  resolved_to: Payee | null;
  applications: { application_no: string; status: string; was: string; now: string;
                  moves: boolean; moved_from: Payee | null;
                  before: AccrualRow[]; after: AccrualRow[] }[];
}

const accrualsOf = (tx: Db, appId: number) => tx.query<AccrualRow>(
  `SELECT payee_type, payee_id, matrix_cell, amount, paid_at
     FROM incentive_accruals WHERE application_id = $1 ORDER BY id`, [appId]).then((r) => r.rows);

export async function alignReferrer(
  tx: Db, customerCode: string, setTo?: string | null,
): Promise<AlignReport> {
  const code = String(customerCode ?? '').trim().toUpperCase();
  if (!code) throw errors.badRequest('A customer code is required.');

  const cust = (await tx.query<{ id: string; full_name: string; referred_by_text: string | null }>(
    'SELECT id, full_name, referred_by_text FROM customers WHERE upper(customer_code) = $1', [code])).rows[0];
  if (!cust) throw errors.notFound(`No customer ${code}`);

  const target = (setTo ?? cust.referred_by_text ?? '').trim();
  if (!target) {
    throw errors.badRequest(`${code} has no referrer on the customer record and none was given.`);
  }

  const { resolveReferrer } = await import('../agents/service.js');
  const resolved = await resolveReferrer(tx, target);

  const apps = (await tx.query<{ id: string; application_no: string; status: string; referred_by_text: string | null }>(
    'SELECT id, application_no, status, referred_by_text FROM applications WHERE customer_id = $1 ORDER BY id',
    [Number(cust.id)])).rows;

  // Who each investment's commission reads TODAY: its own text when it has one,
  // otherwise the customer's — the same COALESCE the accrual engine applies.
  const samePayee = (a: Payee | null, b: Payee | null) =>
    !!a && !!b && a.kind === b.kind && Number(a.id) === Number(b.id);
  const custWas = (cust.referred_by_text ?? '').trim();

  const plan: { app: typeof apps[number]; was: string; from: Payee | null; moves: boolean }[] = [];
  for (const app of apps) {
    const was = (app.referred_by_text ?? '').trim();
    const effective = was || custWas;
    const from = effective ? await resolveReferrer(tx, effective) : null;
    plan.push({ app, was, from, moves: !samePayee(from, resolved) });
  }

  // Only the investments that actually change earner can be blocked by paid money.
  const moving = plan.filter((p) => p.moves).map((p) => Number(p.app.id));
  if (moving.length) {
    const paid = (await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM incentive_accruals
        WHERE application_id = ANY($1::bigint[]) AND paid_at IS NOT NULL`, [moving])).rows[0]!;
    if (Number(paid.n) > 0) {
      throw errors.unprocessable(
        `${code} has ${paid.n} commission row(s) already PAID on the investment(s) whose earner would change. Use the agent-merge path, which moves paid history on purpose, or settle it by hand.`);
    }
  }

  let changedCustomer = false;
  if (setTo && (cust.referred_by_text ?? '').trim() !== target) {
    await tx.query('UPDATE customers SET referred_by_text = $1, updated_at = now() WHERE id = $2',
      [target, Number(cust.id)]);
    changedCustomer = true;
  }

  const report: AlignReport['applications'] = [];
  for (const { app, was, from, moves } of plan) {
    const id = Number(app.id);
    const before = await accrualsOf(tx, id);
    if (was.toLowerCase() !== target.toLowerCase()) {
      await tx.query('UPDATE applications SET referred_by_text = $1 WHERE id = $2', [target, id]);
    }
    // Anything the engine wrote for the referrer slot, whoever holds it.
    await tx.query(
      `DELETE FROM incentive_accruals
        WHERE application_id = $1 AND matrix_cell = 'referrer' AND paid_at IS NULL`, [id]);
    // And the earner we are moving away from, including an imported row the
    // clause above cannot see because its matrix_cell is NULL.
    if (moves && from) {
      await tx.query(
        `DELETE FROM incentive_accruals
          WHERE application_id = $1 AND payee_type = $2 AND payee_id = $3 AND paid_at IS NULL`,
        [id, from.kind, from.id]);
    }
    await accrueForApplication(tx, id);
    report.push({ application_no: app.application_no, status: app.status, was, now: target,
                  moves, moved_from: moves ? from : null,
                  before, after: await accrualsOf(tx, id) });
  }

  return {
    customer_code: code, customer_name: cust.full_name, referrer: target,
    changed_customer: changedCustomer, resolved_to: resolved, applications: report,
  };
}
