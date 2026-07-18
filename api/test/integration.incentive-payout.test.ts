/**
 * Incentives — self-investment exclusion (phone match) + per-customer pay
 * (owner rules 2026-07-18). Seeds accruals directly so the test is independent
 * of the full activation flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('incentives — self-investment excluded, per-customer pay', () => {
  let payeeUserId: number, appNormalId: number, appSelfId: number;

  beforeAll(async () => {
    const db = ctx.db;
    payeeUserId = Number((await db.query("SELECT id FROM users WHERE email = 'staff@demo.local'")).rows[0]!.id);
    await db.query("UPDATE users SET phone = '9990001111' WHERE id = $1", [payeeUserId]);
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);

    // Normal customer (different phone) and a self-investment (same phone as the staff).
    const c1 = Number((await db.query("INSERT INTO customers (customer_code, full_name, phone, creation_status, enrolled_by_user_id, is_active) VALUES ('INC001','Normal Inv','9111100000','Approved',$1,TRUE) RETURNING id", [payeeUserId])).rows[0]!.id);
    const c2 = Number((await db.query("INSERT INTO customers (customer_code, full_name, phone, creation_status, enrolled_by_user_id, is_active) VALUES ('INC002','Self Inv','9990001111','Approved',$1,TRUE) RETURNING id", [payeeUserId])).rows[0]!.id);
    appNormalId = Number((await db.query("INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id) VALUES ('APP-INC-1',$1,$2,'Active',500000,$3) RETURNING id", [c1, seriesId, payeeUserId])).rows[0]!.id);
    appSelfId = Number((await db.query("INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id) VALUES ('APP-INC-2',$1,$2,'Active',300000,$3) RETURNING id", [c2, seriesId, payeeUserId])).rows[0]!.id);
    await db.query("INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date) VALUES ($1,'staff',$2,'selfSourced','pct',2,10000,'2026-07-10')", [appNormalId, payeeUserId]);
    await db.query("INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date) VALUES ($1,'staff',$2,'selfSourced','pct',2,6000,'2026-07-10')", [appSelfId, payeeUserId]);
  });

  it('overview excludes the self-investment (its investment + incentive do not count)', async () => {
    const a = await admin();
    const ov = await a.get('/api/incentives/overview');
    const row = ov.json.rows.find((r: any) => r.payee_type === 'staff' && r.payee_id === payeeUserId);
    expect(row).toBeTruthy();
    expect(Number(row.investment_amount)).toBe(500000);   // only the ₹5L, not the ₹3L self
    expect(Number(row.accrued)).toBe(10000);              // only the ₹10k, not the ₹6k self
  });

  it('the per-customer breakdown lists the normal customer, not the self one', async () => {
    const a = await admin();
    const dl = await a.get(`/api/incentives/payees/staff/${payeeUserId}/accruals`);
    const apps = dl.json.rows.map((r: any) => r.application_no);
    expect(apps).toContain('APP-INC-1');
    expect(apps).not.toContain('APP-INC-2');
    // rows carry the series + investment date for the Month/Series columns
    expect(dl.json.rows[0].series_code).toBe('NCD DEMO');
    expect(dl.json.rows[0]).toHaveProperty('date_money_received');
  });

  it('paying one customer in full marks it paid and clears the balance', async () => {
    const a = await admin();
    const pay = await a.post(`/api/incentives/payees/staff/${payeeUserId}/accruals/${appNormalId}/pay`, {});
    expect(pay.status).toBe(200);
    expect(Number(pay.json.paid)).toBe(10000);
    expect(Number(pay.json.balance)).toBe(0);
    const dl = await a.get(`/api/incentives/payees/staff/${payeeUserId}/accruals`);
    expect(dl.json.rows.find((r: any) => r.application_no === 'APP-INC-1').paid).toBe(true);
  });

  it('only a Super Admin can revert a payment; revert restores the balance', async () => {
    // A plain admin (has incentives:pay) is still refused the revert.
    const plainAdmin = new Client(ctx.base);
    await plainAdmin.post('/api/auth/login', { email: 'admin@demo.local', password: 'Demo_1234' });
    const denied = await plainAdmin.post(`/api/incentives/payees/staff/${payeeUserId}/accruals/${appNormalId}/revert-payment`, {});
    expect(denied.status).toBe(403);

    // Super Admin (seed admin) can — the accrual goes back to unpaid, balance owes again.
    const sa = await admin();
    const rev = await sa.post(`/api/incentives/payees/staff/${payeeUserId}/accruals/${appNormalId}/revert-payment`, {});
    expect(rev.status).toBe(200);
    expect(Number(rev.json.paid)).toBe(0);
    expect(Number(rev.json.balance)).toBe(10000);
    const dl = await sa.get(`/api/incentives/payees/staff/${payeeUserId}/accruals`);
    expect(dl.json.rows.find((r: any) => r.application_no === 'APP-INC-1').paid).toBe(false);
  });
});
