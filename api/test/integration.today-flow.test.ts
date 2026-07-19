/** today_book detail (2026-07-18): the dashboard's "Today's additions / deletions"
 * cards need per-row detail + a channel/type split, not just aggregate totals.
 * Isolated server so the added app doesn't perturb the shared reports suite. */
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

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe("today's flow cards", () => {
  it('additions carry per-row detail + a channel split that reconciles to the total', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Today Investor', phone: '9880001111' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '2222333344', ifsc: 'ICIC0001111' });
    const today = new Date().toISOString().slice(0, 10);
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 250000, date_money_received: today, collection_method: 'NEFT' });
    // Approve (distinct checker) → the NCD goes live with today's credit date.
    const ncd = new Client(ctx.base);
    await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    await approveInvestment(ncd, app);

    const tb = (await a.get('/api/dashboard/overview')).json.today_book;
    expect(Array.isArray(tb.additions.rows)).toBe(true);
    const row = tb.additions.rows.find((r: any) => r.application_no === app.json.application_no);
    expect(row).toBeTruthy();
    expect(row.received_via).toBe('NEFT'); // staff-keyed → shows the actual payment method
    expect(Number(row.amount)).toBe(250000);
    expect(row.customer_id).toBe(cust.json.id);         // row is clickable → customer
    expect(tb.additions.count).toBe(1);
    expect(tb.additions.amount).toBe(250000);
    // split always reconciles to the total
    expect(tb.additions.app + tb.additions.locker + tb.additions.physical).toBe(tb.additions.amount);
    // deletions side present + shaped even when empty
    expect(Array.isArray(tb.deletions.rows)).toBe(true);
    expect(tb.deletions.count).toBe(0);
    expect(tb.deletions.premature + tb.deletions.maturity).toBe(tb.deletions.amount);
  });

  it('Paid redemptions count in the redemptions flow tile (not only Approved)', async () => {
    const a = await admin();
    const today = new Date().toISOString().slice(0, 10);
    const appId = Number((await ctx.db.query('SELECT id FROM applications ORDER BY id LIMIT 1')).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, penalty, net_payment, broken_interest, requested_date, redemption_date, status)
       VALUES ('RED-TEST-PAID', $1, 'premature', 50000, 0, 50000, 0, $2, $2, 'Paid')`, [appId, today]);
    const ov = await a.get('/api/dashboard/overview');
    expect(Number(ov.json.flow.redemptions_total)).toBeGreaterThanOrEqual(50000);
    expect(Number(ov.json.flow.redemptions_count)).toBeGreaterThanOrEqual(1);
  });

  it('an unfunded PendingApproval subscription is NOT in the outstanding book', async () => {
    const a = await admin();
    const before = Number((await a.get('/api/dashboard/overview')).json.kpis.outstanding_book);
    // A PendingApproval app (subscription gate, no money received) must not count.
    const cust = await a.post('/api/customers', { full_name: 'Pending Approval Cust', phone: '9744400009' });
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 999999 });
    await ctx.db.query("UPDATE applications SET status='PendingApproval' WHERE id=$1", [app.json.id]);
    const after = Number((await a.get('/api/dashboard/overview')).json.kpis.outstanding_book);
    expect(after).toBe(before); // unchanged — pending-approval money excluded
  });

  it('monthly interest = gross run-rate coupon of the whole outstanding book', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    // With one Active ₹2.5L line at the demo coupon, monthly = outstanding*rate/12.
    const outstanding = Number(ov.json.kpis.outstanding_book);
    const rate = Number(ov.json.rate_mix.weighted_avg_rate);
    const expected = Math.round((outstanding * (rate / 100) / 12) * 100) / 100;
    const shown = Number(ov.json.interest_snapshot.monthly_projected);
    // within ₹1 of the run-rate identity (rounding across per-line vs weighted-avg)
    expect(Math.abs(shown - expected)).toBeLessThanOrEqual(Math.max(1, expected * 0.001));
    expect(shown).toBeGreaterThan(0);
  });

  it('customer detail includes the investments list with live outstanding', async () => {
    const a = await admin();
    const custId = Number((await ctx.db.query("SELECT id FROM customers WHERE full_name='Today Investor'")).rows[0]!.id);
    const detail = await a.get(`/api/customers/${custId}`);
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.json.applications)).toBe(true);
    const app = detail.json.applications[0];
    expect(app.series_code).toBe('NCD DEMO');
    expect(Number(app.amount)).toBe(250000);
    expect(Number(app.outstanding)).toBe(250000);
    expect(app.application_no).toMatch(/^APP-/);
  });

  it('a batch approval detail lists the covered applications', async () => {
    const a = await admin();
    const ncd = new Client(ctx.base);
    await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    // Allotment batches carry the "covered applications" detail (the live apps
    // being allotted). The Today Investor app from the first test is Active.
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    const reqId = Number(batch.json.request.id);
    const det = await a.get(`/api/approvals/${reqId}`);
    expect(det.status).toBe(200);
    const covered = det.json.covered as any[];
    expect(Array.isArray(covered)).toBe(true);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered[0].customer).toBeTruthy();
    expect(covered[0].application_no).toMatch(/^APP-/);
    expect(Number(covered[0].amount)).toBeGreaterThan(0);
    // clean up: reject so other tests' state is untouched
    await a.post(`/api/approvals/${reqId}/reject`, { reason: 'test cleanup' });
  });

  it('a locker-flagged addition lands in the locker split', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Locker Today', phone: '9880002222' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '5555666677', ifsc: 'ICIC0001111' });
    const today = new Date().toISOString().slice(0, 10);
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, is_locker_deposit: true, date_money_received: today, collection_method: 'Cash' });

    const tb = (await a.get('/api/dashboard/overview')).json.today_book;
    const row = tb.additions.rows.find((r: any) => r.application_no === app.json.application_no);
    expect(row.received_via).toBe('Locker');
    expect(tb.additions.locker).toBeGreaterThanOrEqual(100000);
  });
});
