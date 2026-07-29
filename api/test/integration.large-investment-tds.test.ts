/**
 * ">₹30L for a No-TDS customer → apply TDS?" — answering Yes marks the WHOLE
 * customer TDS-applicable (owner spec), not just that one investment. The prompt
 * itself is client-side (amount > ₹30L AND the customer is No-TDS); this pins the
 * server contract it drives: mark_customer_tds flips customers.tds_applicable,
 * audited, and every subsequent payout for that customer then deducts TDS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const noTdsCustomer = async (a: Client, phone: string) => {
  const c = await a.post('/api/customers', { full_name: 'Large Investor', phone, tds_applicable: false });
  await a.post(`/api/customers/${c.json.id}/bank-accounts`, { account_number: '8888000' + phone.slice(-4), ifsc: 'ICIC0001234' });
  return Number(c.json.id);
};
const book = async (a: Client, custId: number, amount: number, markCustomerTds?: boolean) => {
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-12', ...(markCustomerTds ? { mark_customer_tds: true } : {}),
  });
  expect(app.status).toBe(201);
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
};
const custTds = async (custId: number) => (await ctx.db.query<{ t: boolean }>('SELECT tds_applicable AS t FROM customers WHERE id=$1', [custId])).rows[0]!.t;
const scheduleTds = async (appId: number) => Number((await ctx.db.query<{ t: string }>(
  "SELECT COALESCE(sum(tds_amount),0) AS t FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest'", [appId])).rows[0]!.t);

describe('over-₹30L investment marks the whole customer TDS-applicable', () => {
  it('mark_customer_tds flips the customer from No-TDS to TDS-applicable', async () => {
    const a = await admin();
    const cid = await noTdsCustomer(a, '9400000081');
    expect(await custTds(cid)).toBe(false);
    const appId = await book(a, cid, 3100000, true); // > ₹30L, operator said "apply TDS"
    expect(await custTds(cid)).toBe(true);            // the CUSTOMER is now TDS-applicable
    expect(await scheduleTds(appId)).toBeGreaterThan(0);
  });

  it('applies to the customer as a whole — a LATER normal investment also deducts TDS', async () => {
    const a = await admin();
    const cid = await noTdsCustomer(a, '9400000082');
    await book(a, cid, 3100000, true);                // flips the customer
    const laterId = await book(a, cid, 500000);       // small, no prompt/flag
    expect(await scheduleTds(laterId)).toBeGreaterThan(0); // still deducts — the customer is TDS-applicable now
  });

  it('without the flag, a No-TDS customer keeps deducting nothing', async () => {
    const a = await admin();
    const cid = await noTdsCustomer(a, '9400000083');
    const appId = await book(a, cid, 500000);
    expect(await custTds(cid)).toBe(false);
    expect(await scheduleTds(appId)).toBe(0);
  });
});
