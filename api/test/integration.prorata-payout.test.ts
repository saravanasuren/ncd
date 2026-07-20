/**
 * Pro-rata interest payout (owner decision 2026-07-20): the NEFT sheet can be
 * pulled on ANY date and pays each live line the interest accrued since it was
 * last paid, up to that date. Paying advances the line's paid-through watermark,
 * so the next sheet starts fresh — a period can never be paid twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let appId: number;

const AMOUNT = 1200000;          // ₹12L
const RATE = 12;                 // demo scheme coupon
const START = '2026-07-01';      // interest start (money received)

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);

  const a = new Client(ctx.base);
  await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await a.post('/api/customers', { full_name: 'Prorata Investor', phone: '9800011122' });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '9090909090', ifsc: 'ICIC0001111' });
  // Staff enter the credit date at enrolment; one approval gate = go-live.
  const app = await a.post('/api/applications', {
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: AMOUNT,
    date_money_received: START, collection_method: 'NEFT', collection_reference: 'UTR-PRORATA',
  });
  appId = Number(app.json.id);
  const ncd = new Client(ctx.base);
  await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);   // go live
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const mine = (rows: any[]) => rows.filter((r) => Number(r.application_id) === appId);
const expectedGross = (days: number) => (AMOUNT * RATE) / 100 * days / 365;

describe('pro-rata interest payout on any date', () => {
  it('a mid-period date accrues pro-rata (not a full month)', async () => {
    const a = await admin();
    // 1 Jul -> 11 Jul = 10 days, well before the 28th
    const p = await a.get('/api/payouts/preview?date=2026-07-11');
    const row = mine(p.json.rows)[0];
    expect(row, 'accrual row for our app').toBeTruthy();
    expect(Number(row.days)).toBe(10);
    expect(Number(row.gross_amount)).toBeCloseTo(expectedGross(10), 0);
  });

  it('paying a batch advances the watermark — the next sheet only bills the NEW days', async () => {
    const a = await admin();
    const ncd = new Client(ctx.base);
    await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });

    // settle 1 -> 11 Jul
    const b1 = await a.post('/api/payouts', { payout_date: '2026-07-11' });
    expect(b1.status).toBe(201);
    const paidGross = Number(mine(b1.json.rows)[0].gross_amount);
    expect(paidGross).toBeCloseTo(expectedGross(10), 0);
    // sheet is downloadable straight away (before any approval)
    const sheet = await a.get(`/api/payouts/${b1.json.batch_id}/download.xlsx`);
    expect(sheet.status).toBe(200);
    // maker claims it's paid -> goes to a checker; approval is what settles it
    const mp = await a.post(`/api/payouts/${b1.json.batch_id}/mark-paid`, {});
    expect(mp.status).toBe(200);
    await ncd.post(`/api/approvals/${mp.json.request.id}/approve`);

    // next sheet on 21 Jul must bill only 11 -> 21 (10 days), NOT 1 -> 21 (20 days)
    const p2 = await a.get('/api/payouts/preview?date=2026-07-21');
    const row2 = mine(p2.json.rows)[0];
    expect(Number(row2.days)).toBe(10);
    expect(row2.from_date).toBe('2026-07-11'); // watermark moved to the paid date
    expect(Number(row2.gross_amount)).toBeCloseTo(expectedGross(10), 0);
    expect(Number(row2.gross_amount)).toBeLessThan(expectedGross(20)); // no double-pay
  });

  it('nothing accrues for a date already settled', async () => {
    const a = await admin();
    const p = await a.get('/api/payouts/preview?date=2026-07-11'); // already paid through 11 Jul
    expect(mine(p.json.rows).length).toBe(0);
  });
});
