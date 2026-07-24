/**
 * Outstanding book nets partial premature withdrawals (2026-07-18). A part-
 * redeemed investment keeps its application row Active but its line
 * outstanding_amount drops; the book must sum the LIVE line outstanding, not
 * the original subscription (which overstated the tile by every partial —
 * the ₹25L Jaya/Balavinod/Ananthaprabha case).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = new Client(ctx.base);
  await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await a.post('/api/customers', { full_name: 'Partial Investor', phone: '9755500001' });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '4444555566', ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1500000, date_money_received: '2026-07-10' });
  appId = Number(app.json.id);
  const ncd = new Client(ctx.base);
  await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await approveInvestment(ncd, app);
});
afterAll(async () => { await ctx.close(); });

describe('book nets partial withdrawals', () => {
  it('a partial withdrawal reduces the outstanding tile, not just the line', async () => {
    const a = new Client(ctx.base);
    await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });

    const before = await a.get('/api/dashboard/overview');
    const b = Number(before.json.kpis.outstanding_book);
    expect(b).toBe(1500000);

    // Simulate the wealth-style partial premature withdrawal: ₹10L of ₹15L out.
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 500000 WHERE application_id = $1", [appId]);

    const after = await a.get('/api/dashboard/overview');
    expect(Number(after.json.kpis.outstanding_book)).toBe(500000);

    // Series register + segments agree.
    const series = (after.json.series as Array<{ series_id: number; outstanding: string }>).find((s) => s.series_id === seriesId);
    expect(Number(series!.outstanding)).toBe(500000);
  });
});
