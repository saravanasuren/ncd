/**
 * "Pending for" — the investment behind the UNPAID incentive.
 *
 * Owner, 2026-08-03: "one person brought in 2,00,00,000 and for 1 cr incentive
 * of 2 lakhs was paid. now 2 more lakh incentive is pending … but i need a
 * column which says for 1cr amount 2 lakhs of incentives are pending."
 *
 * The figure is summed from the applications whose accrual is actually unpaid,
 * never pro-rated as investment × balance/accrued. These tests exist mainly to
 * pin that distinction: the two agree only while every row carries the same
 * rate, and this book does not (2% and 0.25% both occur).
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
const rowFor = async (payeeId: number) =>
  (await (await admin()).get('/api/incentives/overview')).json.rows
    .find((r: any) => r.payee_type === 'staff' && r.payee_id === payeeId);

describe('incentive pending-investment column', () => {
  let payeeId: number, appPaidId: number, appDueId: number;

  beforeAll(async () => {
    const db = ctx.db;
    payeeId = Number((await db.query("SELECT id FROM users WHERE email = 'bm@demo.local'")).rows[0]!.id);
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const cust = Number((await db.query(
      "INSERT INTO customers (customer_code, full_name, phone, creation_status, enrolled_by_user_id, is_active) VALUES ('PND001','Pending Inv','9333300000','Approved',$1,TRUE) RETURNING id",
      [payeeId])).rows[0]!.id);

    // The owner's own example: ₹2cr of business as two ₹1cr investments.
    appPaidId = Number((await db.query(
      "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id) VALUES ('APP-PND-1',$1,$2,'Active',10000000,$3) RETURNING id",
      [cust, seriesId, payeeId])).rows[0]!.id);
    appDueId = Number((await db.query(
      "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id) VALUES ('APP-PND-2',$1,$2,'Active',10000000,$3) RETURNING id",
      [cust, seriesId, payeeId])).rows[0]!.id);

    // ₹2L incentive on each. The first is already paid, the second is not.
    await db.query("INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at) VALUES ($1,'staff',$2,'selfSourced','pct',2,200000,'2026-07-10', now())", [appPaidId, payeeId]);
    await db.query("INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date) VALUES ($1,'staff',$2,'selfSourced','pct',2,200000,'2026-07-10')", [appDueId, payeeId]);
  });

  it("reports the investment the balance is owed ON, not the whole book", async () => {
    const r = await rowFor(payeeId);
    expect(Number(r.investment_amount)).toBe(20000000);          // ₹2cr brought in
    expect(Number(r.paid)).toBe(200000);                          // ₹2L already paid
    expect(Number(r.balance)).toBe(200000);                       // ₹2L still owed
    expect(Number(r.pending_investment_amount)).toBe(10000000);   // …on ₹1cr
  });

  it('paid and pending investment together account for the whole book', async () => {
    const r = await rowFor(payeeId);
    // Nothing may fall between the two: every eligible accrual is either paid
    // or it is not, so the principal behind them must reconcile exactly.
    expect(Number(r.pending_investment_amount)).toBeLessThanOrEqual(Number(r.investment_amount));
  });

  it('drops to zero once the last incentive is paid', async () => {
    await ctx.db.query('UPDATE incentive_accruals SET paid_at = now() WHERE application_id = $1', [appDueId]);
    const r = await rowFor(payeeId);
    expect(Number(r.balance)).toBe(0);
    expect(Number(r.pending_investment_amount)).toBe(0);
    // The book itself is unchanged — they still brought in ₹2cr.
    expect(Number(r.investment_amount)).toBe(20000000);
    await ctx.db.query('UPDATE incentive_accruals SET paid_at = NULL WHERE application_id = $1', [appDueId]);
  });

  it('stays correct when one payee mixes incentive rates', async () => {
    // THE case that rules out pro-rating. Add ₹1cr at 0.25% (₹25,000), unpaid.
    // Book: ₹3cr. Accrued ₹4,25,000, paid ₹2,00,000, balance ₹2,25,000.
    // Pro-rating would give 3cr × (2.25L/4.25L) = ₹1.588cr — wrong.
    // The truth is the two unpaid investments: ₹1cr + ₹1cr = ₹2cr.
    const db = ctx.db;
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const cust = Number((await db.query("SELECT customer_id FROM applications WHERE id = $1", [appDueId])).rows[0]!.customer_id);
    const appLow = Number((await db.query(
      "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id) VALUES ('APP-PND-3',$1,$2,'Active',10000000,$3) RETURNING id",
      [cust, seriesId, payeeId])).rows[0]!.id);
    await db.query("INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date) VALUES ($1,'staff',$2,'selfSourced','pct',0.25,25000,'2026-07-10')", [appLow, payeeId]);

    const r = await rowFor(payeeId);
    expect(Number(r.investment_amount)).toBe(30000000);
    expect(Number(r.accrued)).toBe(425000);
    expect(Number(r.balance)).toBe(225000);
    expect(Number(r.pending_investment_amount)).toBe(20000000);   // NOT ₹1.588cr
  });
});
