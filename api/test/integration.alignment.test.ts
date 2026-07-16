/**
 * Workflow-alignment locks (old-app parity):
 *  - maturity redemption now requires a maker→checker approval (not immediate);
 *  - the subscription-at-creation gate is off by default but works when enabled.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function activeApp(a: Client, phone: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: `Cust ${phone}`, phone });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `55${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000 });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: 500000, date_money_received: '2026-07-12', method: 'NEFT' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  const ncd = await as('ncd@demo.local');
  const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
  await a.post(`/api/approvals/${batch.json.request.id}/approve`);
  return app.json.id;
}

describe('maturity redemption requires approval (old-app parity)', () => {
  it('initiate → still Active until a checker approves → then Redeemed', async () => {
    const a = await admin();
    const appId = await activeApp(a, '9300000001');
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/maturity', { application_id: appId });
    expect(init.status).toBe(201);
    // not closed yet
    expect((await a.get(`/api/applications/${appId}`)).json.application.status).toBe('Active');
    // single checker (admin ≠ maker ncd) approves → Redeemed
    const appr = await a.post(`/api/approvals/${init.json.request.id}/approve`);
    expect(appr.json.request.status).toBe('Approved');
    expect((await a.get(`/api/applications/${appId}`)).json.application.status).toBe('Redeemed');
  });
});

describe('subscription-at-creation gate (off by default)', () => {
  it('off by default → new application goes straight to PendingFundVerification', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'NoGate', phone: '9300000002' });
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    expect((await a.get(`/api/applications/${app.json.id}`)).json.application.status).toBe('PendingFundVerification');
  });

  it('when enabled → application waits in PendingApproval until the subscription is approved', async () => {
    const a = await admin();
    await a.put('/api/settings/approvals.subscription_maker_checker', { value: true });
    const cust = await a.post('/api/customers', { full_name: 'Gated', phone: '9300000003' });
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    expect(app.json.subscription_request).toBeTruthy();
    expect((await a.get(`/api/applications/${app.json.id}`)).json.application.status).toBe('PendingApproval');
    // a different checker (NCD Manager) approves → advances to PendingFundVerification
    const ncd = await as('ncd@demo.local');
    await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect((await a.get(`/api/applications/${app.json.id}`)).json.application.status).toBe('PendingFundVerification');
    await a.put('/api/settings/approvals.subscription_maker_checker', { value: false }); // restore
  });
});
