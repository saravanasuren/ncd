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

  it('branch staff cannot open My Earnings; the dashboard shows only PAID incentive', async () => {
    const staff = await as('staff@demo.local');
    // The My Earnings page is gone for branch staff.
    expect((await staff.get('/api/incentives/my-earnings')).status).toBe(403);

    const staffId = Number((await ctx.db.query("SELECT id FROM users WHERE email='staff@demo.local'")).rows[0]!.id);
    const appId = Number((await ctx.db.query(
      "SELECT id FROM applications WHERE enrolled_by_user_id=$1 ORDER BY id LIMIT 1", [staffId])).rows[0]!.id);

    // Two accruals for this staff member: one PAID, one still unpaid.
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
       VALUES ($1,'staff',$2,'staff_new','pct',2,7000,'2026-07-10', now())
       ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE SET amount = 7000, paid_at = now()`, [appId, staffId]);
    const appId2 = Number((await ctx.db.query(
      "SELECT id FROM applications WHERE enrolled_by_user_id=$1 ORDER BY id DESC LIMIT 1", [staffId])).rows[0]!.id);
    if (appId2 !== appId) {
      await ctx.db.query(
        `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
         VALUES ($1,'staff',$2,'staff_new','pct',2,5000,'2026-07-10', NULL)
         ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE SET amount = 5000, paid_at = NULL`, [appId2, staffId]);
    }

    const r = await staff.get('/api/dashboard/my');
    expect(r.status).toBe(200);
    // Only the PAID ₹7,000 — the unpaid ₹5,000 is deliberately not surfaced.
    expect(Number(r.json.totals.incentives_paid)).toBe(7000);
    expect(r.json.totals).not.toHaveProperty('incentives_accrued');
    expect(r.json.totals).not.toHaveProperty('incentives_balance');
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
