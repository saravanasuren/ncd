/**
 * §A21 fee waivers — waiving rent or deposit OWED on a locker application.
 *
 * The control that matters: LockerHub applies our call **approved-on-arrival**.
 * They do not second-guess it and they attribute it to the approver we name, so
 * OUR checker is the only thing standing between a maker and a written-off fee.
 * Nothing may reach them on the maker's request alone — that is the first and
 * most important assertion here.
 *
 * The second: an approval is an internal decision and must survive LockerHub
 * being unreachable. A refused apply leaves the waiver Approved with the error
 * kept and retryable, never rolled back — but also never silently counted as
 * applied, because a waiver that is not in force means the customer still owes
 * the money.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];
let waiverFails = false;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/waiver$/.test(url.pathname) && req.method === 'POST') {
        if (waiverFails) return send(503, { error: 'upstream unavailable' });
        return send(200, { success: true, leg: body.leg, leg_settled: Number(body.waiver_pct) === 100 });
      }
      return send(404, { error: 'not found: ' + url.pathname });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const manager = () => as('ncd@demo.local');

let n = 0;
const nextApp = () => `la_waiver_${++n}`;
const waiverCalls = () => seen.filter((s) => /\/waiver$/.test(s.path));

async function request(appId: string, body: Record<string, unknown> = {}) {
  const m = await manager();
  return m.post(`/api/lockers/applications/${appId}/fee-waivers`, {
    leg: 'rent', waiver_pct: 100, reason: 'Relationship waiver', ...body,
  });
}

describe('nothing reaches LockerHub before a checker approves', () => {
  it('requesting a waiver calls nobody', async () => {
    seen = [];
    const r = await request(nextApp());
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
    expect(waiverCalls()).toHaveLength(0);       // the whole control
  });

  it('approving it is what sends it, naming the APPROVER not the maker', async () => {
    const appId = nextApp();
    const req = await request(appId, { reason: 'CXO approved goodwill' });
    seen = [];
    const ok = await (await admin()).post(`/api/approvals/${req.json.request_id}/approve`);
    expect(ok.status).toBe(200);

    const call = waiverCalls()[0]!;
    expect(call.body).toMatchObject({ leg: 'rent', waiver_pct: 100, reason: 'CXO approved goodwill' });
    // approved_by is the basis on which they accept it without re-checking.
    expect(call.body.approved_by).toBe('System Administrator');
    expect(call.body.staff?.name).toBe('System Administrator');
  });

  it('rejecting it sends nothing and closes the waiver', async () => {
    const appId = nextApp();
    const req = await request(appId);
    seen = [];
    const r = await (await admin()).post(`/api/approvals/${req.json.request_id}/reject`, { reason: 'Not justified' });
    expect(r.status).toBe(200);
    expect(waiverCalls()).toHaveLength(0);
    const row = (await ctx.db.query('SELECT status FROM locker_fee_waivers WHERE id = $1', [req.json.id])).rows[0] as any;
    expect(row.status).toBe('Rejected');
  });

  it('a maker cannot approve their own waiver', async () => {
    const req = await request(nextApp());
    seen = [];
    const r = await (await manager()).post(`/api/approvals/${req.json.request_id}/approve`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(waiverCalls()).toHaveLength(0);
  });
});

describe('what a waiver may say', () => {
  it('refuses a percentage AND an amount together', async () => {
    const r = await request(nextApp(), { waiver_pct: 50, waiver_amount: 5000 });
    expect(r.status).toBe(400);
  });

  it('refuses neither', async () => {
    const r = await request(nextApp(), { waiver_pct: null, waiver_amount: null });
    expect(r.status).toBe(400);
  });

  it('refuses more than 100%', async () => {
    expect((await request(nextApp(), { waiver_pct: 120 })).status).toBe(400);
  });

  it('refuses a waiver with no reason', async () => {
    expect((await request(nextApp(), { reason: '' })).status).toBe(400);
  });

  it('an amount waiver is sent as an amount, never as a percentage', async () => {
    const appId = nextApp();
    const req = await request(appId, { waiver_pct: null, waiver_amount: 5000 });
    seen = [];
    await (await admin()).post(`/api/approvals/${req.json.request_id}/approve`);
    const body = waiverCalls()[0]!.body;
    expect(body.waiver_amount).toBe(5000);
    expect(body.waiver_pct).toBeUndefined();
  });

  it('refuses a second open waiver on the same leg — two reductions of one fee', async () => {
    const appId = nextApp();
    expect((await request(appId)).status).toBe(201);
    expect((await request(appId)).status).toBe(409);
    // The other leg is untouched.
    expect((await request(appId, { leg: 'deposit' })).status).toBe(201);
  });
});

describe('an approval survives LockerHub being unreachable', () => {
  it('stays Approved, records why, and does not pretend it is in force', async () => {
    const appId = nextApp();
    const req = await request(appId);
    waiverFails = true;
    try {
      const r = await (await admin()).post(`/api/approvals/${req.json.request_id}/approve`);
      expect(r.status).toBe(200);                 // the approval itself stands
    } finally { waiverFails = false; }

    const row = (await ctx.db.query(
      'SELECT status, lockerhub_applied_at, lockerhub_error FROM locker_fee_waivers WHERE id = $1', [req.json.id])).rows[0] as any;
    expect(row.status).toBe('Approved');
    expect(row.lockerhub_applied_at).toBeNull();  // NOT in force
    expect(row.lockerhub_error).toBeTruthy();
  });

  it('retrying applies it and clears the error', async () => {
    const appId = nextApp();
    const req = await request(appId);
    waiverFails = true;
    try { await (await admin()).post(`/api/approvals/${req.json.request_id}/approve`); }
    finally { waiverFails = false; }

    const r = await (await manager()).post(`/api/lockers/fee-waivers/${req.json.id}/retry`, {});
    expect(r.json.applied).toBe(true);
    const row = (await ctx.db.query(
      'SELECT lockerhub_applied_at, lockerhub_error FROM locker_fee_waivers WHERE id = $1', [req.json.id])).rows[0] as any;
    expect(row.lockerhub_applied_at).toBeTruthy();
    expect(row.lockerhub_error).toBeNull();
  });

  it('a waiver still awaiting approval cannot be pushed through by retrying', async () => {
    const req = await request(nextApp());
    seen = [];
    const r = await (await manager()).post(`/api/lockers/fee-waivers/${req.json.id}/retry`, {});
    expect(r.status).toBe(409);
    expect(waiverCalls()).toHaveLength(0);        // the control holds here too
  });

  it('retrying an already-applied waiver calls nobody', async () => {
    const appId = nextApp();
    const req = await request(appId);
    await (await admin()).post(`/api/approvals/${req.json.request_id}/approve`);
    seen = [];
    const r = await (await manager()).post(`/api/lockers/fee-waivers/${req.json.id}/retry`, {});
    expect(r.json.applied).toBe(true);
    expect(waiverCalls()).toHaveLength(0);
  });
});

describe('who may ask', () => {
  it('branch staff CAN request a waiver — it still goes to Admin/CXO to grant (owner 2026-08-29)', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.post(`/api/lockers/applications/${nextApp()}/fee-waivers`, {
      leg: 'rent', waiver_pct: 100, reason: 'Branch requested',
    });
    // Maker-only: the request is raised (201, PendingApproval) but nothing is
    // waived until an Admin/CXO approves it — the two-person control is intact.
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
  });

  it('the enrolment screen can read the waivers on an application', async () => {
    const appId = nextApp();
    await request(appId, { reason: 'Visible on screen' });
    const r = await (await as('staff@demo.local')).get(`/api/lockers/applications/${appId}/fee-waivers`);
    expect(r.status).toBe(200);
    expect(r.json.rows[0]).toMatchObject({ leg: 'rent', status: 'PendingApproval' });
  });
});
