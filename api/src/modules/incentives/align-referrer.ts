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
 * credited to two people. Removing the old `referrer` row first is the only
 * thing that makes this a move.
 *
 * PAID MONEY IS NEVER TOUCHED. Any accrual with paid_at set aborts that
 * customer: moving commission somebody has already received is a decision for
 * a person. Where the duplicate is really one human recorded twice, the
 * agent-merge path handles paid history deliberately — use that instead.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { accrueForApplication } from './accrual.js';

export interface AccrualRow {
  payee_type: string; payee_id: string; matrix_cell: string | null; amount: string; paid_at: string | null;
}
export interface AlignReport {
  customer_code: string;
  customer_name: string;
  referrer: string;
  changed_customer: boolean;
  resolved_to: { kind: 'staff' | 'agent'; id: number; name: string } | null;
  applications: { application_no: string; status: string; was: string; now: string;
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

  const paid = (await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM incentive_accruals
      WHERE application_id = ANY($1::bigint[]) AND paid_at IS NOT NULL`,
    [apps.map((a) => Number(a.id))])).rows[0]!;
  if (Number(paid.n) > 0) {
    throw errors.unprocessable(
      `${code} has ${paid.n} commission row(s) already PAID. Use the agent-merge path, which moves paid history on purpose, or settle it by hand.`);
  }

  let changedCustomer = false;
  if (setTo && (cust.referred_by_text ?? '').trim() !== target) {
    await tx.query('UPDATE customers SET referred_by_text = $1, updated_at = now() WHERE id = $2',
      [target, Number(cust.id)]);
    changedCustomer = true;
  }

  const report: AlignReport['applications'] = [];
  for (const app of apps) {
    const was = (app.referred_by_text ?? '').trim();
    const before = await accrualsOf(tx, Number(app.id));
    if (was.toLowerCase() !== target.toLowerCase()) {
      await tx.query('UPDATE applications SET referred_by_text = $1 WHERE id = $2', [target, Number(app.id)]);
    }
    await tx.query(
      `DELETE FROM incentive_accruals
        WHERE application_id = $1 AND matrix_cell = 'referrer' AND paid_at IS NULL`, [Number(app.id)]);
    await accrueForApplication(tx, Number(app.id));
    report.push({ application_no: app.application_no, status: app.status, was, now: target,
                  before, after: await accrualsOf(tx, Number(app.id)) });
  }

  return {
    customer_code: code, customer_name: cust.full_name, referrer: target,
    changed_customer: changedCustomer, resolved_to: resolved, applications: report,
  };
}
