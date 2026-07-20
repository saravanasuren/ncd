/**
 * My Earnings — the single self-service view (owner spec 2026-07-20).
 *
 * There is no separate "My Dashboard": My Earnings carries what the person
 * brought in (investments / applications / customers, series-wise and
 * month-wise) alongside what Dhanam has PAID them. For every role, accrued and
 * pending balance are never exposed — not even as fields in the response.
 * Branch staff additionally cannot open the company-wide dashboard.
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

describe('My Earnings — brought-in book + paid incentive only', () => {
  it('branch staff still cannot open the company-wide dashboard', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.get('/api/dashboard/overview')).status).toBe(403);
  });

  it('shows only what the person brought in, with series + month breakdown', async () => {
    const staff = await as('staff@demo.local');
    const ncd = await as('ncd@demo.local');

    for (const [name, phone, amount] of [['My Cust A', '9866000001', 200000], ['My Cust B', '9866000002', 300000]] as const) {
      const cust = await staff.post('/api/customers', { full_name: name, phone });
      const app = await staff.post('/api/applications', {
        customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10',
      });
      expect(app.status).toBe(201);
      await approveInvestment(ncd, app);
    }

    // Somebody else's investment must not leak into the staff member's book.
    const a = await admin();
    const other = await a.post('/api/customers', { full_name: 'Not Mine', phone: '9866000009' });
    const otherApp = await a.post('/api/applications', {
      customer_id: other.json.id, series_id: seriesId, scheme_id: schemeId, amount: 900000, date_money_received: '2026-07-10',
    });
    await approveInvestment(ncd, otherApp);

    const r = await staff.get('/api/incentives/my-earnings');
    expect(r.status).toBe(200); // My Earnings is back for branch staff
    expect(r.json.totals.investments).toBe(2);
    expect(r.json.totals.customers).toBe(2);
    expect(Number(r.json.totals.amount)).toBe(500000); // the 9L is not theirs

    const series = r.json.by_series.find((s: any) => s.series_code === 'NCD DEMO');
    expect(series.investments).toBe(2);
    expect(Number(series.amount)).toBe(500000);

    const month = r.json.by_month.find((m: any) => m.month === '2026-07');
    expect(month.investments).toBe(2);
    expect(Number(month.amount)).toBe(500000);
  });

  it('exposes PAID incentive only — accrued and balance never leave the API', async () => {
    const staff = await as('staff@demo.local');
    const staffId = Number((await ctx.db.query("SELECT id FROM users WHERE email='staff@demo.local'")).rows[0]!.id);
    const apps = (await ctx.db.query(
      "SELECT id FROM applications WHERE enrolled_by_user_id=$1 ORDER BY id", [staffId])).rows as any[];

    // One PAID ₹7,000 accrual and one UNPAID ₹5,000 accrual.
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
       VALUES ($1,'staff',$2,'staff_new','pct',2,7000,'2026-07-10', now())
       ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE SET amount = 7000, paid_at = now()`, [apps[0].id, staffId]);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
       VALUES ($1,'staff',$2,'staff_new','pct',2,5000,'2026-07-10', NULL)
       ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE SET amount = 5000, paid_at = NULL`, [apps[1].id, staffId]);

    const r = await staff.get('/api/incentives/my-earnings');
    expect(Number(r.json.paid)).toBe(7000);           // only the paid one
    expect(r.json).not.toHaveProperty('accrued');     // never exposed
    expect(r.json).not.toHaveProperty('balance');     // never exposed
    expect(r.json).not.toHaveProperty('accruals');    // the old unpaid list is gone

    // The payout list carries only paid rows.
    expect(r.json.paid_items.length).toBe(1);
    expect(Number(r.json.paid_items[0].amount)).toBe(7000);
  });

  it('a cancelled investment drops out of the brought-in book', async () => {
    const staff = await as('staff@demo.local');
    const before = Number((await staff.get('/api/incentives/my-earnings')).json.totals.amount);
    const cust = await staff.post('/api/customers', { full_name: 'Cancelled Cust', phone: '9866000003' });
    const app = await staff.post('/api/applications', {
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-10',
    });
    await ctx.db.query("UPDATE applications SET status = 'Cancelled' WHERE id = $1", [app.json.id]);
    const after = Number((await staff.get('/api/incentives/my-earnings')).json.totals.amount);
    expect(after).toBe(before);
  });
});
