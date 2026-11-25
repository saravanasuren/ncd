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

  it('refuses when any of the commission is already paid', async () => {
    const { code } = await drifted('Align Holder Three', '9848100003', 'Paid Introducer', 'Other Introducer');
    await ctx.db.query(
      `UPDATE incentive_accruals SET paid_at = now()
        WHERE application_id IN (SELECT ap.id FROM applications ap JOIN customers c ON c.id=ap.customer_id
                                  WHERE upper(c.customer_code)=upper($1))`, [code]);
    await expect(align(code)).rejects.toThrow(/PAID/i);
  });
});
