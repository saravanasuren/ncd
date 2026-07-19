/**
 * Gap A — redemption requests (portal + app) → staff processing → approval,
 * plus rollover / transfer / transformation. PGlite HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Build an approved customer with one Active investment; return ids. */
async function activeInvestment(name: string, phone: string, amount = 500000) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id;
  const sub = await a.post(`/api/customers/${cid}/submit-for-approval`);
  const ncd = await as('ncd@demo.local');
  await ncd.post(`/api/approvals/${sub.json.request.id}/approve`);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  const detail = await a.get(`/api/applications/${app.json.id}`);
  return { customerId: cid, appId: app.json.id, appNo: detail.json.application.application_no };
}

async function portalLogin(phone: string) {
  const c = new Client(ctx.base);
  await c.post('/api/portal/otp/request', { identifier: phone });
  const otp = (await ctx.db.query("SELECT payload FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1")).rows[0] as any;
  await c.post('/api/portal/otp/verify', { identifier: phone, otp: otp.payload.otp });
  return c;
}

describe('customer redemption request (portal)', () => {
  it('customer requests → appears in the staff queue → staff submits → CXO approves → app Redeemed', async () => {
    const inv = await activeInvestment('Redeem Portal', '9700000001');
    const cust = await portalLogin('9700000001');
    const reqR = await cust.post('/api/portal/redemption-request', { application_no: inv.appNo, reason: 'Need funds' });
    expect(reqR.status).toBe(201);
    expect(reqR.json.status).toBe('Requested');
    expect(Number(reqR.json.net_payment)).toBe(495000);

    // staff sees the request (not yet an approval)
    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/redemptions?filter=requests');
    const item = queue.json.rows.find((r: any) => r.application_no === inv.appNo);
    expect(item).toBeTruthy();
    expect(item.requested_by_customer).toBe(true);

    // staff submits → single CXO approval (old-app parity)
    const submit = await ncd.post(`/api/redemptions/${item.id}/submit-for-approval`);
    expect(submit.status).toBe(201);
    const reqId = submit.json.request.id;

    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/approvals/${reqId}/approve`)).json.request.status).toBe('Approved');

    const a = await admin();
    const detail = await a.get(`/api/applications/${inv.appId}`);
    expect(detail.json.application.status).toBe('Redeemed');
  });

  it('a customer cannot request redemption twice on the same investment', async () => {
    const inv = await activeInvestment('Double Redeem', '9700000002');
    const cust = await portalLogin('9700000002');
    expect((await cust.post('/api/portal/redemption-request', { application_no: inv.appNo, reason: 'x' })).status).toBe(201);
    expect((await cust.post('/api/portal/redemption-request', { application_no: inv.appNo, reason: 'y' })).status).toBe(409);
  });
});

describe('app redemption request (integration)', () => {
  const post = (body: unknown) => fetch(ctx.base + '/api/integration/redemption-request', {
    method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  it('rejects an unmatured NCD (premature needs in-person processing)', async () => {
    const inv = await activeInvestment('Redeem App Early', '9700000013');
    const r = await post({ customer_id: inv.customerId, application_no: inv.appNo, notes: 'App request' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('maturity date');
  });

  it('DhanamFin app requests a matured redemption → staff queue (wealth wire shape)', async () => {
    const inv = await activeInvestment('Redeem App', '9700000003');
    // Maturity reached — the wealth contract only accepts matured NCDs here.
    await ctx.db.query("UPDATE applications SET maturity_date = '2026-01-01' WHERE id = $1", [inv.appId]);
    await ctx.db.query("UPDATE application_lines SET maturity_date = '2026-01-01' WHERE application_id = $1", [inv.appId]);
    const r = await post({ customer_id: inv.customerId, application_no: inv.appNo, notes: 'App request' });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.reference_id).toMatch(/^LH-RDM-\d{4}-\d{6}$/);
    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/redemptions?filter=requests');
    expect(queue.json.rows.some((x: any) => x.application_no === inv.appNo && x.source === 'lockerhub')).toBe(true);
    // dedup: second request for the same application → 409 with the same ref
    const dup = await post({ customer_id: inv.customerId, application_no: inv.appNo, notes: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.json.reference_id).toBe(r.json.reference_id);
  });
});

describe('rollover / transfer / transformation', () => {
  it('rollover closes the old app and opens a fresh Active one with a schedule', async () => {
    const inv = await activeInvestment('Rollover Cust', '9700000004');
    const ncd = await as('ncd@demo.local');
    const roll = await ncd.post('/api/ncd-events/rollover', { application_id: inv.appId });
    expect(roll.status).toBe(201);
    const a = await admin();
    await a.post(`/api/approvals/${roll.json.request.id}/approve`);
    const old = await a.get(`/api/applications/${inv.appId}`);
    expect(old.json.application.status).toBe('RolledOver');
    // a new Active application exists for the same customer
    const newApp = (await ctx.db.query("SELECT id, status FROM applications WHERE customer_id = $1 AND source = 'rollover'", [inv.customerId])).rows[0] as any;
    expect(newApp.status).toBe('Active');
    const sched = await ctx.db.query('SELECT count(*)::int AS n FROM disbursement_schedule WHERE application_id = $1', [Number(newApp.id)]);
    expect(Number((sched.rows[0] as any).n)).toBeGreaterThan(0);
  });

  it('transfer moves ownership on a single-checker approval (old-app parity)', async () => {
    const inv = await activeInvestment('Transfer From', '9700000005');
    const to = await activeInvestment('Transfer To', '9700000006');
    const ncd = await as('ncd@demo.local'); // maker
    const t = await ncd.post('/api/ncd-events/transfer', { application_id: inv.appId, to_customer_id: to.customerId, reason: 'Gift' });
    const reqId = t.json.request.id;
    const superA = await admin(); // single checker (≠ maker ncd)
    expect((await superA.post(`/api/approvals/${reqId}/approve`)).json.request.status).toBe('Approved');
    const owner = (await ctx.db.query('SELECT customer_id FROM applications WHERE id = $1', [inv.appId])).rows[0] as any;
    expect(Number(owner.customer_id)).toBe(to.customerId);
  });

  it('transformation flags the deceased customer and reassigns to the nominee', async () => {
    const inv = await activeInvestment('Deceased Cust', '9700000007');
    const nominee = await activeInvestment('Nominee Cust', '9700000008');
    const ncd = await as('ncd@demo.local'); // maker
    const tr = await ncd.post('/api/ncd-events/transformation', { application_id: inv.appId, nominee_name: 'Nominee Cust', nominee_customer_id: nominee.customerId });
    const reqId = tr.json.request.id;
    const superA = await admin(); // single checker
    expect((await superA.post(`/api/approvals/${reqId}/approve`)).json.request.status).toBe('Approved');
    const dec = (await ctx.db.query('SELECT is_deceased FROM customers WHERE id = $1', [inv.customerId])).rows[0] as any;
    expect(dec.is_deceased).toBe(true);
    const owner = (await ctx.db.query('SELECT customer_id FROM applications WHERE id = $1', [inv.appId])).rows[0] as any;
    expect(Number(owner.customer_id)).toBe(nominee.customerId);
  });
});

describe('premature penalty waiver (CXO)', () => {
  it('CXO waives the penalty → net = principal; a non-CXO cannot, and it can only reduce', async () => {
    const inv = await activeInvestment('Waive Cust', '9333300001', 500000);
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/premature', { application_id: inv.appId, reason: 'hardship' });
    expect(init.status).toBe(201);
    const redId = init.json.redemption_id;
    expect(Number(init.json.penalty)).toBeGreaterThan(0);          // 1% of ₹5L = ₹5,000

    // Staff (no check-premature) cannot waive.
    expect((await ncd.post(`/api/redemptions/${redId}/waive-penalty`, { new_penalty: 0, reason: 'no' })).status).toBe(403);

    const cxo = await as('cxo@demo.local');
    // Cannot increase the penalty.
    expect((await cxo.post(`/api/redemptions/${redId}/waive-penalty`, { new_penalty: 999999, reason: 'nope' })).status).toBe(400);

    // Waive fully → penalty 0, net = principal.
    const w = await cxo.post(`/api/redemptions/${redId}/waive-penalty`, { new_penalty: 0, reason: 'genuine hardship' });
    expect(w.status).toBe(200);
    expect(Number(w.json.penalty)).toBe(0);
    expect(Number(w.json.net_payment)).toBe(500000);
    const row = (await ctx.db.query('SELECT penalty, net_payment, penalty_original FROM redemptions WHERE id = $1', [redId])).rows[0] as any;
    expect(Number(row.penalty)).toBe(0);
    expect(Number(row.net_payment)).toBe(500000);
    expect(Number(row.penalty_original)).toBe(5000);

    // Approve → app Redeemed at the waived net.
    expect((await cxo.post(`/api/approvals/${init.json.request.id}/approve`)).json.request.status).toBe('Approved');
  });
});
