/**
 * The STANDARD rent waiver (owner 2026-08-20, re-confirmed 2026-08-25) — one
 * click, NO checker, straight to LockerHub.
 *
 * This exists because the checker has been added and removed once already:
 * PR #333 routed this through Admin/CXO and REQ-2026-000367 then sat in the
 * queue waiting for someone to rubber-stamp a number nobody chose. The waiver
 * is a pure function of the size's gst_pct and rent, so there is no discretion
 * to check.
 *
 * The two tests at the bottom are the CONTROL: the discretionary "Waive…"
 * button and the premium (100%) write-off DO carry discretion and must keep
 * their checker. If someone re-adds a checker to the standard path, the first
 * test fails; if someone removes it from the other two, the controls fail.
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
      if (/\/waiver$/.test(url.pathname) && req.method === 'POST') return send(200, { success: true, leg: body.leg });
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

// A medium locker: 6,000 pre-tax + 18% GST. After the waiver the customer's
// whole GST-inclusive bill must be the round 6,000.
const M = { gst_pct: 18, annual_rent: 6000 };

describe('standard rent waiver — no checker', () => {
  it('applies at once: no approval request, straight to LockerHub', async () => {
    const appId = 'la_stdrent_1';
    seen = [];
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/apply-rent-waiver`, M);
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(true);
    expect(r.json.already).toBeUndefined();
    // It reached them on the request itself — this is the whole point.
    expect(waiverCalls()).toHaveLength(1);

    const row = (await ctx.db.query(
      "SELECT id, status, waiver_amount, waiver_pct, approval_request_id, lockerhub_applied_at FROM locker_fee_waivers WHERE lockerhub_application_id = $1 AND leg = 'rent'", [appId])).rows[0] as any;
    expect(row.status).toBe('Approved');          // approved on creation
    expect(row.approval_request_id).toBeNull();   // nobody was asked
    expect(row.lockerhub_applied_at).toBeTruthy();

    // And no approval landed in the queue for it — the regression owner hit.
    const q = await ctx.db.query(
      "SELECT 1 FROM approval_requests WHERE entity_type = 'locker_fee_waivers' AND entity_id = $1", [row.id]);
    expect(q.rows).toHaveLength(0);
  });

  it('sends the exact AMOUNT, so the bill lands on the round 6,000', async () => {
    // 6000 - 6000/1.18 = 915.25 off the pre-tax base; LockerHub re-adds GST on
    // 5,084.75 and bills 6,000. A percentage would round to 15.25% and bill over.
    expect(waiverCalls()[0]!.body).toMatchObject({ leg: 'rent', waiver_amount: 915.25 });
    expect(waiverCalls()[0]!.body.waiver_pct).toBeUndefined();
    const row = (await ctx.db.query(
      "SELECT waiver_amount, waiver_pct FROM locker_fee_waivers WHERE lockerhub_application_id = 'la_stdrent_1' AND leg = 'rent'")).rows[0] as any;
    expect(Number(row.waiver_amount)).toBe(915.25);
    expect(row.waiver_pct).toBeNull();
  });

  it('a second click is a no-op, not a second write-off', async () => {
    seen = [];
    const again = await (await manager()).post('/api/lockers/applications/la_stdrent_1/apply-rent-waiver', M);
    expect(again.status).toBe(200);
    expect(again.json.already).toBe(true);
    expect(waiverCalls()).toHaveLength(0);   // nothing sent twice
  });

  it('still needs lockers:waive — branch staff cannot', async () => {
    const r = await (await as('staff@demo.local')).post('/api/lockers/applications/la_stdrent_2/apply-rent-waiver', M);
    expect(r.status).toBe(403);
  });

  // ── CONTROLS: the discretionary paths keep their checker ──────────────────
  it('CONTROL: the discretionary "Waive…" still goes to Admin/CXO', async () => {
    const appId = 'la_stdrent_3';
    seen = [];
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/fee-waivers`,
      { leg: 'rent', waiver_pct: 50, reason: 'goodwill, agreed with the branch' });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
    expect(waiverCalls()).toHaveLength(0);   // nothing reaches them un-approved
    const row = (await ctx.db.query(
      "SELECT status, approval_request_id FROM locker_fee_waivers WHERE lockerhub_application_id = $1 AND leg = 'rent'", [appId])).rows[0] as any;
    expect(row.status).toBe('PendingApproval');
    expect(row.approval_request_id).not.toBeNull();
  });

  it('CONTROL: premium (100% write-off) still goes to Admin/CXO', async () => {
    const appId = 'la_stdrent_4';
    seen = [];
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/premium-rent`, {});
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('PendingApproval');
    expect(waiverCalls()).toHaveLength(0);
  });
});
