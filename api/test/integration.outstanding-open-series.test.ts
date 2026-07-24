/**
 * Regression — outstanding book includes approved-but-not-yet-allotted apps.
 *
 * An investment that has been approved (Active) on a still-Open series — before
 * the series is allotted — is part of the outstanding book, so the
 * dashboard/export match the legacy "Active (net)" figure instead of reporting
 * ₹0 for an open series (the NCD 27 discrepancy). Unapproved (PendingApproval)
 * and cancelled money must NOT count.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
async function ncdManager() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  return c;
}

/** Enrol + approve an app so it's Active on a still-Open series (not allotted). */
async function makeActiveApp(a: Client, checker: Client, name: string, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone: `9${Math.floor(amount)}` });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `2222${amount}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10' });
  await approveInvestment(checker, app);
  return app.json.id as number;
}

describe('outstanding book — open series (pre-allotment)', () => {
  it('an approved (Active) app on an open series counts toward the outstanding book', async () => {
    const a = await admin();
    const ncd = await ncdManager();
    const appId = await makeActiveApp(a, ncd, 'Open Series Investor', 400000);

    // Sanity: the app is Active but the series is still Open (not allotted).
    const row = (await ctx.db.query('SELECT status, allotment_date FROM applications WHERE id = $1', [appId])).rows[0]! as any;
    expect(row.status).toBe('Active');
    expect(row.allotment_date).toBeNull();

    const ov = await a.get('/api/dashboard/overview');
    expect(ov.status).toBe(200);
    expect(Number(ov.json.kpis.outstanding_book)).toBe(400000);
    expect(ov.json.kpis.active_investors).toBe(1);

    // Series register shows the open series' outstanding, not ₹0.
    const series = ov.json.series.find((s: { series_id: number }) => s.series_id === seriesId);
    expect(Number(series.outstanding)).toBe(400000);

    // Drill-down reconciles with the tile (grouped: one summary row per series).
    const dl = await a.get(`/api/dashboard/drill/series?param=${seriesId}`);
    expect(dl.status).toBe(200);
    const grp = (dl.json.groups as Array<{ key: string; outstanding: number }>).find((g) => g.key === series.code);
    expect(Number(grp!.outstanding)).toBe(400000);
  });

  it('an unapproved (PendingApproval) app does NOT count toward the outstanding book', async () => {
    const a = await admin();
    const before = Number((await a.get('/api/dashboard/overview')).json.kpis.outstanding_book);
    const cust = await a.post('/api/customers', { full_name: 'Unapproved Investor', phone: '9755500777' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '2222777', ifsc: 'ICIC0001111' });
    await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 300000, date_money_received: '2026-07-10' });
    const after = Number((await a.get('/api/dashboard/overview')).json.kpis.outstanding_book);
    expect(after).toBe(before); // still awaiting approval → not in the book yet
  });

  it('cancelled money drops out of the outstanding book', async () => {
    const a = await admin();
    const ncd = await ncdManager();
    const appId = await makeActiveApp(a, ncd, 'Cancelled Investor', 200000);
    await ctx.db.query("UPDATE applications SET status = 'Cancelled' WHERE id = $1", [appId]);

    const ov = await a.get('/api/dashboard/overview');
    // Only the ₹4,00,000 from the first test's investor remains.
    expect(Number(ov.json.kpis.outstanding_book)).toBe(400000);
  });
});
