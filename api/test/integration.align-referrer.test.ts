/**
 * An investment's referrer must agree with its customer's — and the money with it.
 *
 * THE DRIFT (production, 2026-11-25). Correcting a customer's referrer updates
 * the CUSTOMER and stops. The engine reads the INVESTMENT first, so the old
 * referrer keeps earning while every screen shows the new one: 17 investments,
 * 13 customers, Rs 1,37,750 attributed to the wrong side of a correction
 * somebody had already made.
 *
 * The dangerous half is the double-credit — see the row counts below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const align = async (code: string, to?: string) => {
  const { alignReferrer } = await import('../src/modules/incentives/align-referrer.js');
  return ctx.db.withTx((tx) => alignReferrer(tx, code, to ?? null));
};
const refRows = async (code: string) => (await ctx.db.query<Record<string, unknown>>(
  `SELECT i.payee_type, i.payee_id, i.amount FROM incentive_accruals i
     JOIN applications ap ON ap.id = i.application_id JOIN customers c ON c.id = ap.customer_id
    WHERE upper(c.customer_code) = upper($1) AND i.matrix_cell = 'referrer' ORDER BY i.id`, [code])).rows;

/**
 * EVERY accrual, imported ones included. refRows above filters to
 * matrix_cell = 'referrer' and so cannot see an imported row at all — which is
 * exactly how the double-credit got past the first version of these tests.
 */
const allRows = async (code: string) => (await ctx.db.query<{
  application_no: string; payee_type: string; payee_id: string;
  matrix_cell: string | null; amount: string; paid_at: string | null;
}>(
  `SELECT ap.application_no, i.payee_type, i.payee_id, i.matrix_cell, i.amount, i.paid_at
     FROM incentive_accruals i
     JOIN applications ap ON ap.id = i.application_id JOIN customers c ON c.id = ap.customer_id
    WHERE upper(c.customer_code) = upper($1) ORDER BY ap.id, i.id`, [code])).rows;
const totalOf = (rows: { amount: string }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);

/** A customer whose INVESTMENT names one agent while the CUSTOMER names another. */
async function drifted(name: string, phone: string, onInvestment: string, onCustomer: string) {
  for (const n of [onInvestment, onCustomer]) {
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
       VALUES ($1,$2,'manual','Approved',TRUE) ON CONFLICT (agent_code) DO NOTHING`,
      [`AG-D${n.replace(/\W/g,'').slice(0,6)}`, n]);
  }
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount: 500000, date_money_received: '2026-10-05',
  });
  await approveInvestment(checker, app);
  // The state the correction leaves behind: customer moved, investment did not.
  await ctx.db.query('UPDATE applications SET referred_by_text = $1 WHERE customer_id = $2', [onInvestment, cid]);
  await ctx.db.query('UPDATE customers SET referred_by_text = $1 WHERE id = $2', [onCustomer, cid]);
  const { accrueForApplication } = await import('../src/modules/incentives/accrual.js');
  await ctx.db.withTx((tx) => accrueForApplication(tx, Number(app.json.id)));
  const code = (await ctx.db.query<{ customer_code: string }>(
    'SELECT customer_code FROM customers WHERE id = $1', [cid])).rows[0]!.customer_code;
  return { cid, code };
}

describe('aligning an investment to its customer', () => {
  it('moves the commission to the person the customer names — once', async () => {
    const { code } = await drifted('Align Holder One', '9848100001', 'Old Introducer', 'New Introducer');

    const before = await refRows(code);
    expect(before, 'the old introducer holds it to begin with').toHaveLength(1);
    const amount = Number(before[0]!.amount);

    const r = await align(code);
    expect(r.resolved_to?.name).toBe('New Introducer');

    const after = await refRows(code);
    // EXACTLY ONE — two rows here is the double-credit this guards against.
    expect(after, 'the commission must move, not duplicate').toHaveLength(1);
    expect(Number(after[0]!.payee_id)).not.toBe(Number(before[0]!.payee_id));
    expect(Number(after[0]!.amount)).toBe(amount);
  });

  it('writes a NEW referrer to the customer and its investments together', async () => {
    const { code, cid } = await drifted('Align Holder Two', '9848100002', 'Someone A', 'Someone A');
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
       VALUES ('AG-DTARGET','Target Person','manual','Approved',TRUE) ON CONFLICT (agent_code) DO NOTHING`);

    const r = await align(code, 'Target Person');
    expect(r.changed_customer).toBe(true);
    expect(r.resolved_to?.name).toBe('Target Person');

    const cust = (await ctx.db.query<{ referred_by_text: string }>(
      'SELECT referred_by_text FROM customers WHERE id = $1', [cid])).rows[0]!;
    expect(cust.referred_by_text).toBe('Target Person');
    const apps = (await ctx.db.query<{ referred_by_text: string }>(
      'SELECT referred_by_text FROM applications WHERE customer_id = $1', [cid])).rows;
    expect(apps.every((a) => a.referred_by_text === 'Target Person')).toBe(true);
    expect(await refRows(code)).toHaveLength(1);
  });

  /**
   * THE PRODUCTION FAULT, 2026-11-25. The delete was scoped to
   * matrix_cell = 'referrer'. An IMPORTED accrual carries matrix_cell NULL, so
   * the old earner's row survived and the engine inserted a second row for the
   * new one — the same commission credited to two people. A dry run across the
   * drifted customers would have double-paid Rs 45,250 over 7 investments,
   * APP-2026-000728 among them — the very case the repair was written for, so
   * it would have looked like it worked.
   */
  it('removes the old earner even when their row is an IMPORTED one', async () => {
    const { code } = await drifted('Align Holder Four', '9848100004', 'Legacy Introducer', 'Fresh Introducer');

    const before = await refRows(code);
    expect(before).toHaveLength(1);
    const oldPayee = { type: String(before[0]!.payee_type), id: Number(before[0]!.payee_id) };
    const amount = Number(before[0]!.amount);

    // Make it look like the migration wrote it: no matrix_cell.
    await ctx.db.query(
      `UPDATE incentive_accruals SET matrix_cell = NULL
        WHERE payee_type = $1 AND payee_id = $2
          AND application_id IN (SELECT ap.id FROM applications ap JOIN customers c ON c.id = ap.customer_id
                                  WHERE upper(c.customer_code) = upper($3))`,
      [oldPayee.type, oldPayee.id, code]);
    const importedBefore = await allRows(code);
    expect(importedBefore.some((r) => r.matrix_cell === null), 'the imported row is in place').toBe(true);
    const totalBefore = totalOf(importedBefore);

    const r = await align(code);
    expect(r.resolved_to?.name).toBe('Fresh Introducer');
    expect(r.applications[0]?.moves, 'the earner changes').toBe(true);
    expect(r.applications[0]?.moved_from?.id, 'and we know who it comes off').toBe(oldPayee.id);

    const after = await allRows(code);
    expect(
      after.filter((x) => x.payee_type === oldPayee.type && Number(x.payee_id) === oldPayee.id),
      'the old earner must keep NOTHING — an imported row left behind is a second payment',
    ).toHaveLength(0);
    expect(await refRows(code), 'and the new earner holds it exactly once').toHaveLength(1);
    expect(totalOf(after), 'the total commission must not grow').toBe(totalBefore);
    expect(Number((await refRows(code))[0]!.amount)).toBe(amount);
  });

  /**
   * DHN0330 on production: one investment already correct and already PAID,
   * a second one drifted and unpaid. The old per-customer check refused the
   * whole customer over money that was sitting on the right person all along.
   */
  it('repairs a drifted investment even when a SIBLING one is already paid', async () => {
    const { code, cid } = await drifted('Align Holder Five', '9848100005', 'Correct Introducer', 'Correct Introducer');

    // That first investment is right, and its referrer commission has been paid.
    await ctx.db.query(
      `UPDATE incentive_accruals SET paid_at = now()
        WHERE matrix_cell = 'referrer'
          AND application_id IN (SELECT ap.id FROM applications ap JOIN customers c ON c.id = ap.customer_id
                                  WHERE upper(c.customer_code) = upper($1))`, [code]);

    // A second investment, drifted onto somebody else and unpaid.
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
       VALUES ('AG-DSTRAY','Stray Introducer','manual','Approved',TRUE) ON CONFLICT (agent_code) DO NOTHING`);
    const second = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
      amount: 300000, date_money_received: '2026-10-20',
    });
    await approveInvestment(checker, second);
    await ctx.db.query('UPDATE applications SET referred_by_text = $1 WHERE id = $2',
      ['Stray Introducer', Number(second.json.id)]);
    const { accrueForApplication } = await import('../src/modules/incentives/accrual.js');
    await ctx.db.withTx((tx) => accrueForApplication(tx, Number(second.json.id)));

    const paidBefore = (await allRows(code)).filter((r) => r.paid_at !== null);
    expect(paidBefore, 'the paid row is there to be left alone').toHaveLength(1);

    // It must NOT refuse: the paid row is on an investment that does not change.
    const r = await align(code);
    expect(r.resolved_to?.name).toBe('Correct Introducer');
    expect(r.applications.filter((a) => a.moves), 'only the drifted one moves').toHaveLength(1);

    const after = await allRows(code);
    const paidAfter = after.filter((r2) => r2.paid_at !== null);
    expect(paidAfter, 'the paid row is untouched').toHaveLength(1);
    expect(paidAfter[0]!.payee_id).toBe(paidBefore[0]!.payee_id);
    expect(paidAfter[0]!.amount).toBe(paidBefore[0]!.amount);
    // The drifted investment now credits the right person, and the stray none.
    const strayId = Number((await ctx.db.query<{ id: string }>(
      "SELECT id FROM agents WHERE agent_code = 'AG-DSTRAY'")).rows[0]!.id);
    const secondNo = String(second.json.application_no);
    const onSecond = after.filter((x) => x.application_no === secondNo && x.matrix_cell === 'referrer');
    expect(onSecond, 'exactly one referrer row on the repaired investment').toHaveLength(1);
    expect(Number(onSecond[0]!.payee_id)).not.toBe(strayId);
    expect(Number(onSecond[0]!.payee_id)).toBe(r.resolved_to!.id);
    expect(after.filter((x) => x.payee_type === 'agent' && Number(x.payee_id) === strayId),
      'the stray introducer keeps nothing').toHaveLength(0);
  });

  it('still refuses when the money on a CHANGING investment is already paid', async () => {
    const { code } = await drifted('Align Holder Three', '9848100003', 'Paid Introducer', 'Other Introducer');
    await ctx.db.query(
      `UPDATE incentive_accruals SET paid_at = now()
        WHERE application_id IN (SELECT ap.id FROM applications ap JOIN customers c ON c.id=ap.customer_id
                                  WHERE upper(c.customer_code)=upper($1))`, [code]);
    await expect(align(code)).rejects.toThrow(/PAID/i);
  });
});
