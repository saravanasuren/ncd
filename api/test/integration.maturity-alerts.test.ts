/**
 * Maturity alerts — NCDs maturing within a window, scoped, with 30/60/all-day
 * totals (owner 2026-08-07, parity with the wealth app).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

/** Insert an Active application + line maturing in `inDays`, directly (skips the
 *  full enrol→approve flow — we only exercise the read). */
async function activeMaturing(custId: number, inDays: number, amount: number) {
  const app = (await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, maturity_date, enrolled_by_user_id, date_money_received)
     VALUES ('APP-MAT-' || $4, $1, $2, 'Active', $3, CURRENT_DATE + $4::int, 1, CURRENT_DATE) RETURNING id`,
    [custId, seriesId, amount, inDays])).rows[0] as { id: string };
  await ctx.db.query(
    `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, amount, outstanding_amount, maturity_date, status)
     VALUES ($1, $2, 13, 36, $3, $3, CURRENT_DATE + $4::int, 'Active')`,
    [Number(app.id), schemeId, amount, inDays]);
  return Number(app.id);
}

describe('maturity alerts', () => {
  it('lists NCDs maturing within the window and buckets the totals', async () => {
    const a = await admin();
    const c1 = await a.post('/api/customers', { full_name: 'Soon Maturing', phone: '9846800001' });
    const c2 = await a.post('/api/customers', { full_name: 'Later Maturing', phone: '9846800002' });
    await activeMaturing(Number(c1.json.id), 20, 500000);   // within 30d
    await activeMaturing(Number(c2.json.id), 75, 300000);   // within 90d, not 60

    const r = await a.get('/api/dashboard/maturity-alerts?days=90');
    expect(r.status).toBe(200);
    expect(r.json.days).toBe(90);
    const codes = r.json.alerts.map((x: any) => x.customer_name);
    expect(codes).toContain('Soon Maturing');
    expect(codes).toContain('Later Maturing');

    const soon = r.json.alerts.find((x: any) => x.customer_name === 'Soon Maturing');
    expect(soon.days_remaining).toBe(20);
    expect(soon.outstanding_amount).toBe(500000);

    expect(r.json.totals.count_30d).toBe(1);          // only the 20-day one
    expect(r.json.totals.amount_30d).toBe(500000);
    expect(r.json.totals.count_all).toBe(2);
    expect(r.json.totals.amount_all).toBe(800000);
  });

  it('a shorter window excludes the later maturity', async () => {
    const a = await admin();
    const r = await a.get('/api/dashboard/maturity-alerts?days=30');
    const names = r.json.alerts.map((x: any) => x.customer_name);
    expect(names).toContain('Soon Maturing');
    expect(names).not.toContain('Later Maturing');
  });
});
