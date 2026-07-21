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
      const rec = p.match(/^\/locker-applications\/(.+)\/record-payment$/);
      if (rec && req.method === 'POST') {
        const id = rec[1]!; (paidLegs[id] ??= new Set()).add(body.leg);
        const approved = paidLegs[id]!.has('rent') && paidLegs[id]!.has('deposit');
        return send(200, { success: true, intent_no: 'LOCK-' + body.leg, leg: body.leg, amount: body.leg === 'rent' ? 3540 : 25000, application_status: approved ? 'approved' : 'payment_pending' });
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

  it('cash flow: create customer → application → rent + deposit → auto-allotted', async () => {
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

    const rent = await staff.post(`/api/lockers/applications/${id}/record-payment`, { leg: 'rent', method: 'cash' });
    expect(rent.json.application_status).toBe('payment_pending');
    const dep = await staff.post(`/api/lockers/applications/${id}/record-payment`, { leg: 'deposit', method: 'cash' });
    expect(dep.json.application_status).toBe('approved'); // auto-allotted on the last leg
  });
});
