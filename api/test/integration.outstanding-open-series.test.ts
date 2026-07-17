/**
 * Regression — outstanding book includes funded-but-not-yet-allotted apps.
 *
 * Money subscribed to a still-Open series (apps sitting in PendingActivation,
 * before activation) is part of the outstanding book, so
 * the dashboard/export match the legacy "Active (net)" figure instead of
 * reporting ₹0 for an open series (the NCD 27 discrepancy). Draft/pre-funding
 * and cancelled money must NOT count.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

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

/** Fund an app up to PendingActivation but do NOT activate/allot it. */
async function makePendingActivationApp(a: Client, name: string, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone: `9${Math.floor(amount)}` });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `2222${amount}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-10', method: 'NEFT' });
  return app.json.id as number;
}

describe('outstanding book — open series (pre-allotment)', () => {
  it('a PendingActivation app counts toward the outstanding book', async () => {
    const a = await admin();
    const appId = await makePendingActivationApp(a, 'Open Series Investor', 400000);

    // Sanity: the app is genuinely funded-but-not-yet-activated, not Active.
    const status = String((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0]!.status);
    expect(status).toBe('PendingActivation');

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

  it('cancelled money drops out of the outstanding book', async () => {
    const a = await admin();
    const appId = await makePendingActivationApp(a, 'Cancelled Investor', 250000);
    await ctx.db.query("UPDATE applications SET status = 'Cancelled' WHERE id = $1", [appId]);

    const ov = await a.get('/api/dashboard/overview');
    // Only the ₹4,00,000 from the first test's investor remains.
    expect(Number(ov.json.kpis.outstanding_book)).toBe(400000);
  });
});
