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
const waiverCalls = () => seen.filter((s) => /\/waiver$/.test(s.path));

describe('premium customer — complimentary rent', () => {
  it('zeroes the rent immediately (no checker) and records it as premium', async () => {
    const appId = 'la_premium_1';
    seen = [];
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/premium-rent`, {});
    expect(r.status).toBe(200);
    expect(r.json.category).toBe('premium');
    expect(r.json.applied).toBe(true);

    // Applied straight to LockerHub as a 100% waiver — no approval round-trip.
    const call = waiverCalls()[0]!;
    expect(call.body).toMatchObject({ leg: 'rent', waiver_pct: 100 });

    // Stored Approved-on-creation, in force, and tagged premium.
    const row = (await ctx.db.query(
      "SELECT category, status, waiver_pct, lockerhub_applied_at FROM locker_fee_waivers WHERE lockerhub_application_id = $1 AND leg = 'rent'", [appId])).rows[0] as any;
    expect(row.category).toBe('premium');
    expect(row.status).toBe('Approved');
    expect(Number(row.waiver_pct)).toBe(100);
    expect(row.lockerhub_applied_at).toBeTruthy();
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
