/**
 * "My Dashboard" for branch staff (owner spec 2026-07-20). Branch staff must
 * NOT see the company-wide NCD Portfolio; they get their own book — only what
 * they enrolled — with series-wise and month-wise breakdowns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('branch staff — My Dashboard', () => {
  it('branch staff cannot open the company-wide dashboard', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.get('/api/dashboard/overview');
    expect(r.status).toBe(403);
  });

  it('shows only what the staff member enrolled, with series + month breakdown', async () => {
    const staff = await as('staff@demo.local');
    const ncd = await as('ncd@demo.local');

    // Staff enrols two investments for two customers…
    const mine: number[] = [];
    for (const [name, phone, amount] of [['My Cust A', '9866000001', 200000], ['My Cust B', '9866000002', 300000]] as const) {
      const cust = await staff.post('/api/customers', { full_name: name, phone });
      const app = await staff.post('/api/applications', {
        customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10',
      });
      expect(app.status).toBe(201);
      await approveInvestment(ncd, app);
      mine.push(Number(app.json.id));
    }

    // …and somebody ELSE enrols one, which must not appear in the staff's book.
    const a = await admin();
    const other = await a.post('/api/customers', { full_name: 'Not Mine', phone: '9866000009' });
    const otherApp = await a.post('/api/applications', {
      customer_id: other.json.id, series_id: seriesId, scheme_id: schemeId, amount: 900000, date_money_received: '2026-07-10',
    });
    await approveInvestment(ncd, otherApp);

    const r = await staff.get('/api/dashboard/my');
    expect(r.status).toBe(200);
    expect(r.json.totals.investments).toBe(2);
    expect(r.json.totals.customers).toBe(2);
    expect(Number(r.json.totals.amount)).toBe(500000); // 2L + 3L — the 9L is not theirs

    const series = r.json.by_series.find((s: any) => s.series_code === 'NCD DEMO');
    expect(series).toBeTruthy();
    expect(series.investments).toBe(2);
    expect(series.customers).toBe(2);
    expect(Number(series.amount)).toBe(500000);

    const month = r.json.by_month.find((m: any) => m.month === '2026-07');
    expect(month).toBeTruthy();
    expect(month.investments).toBe(2);
    expect(Number(month.amount)).toBe(500000);
  });

  it('a cancelled investment drops out of the staff book', async () => {
    const staff = await as('staff@demo.local');
    const before = Number((await staff.get('/api/dashboard/my')).json.totals.amount);
    const cust = await staff.post('/api/customers', { full_name: 'Cancelled Cust', phone: '9866000003' });
    const app = await staff.post('/api/applications', {
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-10',
    });
    await ctx.db.query("UPDATE applications SET status = 'Cancelled' WHERE id = $1", [app.json.id]);
    const after = Number((await staff.get('/api/dashboard/my')).json.totals.amount);
    expect(after).toBe(before);
  });
});
