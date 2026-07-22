/**
 * Locker enrollment (NCD_INTEGRATION_CONTRACT.md Part A) — the first-party
 * /api/lockers/* routes proxy to LockerHub via the outbound client, injecting
 * the acting staff. Here LockerHub is a local mock so we can assert the proxy,
 * staff injection, the permission gate, the cash flow, and the disabled path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let mockUrl = '';
let seen: Array<{ method: string; path: string; body: any; key: string | undefined }> = [];

async function login(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }

beforeAll(async () => {
  ctx = await startTestServer();

  // Minimal stateful LockerHub mock (A1–A11 subset the flow exercises).
  const paidLegs: Record<string, Set<string>> = {};
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: url.pathname, body, key: req.headers['x-integration-key'] as string });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = url.pathname;
      if (p === '/ping') return send(200, { ok: true, service: 'lockerhub', time: 't' });
      if (p === '/branches') return send(200, { branches: [{ id: 'br_1', name: 'HO', address: 'A' }] });
      if (p === '/locker-availability') return send(200, { branch_id: url.searchParams.get('branch_id'), sizes: [{ size: 'Medium', annual_fee: 3000, rent_incl_gst: 3540, deposit: 25000, gst_pct: 18, vacant_count: 12 }] });
      if (p === '/customers/9800011122') return send(200, { found: false });
      if (p === '/customers' && req.method === 'POST') return send(200, { success: true, phone: body.phone, created: true });
      if (p === '/locker-applications' && req.method === 'POST') return send(201, { success: true, application_id: 'la_1', application_no: 'APP-L-1', status: 'payment_pending', pricing: { locker_size: 'Medium', annual_fee: 3000, rent_incl_gst: 3540, deposit: 25000, gst_pct: 18 } });
      // GET a locker application — the deposit leg amount is LockerHub's own
      // figure, which is what a link pledges (staff never type it).
      const get = p.match(/^\/locker-applications\/([^/]+)$/);
      if (get && req.method === 'GET') {
        const size = get[1].startsWith('la_xl') ? 'XL' : 'Medium';
        const deposit = get[1].startsWith('la_xl') ? 300000 : 100000;
        return send(200, {
          application_id: get[1], application_no: 'APP-L-' + get[1], status: 'payment_pending', locker_size: size,
          legs: { rent: { amount: 3540, settled: false }, deposit: { amount: deposit, settled: false } },
          allotment: { locker_number: 'L10-4' },
        });
      }
      // A12 link-ncd — deposit settled as NCD-backed, never a payment row.
      const ln = p.match(/^\/locker-applications\/(.+)\/link-ncd$/);
      if (ln && req.method === 'POST') {
        const id = ln[1]!; (paidLegs[id] ??= new Set()).add('deposit');
        return send(200, { success: true, ncd_id: body.ncd_id, leg: 'deposit', settled_as: 'ncd_backed',
          application_status: paidLegs[id]!.has('rent') ? 'approved' : 'payment_pending' });
      }
      // A10 is RETIRED upstream — 400 online_only for every caller.
      if (/^\/locker-applications\/(.+)\/record-payment$/.test(p) && req.method === 'POST') {
        return send(400, { error: 'Lockers and NCD are online-only.', code: 'online_only' });
      }
      // A9 payment-link — online collection; settlement lands via Easebuzz.
      const pl = p.match(/^\/locker-applications\/(.+)\/payment-link$/);
      if (pl && req.method === 'POST') {
        const id = pl[1]!; (paidLegs[id] ??= new Set()).add(body.leg); // simulate immediate settlement
        return send(200, { success: true, leg: body.leg, amount: body.leg === 'rent' ? 3540 : 25000,
          checkout_url: 'https://pay.easebuzz.in/pay/' + id + '-' + body.leg, intent_no: 'LOCK-' + body.leg });
      }
      return send(404, { error: 'not found: ' + p });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  config.LOCKERHUB_API_URL = mockUrl;
});
afterAll(async () => {
  config.LOCKERHUB_API_URL = undefined;
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

describe('locker enrollment proxy (Part A)', () => {
  it('503 when LockerHub is not configured', async () => {
    config.LOCKERHUB_API_URL = undefined;
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const r = await staff.get('/api/lockers/ping');
    expect(r.status).toBe(503);
    config.LOCKERHUB_API_URL = mockUrl;
  });

  it('an agent (no lockers:enroll) is 403', async () => {
    const agent = await login('agent@demo.local');
    const r = await agent.get('/api/lockers/branches');
    expect(r.status).toBe(403);
  });

  it('ping + branches proxy through with the integration key', async () => {
    seen = [];
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    expect((await staff.get('/api/lockers/ping')).json.ok).toBe(true);
    const br = await staff.get('/api/lockers/branches');
    expect(br.json.branches[0].id).toBe('br_1');
    expect(seen.every((s) => s.key === config.LOCKERHUB_INTEGRATION_KEY)).toBe(true);
  });

  it('online flow: create customer → application → payment link per leg', async () => {
    seen = [];
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');

    const cust = await staff.post('/api/lockers/customers', { phone: '9800011122', name: 'Locker Cust' });
    expect(cust.json.success).toBe(true);
    // staff injected from the session, not the client
    const custCall = seen.find((s) => s.path === '/customers' && s.method === 'POST')!;
    expect(custCall.body.staff).toBeTruthy();
    expect(String(custCall.body.staff.name)).toBeTruthy();

    const app = await staff.post('/api/lockers/applications', { phone: '9800011122', branch_id: 'br_1', locker_size: 'Medium' });
    expect(app.status).toBe(201);
    const id = app.json.application_id;

    // Online-only: staff generate a payment link per leg (A9). Cash is gone.
    const rent = await staff.post(`/api/lockers/applications/${id}/payment-link`, { leg: 'rent' });
    expect(rent.status).toBe(200);
    expect(rent.json.checkout_url).toMatch(/^https:\/\/pay\.easebuzz\.in\//);
    expect(rent.json.amount).toBe(3540);
    const dep = await staff.post(`/api/lockers/applications/${id}/payment-link`, { leg: 'deposit' });
    expect(dep.json.checkout_url).toBeTruthy();

    // The retired cash route is no longer proxied at all.
    const cash = await staff.post(`/api/lockers/applications/${id}/record-payment`, { leg: 'rent', method: 'cash' });
    expect(cash.status).toBe(404);
  });
});

// Owner spec 2026-07-22: an NCD investment backs a locker's deposit. The
// investment is NEVER split — the link is a claim against it.
describe('locker deposit links (NCD backs the deposit)', () => {
  const seriesId = () => ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'").then((r: any) => Number(r.rows[0].id));
  const schemeId = () => ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'").then((r: any) => Number(r.rows[0].id));

  async function liveInvestment(staff: Client, amount: number, phone: string) {
    const cust = await staff.post('/api/customers', { full_name: 'Locker Cust ' + phone, phone });
    const app = await staff.post('/api/applications', {
      customer_id: cust.json.id, series_id: await seriesId(), scheme_id: await schemeId(), amount, date_money_received: '2026-07-01',
    });
    const ncd = await login('ncd@demo.local');
    await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`); // go-live
    return Number(app.json.id);
  }

  it('₹25L investment backing a ₹3L XL locker: one investment, ₹3L pledged, ₹22L redeemable', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const appId = await liveInvestment(staff, 2500000, '9899111001');

    seen = [];
    const link = await staff.post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'la_xl' });
    expect(link.status).toBe(201);
    expect(link.json.linked_amount).toBe(300000);       // LockerHub's figure, not typed
    expect(link.json.lockerhub_settled).toBe(true);      // deposit leg settled as NCD-backed

    // A12: the deposit leg settles via link-ncd carrying our application_no as
    // ncd_id — NEVER via record-payment (LockerHub retired it in their #709; a
    // synthetic payment row broke their reconciliation and refund flow).
    const a12 = seen.find((x) => x.path.endsWith('/link-ncd'))!;
    expect(a12).toBeTruthy();
    expect(a12.body.ncd_id).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(a12.body.staff).toBeTruthy();
    expect(a12.body.method).toBeUndefined();
    expect(a12.body.reference).toBeUndefined();
    expect(seen.some((x) => x.path.endsWith('/record-payment'))).toBe(false);

    // LockerHub's queue is the single writer of the pledge flag — we must not
    // set it ourselves, or the two writers race.
    const flag = await ctx.db.query('SELECT is_locker_deposit FROM applications WHERE id = $1', [appId]);
    expect((flag.rows[0] as any).is_locker_deposit).toBe(false);

    const detail = await staff.get(`/api/applications/${appId}`);
    expect(detail.json.locker.outstanding).toBe(2500000);
    expect(detail.json.locker.linked_to_lockers).toBe(300000);
    expect(detail.json.locker.free_ncd).toBe(2200000);
    expect(detail.json.locker.redeemable).toBe(2200000);
    expect(detail.json.locker.links).toHaveLength(1);
  });

  it('refuses to pledge more than the investment has free', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const appId = await liveInvestment(staff, 100000, '9899111002'); // ₹1L only
    const r = await staff.post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'la_xl' }); // needs ₹3L
    expect(r.status).toBe(422);
  });

  it('redeems only the free ₹22L and keeps the ₹3L locker pledge live', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const cxo = await login('cxo@demo.local');
    const appId = await liveInvestment(staff, 2500000, '9899111004');
    const pledge = await staff.post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'la_xl2' });
    expect(pledge.status).toBe(201);
    expect(pledge.json.linked_amount).toBe(300000); // ₹3L pledged

    // More than the free portion is refused.
    const tooMuch = await staff.post('/api/redemptions/premature', { application_id: appId, reason: 'test', amount: 2300000 });
    expect(tooMuch.status).toBe(422);

    // Exactly the free ₹22L is allowed.
    const red = await staff.post('/api/redemptions/premature', { application_id: appId, reason: 'partial exit', amount: 2200000 });
    expect(red.status).toBe(201);
    expect(Number(red.json.principal)).toBe(2200000);

    // Premature redemption is a single CXO check.
    const ok = await cxo.post(`/api/approvals/${red.json.request.id}/approve`);
    expect(ok.status).toBe(200);

    // The investment STAYS live with the pledged ₹3L.
    const after = await staff.get(`/api/applications/${appId}`);
    expect(after.json.application.status).toBe('Active');
    expect(after.json.locker.outstanding).toBe(300000);
    expect(after.json.locker.linked_to_lockers).toBe(300000);
    expect(after.json.locker.redeemable).toBe(0);
  });

  it('a fully-pledged investment cannot be redeemed until the link is released', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const appId = await liveInvestment(staff, 100000, '9899111003'); // ₹1L = Medium deposit exactly
    const link = await staff.post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'la_med' });
    expect(link.json.linked_amount).toBe(100000);

    const blocked = await staff.post('/api/redemptions/premature', { application_id: appId, reason: 'test' });
    expect(blocked.status).toBe(422);

    // Locker closed → release frees it.
    const rel = await staff.post(`/api/lockers/deposit-links/${link.json.link_id}/release`, { reason: 'locker closed' });
    expect(rel.status).toBe(200);
    const after = await staff.get(`/api/applications/${appId}`);
    expect(after.json.locker.linked_to_lockers).toBe(0);
    expect(after.json.locker.redeemable).toBe(100000);
  });

  // A12 inbound: LockerHub calls us (durable-queued, retried) the moment a
  // deposit refund settles at locker closure. This is what closes the release
  // gap end-to-end — staff no longer have to remember to unpledge.
  it('A12 release-locker discharges the pledge and is idempotent on re-delivery', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const appId = await liveInvestment(staff, 500000, '9899111005');
    const link = await staff.post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'la_med2' });
    expect(link.status).toBe(201);
    const appNo = (await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [appId])).rows[0] as any;
    const ncdId = String(appNo.application_no);
    const integ = (path: string, body: unknown) => fetch(ctx.base + path, {
      method: 'POST', headers: { 'X-Integration-Key': config.LOCKERHUB_INTEGRATION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as any }));

    // Pledged → not redeemable.
    expect((await staff.get(`/api/applications/${appId}`)).json.locker.redeemable).toBe(400000);

    const rel = await integ(`/api/integration/ncd/${ncdId}/release-locker`, {
      deposit_reference: 'la_med2', refund_no: 'RFND-77', released_at: '2026-07-22T10:00:00Z', reason: 'locker closed',
    });
    expect(rel.status).toBe(200);
    expect(rel.json).toMatchObject({ success: true, released: true, released_amount: 100000, is_locker_deposit: false });

    // The whole investment is redeemable again.
    const after = await staff.get(`/api/applications/${appId}`);
    expect(after.json.locker.linked_to_lockers).toBe(0);
    expect(after.json.locker.redeemable).toBe(500000);

    // Re-delivery of the same refund → idempotent no-op success, not a 500.
    const again = await integ(`/api/integration/ncd/${ncdId}/release-locker`, { deposit_reference: 'la_med2', refund_no: 'RFND-77' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ success: true, released: false, already_released: true });

    // Missing reference → 400; unknown NCD → 404.
    expect((await integ(`/api/integration/ncd/${ncdId}/release-locker`, {})).status).toBe(400);
    expect((await integ('/api/integration/ncd/APP-2999-000999/release-locker', { deposit_reference: 'x' })).status).toBe(404);
  });
});
