/**
 * Phase 6 integration — customer portal (OTP → holdings) + the LockerHub /
 * DhanamFin integration façade (key auth + contract shapes). PGlite HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let customerPhone = '9800011122';

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await buildActiveCustomer();
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const KEY = 'dev-integration-key';

async function integ(method: string, path: string, body?: unknown) {
  const res = await fetch(ctx.base + path, {
    method,
    headers: { 'X-Integration-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

async function buildActiveCustomer() {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Portal Customer', phone: customerPhone, email: 'portal.cust@example.com' });
  const cid = cust.json.id;
  // Submit + approve the customer so it becomes active (real flow).
  const submit = await a.post(`/api/customers/${cid}/submit-for-approval`);
  const ncd0 = await as('ncd@demo.local');
  await ncd0.post(`/api/approvals/${submit.json.request.id}/approve`);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '77770001111', ifsc: 'HDFC0009999' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  const ncd = await as('ncd@demo.local');
  await approveInvestment(ncd, app);
}

describe('customer portal — OTP login', () => {
  it('request OTP queues a notification, verify logs the customer in', async () => {
    const c = new Client(ctx.base);
    const req = await c.post('/api/portal/otp/request', { identifier: customerPhone });
    expect(req.status).toBe(200);
    expect(req.json.destination).toContain('•'); // masked

    // The stub "sent" the OTP into the notifications queue payload.
    const { rows } = await ctx.db.query("SELECT payload FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1");
    const otp = (rows[0] as any).payload.otp as string;
    expect(otp).toMatch(/^\d{6}$/);

    const verify = await c.post('/api/portal/otp/verify', { identifier: customerPhone, otp });
    expect(verify.status).toBe(200);
    expect(verify.json.user.role).toBe('customer');

    const holdings = await c.get('/api/portal/holdings');
    expect(holdings.status).toBe(200);
    expect(Number(holdings.json.total_invested)).toBe(400000);
  });

  it('a wrong OTP is rejected', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/portal/otp/request', { identifier: customerPhone });
    const verify = await c.post('/api/portal/otp/verify', { identifier: customerPhone, otp: '000000' });
    expect(verify.status).toBe(401);
  });

  it('a customer session cannot reach staff endpoints', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/portal/otp/request', { identifier: customerPhone });
    const otp = (await ctx.db.query("SELECT payload FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1")).rows[0] as any;
    await c.post('/api/portal/otp/verify', { identifier: customerPhone, otp: otp.payload.otp });
    expect((await c.get('/api/customers')).status).toBe(403); // no customers:read
    expect((await c.get('/api/settings')).status).toBe(403);
  });
});

describe('integration façade — key auth', () => {
  it('rejects a missing/invalid integration key', async () => {
    const noKey = await fetch(ctx.base + `/api/integration/customers/by-phone/${customerPhone}`);
    expect(noKey.status).toBe(401);
  });

  it('L1 customer-by-phone returns the contract shape', async () => {
    const r = await integ('GET', `/api/integration/customers/by-phone/${customerPhone}`);
    expect(r.status).toBe(200);
    expect(r.json.name).toBe('Portal Customer');
    expect(r.json).toHaveProperty('kyc_status');
  });

  it('L2 holdings include the totals block (locker double-count guard)', async () => {
    const cid = Number((await ctx.db.query('SELECT id FROM customers WHERE phone = $1', [customerPhone])).rows[0]!.id);
    const r = await integ('GET', `/api/integration/customers/${cid}/holdings`);
    expect(r.status).toBe(200);
    expect(Number(r.json.totals.ncd_principal)).toBe(400000);
    expect(Number(r.json.totals.ncd_principal_excluding_locker_deposits)).toBe(400000);
    expect(r.json.holdings[0].status).toBe('Active');
  });

  it('penny-drop returns BAV v3 shape', async () => {
    const ok = await integ('POST', '/api/integration/penny-drop', { account_number: '12345678', ifsc: 'HDFC0001234' });
    expect(ok.json.status).toBe('Verified');
    expect(ok.json).toHaveProperty('name_on_record');
    expect(ok.json).toHaveProperty('ref_id');
    const bad = await integ('POST', '/api/integration/penny-drop', { account_number: '00001111', ifsc: 'HDFC0001234' });
    expect(bad.json.status).toBe('Failed');
    expect(bad.json.failure_reason).toBeTruthy();
    const invalid = await integ('POST', '/api/integration/penny-drop', { account_number: '12345678', ifsc: 'BAD' });
    expect(invalid.json.status).toBe('Invalid');
    expect(invalid.json.provider).toBe('local');
  });

  it('leads follow the wealth wire shape and dedup on phone', async () => {
    const a = await integ('POST', '/api/integration/leads', { name: 'App Lead', phone: '9001234567', source: 'lockerhub_web' });
    expect(a.status).toBe(200);
    expect(a.json.success).toBe(true);
    expect(a.json.reference_id).toMatch(/^LEAD-\d{6}-\d{5}$/);
    const b = await integ('POST', '/api/integration/leads', { name: 'App Lead', phone: '9001234567' });
    expect(b.json.success).toBe(false);
    expect(b.json.duplicate).toBe(true);
    expect(b.json.lead_id).toBe(a.json.lead_id);
    const badSource = await integ('POST', '/api/integration/leads', { name: 'X Lead', phone: '9001234568', source: 'random_app' });
    expect(badSource.status).toBe(400);
  });

  it('agent self-signup lands in the approval queue, then activates on approval', async () => {
    const signup = await integ('POST', '/api/integration/agents/from-lockerhub', { full_name: 'App Agent', phone: '9012345678', email: 'appagent@example.com' });
    expect(signup.status).toBe(201);
    expect(signup.json.status).toBe('pending_approval');
    const agentId = signup.json.agent_id;

    // NCD Manager approves the agent registration.
    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/approvals/queue');
    const item = queue.json.rows.find((r: any) => r.request_type === 'agent_registration' && r.entity_id === String(agentId));
    expect(item).toBeTruthy();
    const appr = await ncd.post(`/api/approvals/${item.id}/approve`);
    expect(appr.status).toBe(200);

    const active = (await ctx.db.query('SELECT is_active, commission_status FROM agents WHERE id = $1', [agentId])).rows[0] as any;
    expect(active.is_active).toBe(true);
    expect(active.commission_status).toBe('Approved');

    // email-check now routes this agent to sign-in
    const ec = await integ('GET', '/api/integration/agents/email-check?email=appagent@example.com');
    expect(ec.json.exists).toBe(true);
  });
});
