/**
 * Workflow-alignment locks:
 *  - maturity redemption requires a maker→checker approval (not immediate);
 *  - every investment goes through one approval gate — PendingApproval until a
 *    distinct checker approves, which is the go-live (Active).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';

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
  const cust = await a.post('/api/customers', { full_name: uniqueName('Cust', phone), phone });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `55${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  const ncd = await as('ncd@demo.local');
  await approveInvestment(ncd, app);
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

describe('every investment goes through one approval gate', () => {
  it('new application waits in PendingApproval with an investment approval raised', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Gated', phone: '9300000003' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
    expect(app.json.subscription_request).toBeTruthy();
    expect((await a.get(`/api/applications/${app.json.id}`)).json.application.status).toBe('PendingApproval');
  });

  it('the maker cannot self-approve; a distinct checker approves → the NCD goes live (Active)', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'GoLive', phone: '9300000004' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
    // maker (admin, who created it) is refused
    const self = await a.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect(self.status).toBe(403);
    // a distinct checker (NCD Manager) approves → Active
    const ncd = await as('ncd@demo.local');
    await approveInvestment(ncd, app);
    expect((await a.get(`/api/applications/${app.json.id}`)).json.application.status).toBe('Active');
  });
});
