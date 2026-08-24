/**
 * Premium customer — rent made complimentary (owner 2026-08-22). One click, no
 * checker (like the standard rent waiver), applied to LockerHub as a 100% A21
 * waiver — but recorded as category 'premium', NOT a waiver, so the rent report
 * keeps a premium customer distinct from an ordinary waiver.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/waiver$/.test(url.pathname) && req.method === 'POST') return send(200, { success: true, leg: body.leg, leg_settled: Number(body.waiver_pct) === 100 });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const manager = () => as('ncd@demo.local');
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const waiverCalls = () => seen.filter((s) => /\/waiver$/.test(s.path));

describe('premium customer — complimentary rent', () => {
  it('goes to Admin/CXO for approval — nothing reaches LockerHub until approved', async () => {
    const appId = 'la_premium_1';
    seen = [];
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/premium-rent`, {});
    expect(r.status).toBe(200);
    expect(r.json.category).toBe('premium');
    expect(r.json.status).toBe('PendingApproval');
    expect(waiverCalls()).toHaveLength(0);   // the control — nothing sent yet

    // Recorded PendingApproval, tagged premium, not yet in force.
    const row = (await ctx.db.query(
      "SELECT id, category, status, waiver_pct, lockerhub_applied_at, approval_request_id FROM locker_fee_waivers WHERE lockerhub_application_id = $1 AND leg = 'rent'", [appId])).rows[0] as any;
    expect(row.category).toBe('premium');
    expect(row.status).toBe('PendingApproval');
    expect(row.lockerhub_applied_at).toBeNull();

    // An Admin approves → the 100% waiver reaches LockerHub and it goes in force.
    const reqId = (await ctx.db.query('SELECT id FROM approval_requests WHERE id = $1', [row.approval_request_id])).rows[0] as any;
    const ok = await (await admin()).post(`/api/approvals/${reqId.id}/approve`);
    expect(ok.status).toBe(200);
    expect(waiverCalls()[0]!.body).toMatchObject({ leg: 'rent', waiver_pct: 100 });
    const after = (await ctx.db.query("SELECT status, lockerhub_applied_at FROM locker_fee_waivers WHERE id = $1", [row.id])).rows[0] as any;
    expect(after.status).toBe('Approved');
    expect(after.lockerhub_applied_at).toBeTruthy();
  });

  it('the enrolment screen sees the premium category on the waiver list', async () => {
    const list = await (await as('staff@demo.local')).get('/api/lockers/applications/la_premium_1/fee-waivers');
    expect(list.status).toBe(200);
    expect(list.json.rows[0]).toMatchObject({ leg: 'rent', category: 'premium' });
  });

  it('refuses a second rent write-off — premium and a waiver never stack', async () => {
    const appId = 'la_premium_2';
    expect((await (await manager()).post(`/api/lockers/applications/${appId}/premium-rent`, {})).status).toBe(200);
    // A discretionary waiver on the same leg is now refused (one rent waiver only).
    const dup = await (await manager()).post(`/api/lockers/applications/${appId}/fee-waivers`, { leg: 'rent', waiver_pct: 100, reason: 'trying to stack' });
    expect(dup.status).toBe(409);
    // And a repeat premium is a no-op, not a duplicate.
    const again = await (await manager()).post(`/api/lockers/applications/${appId}/premium-rent`, {});
    expect(again.json.already).toBe(true);
  });

  it('branch staff cannot make a customer premium — needs lockers:waive', async () => {
    const r = await (await as('staff@demo.local')).post('/api/lockers/applications/la_premium_3/premium-rent', {});
    expect(r.status).toBe(403);
  });
});
