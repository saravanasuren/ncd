/**
 * §A20 — allotting a locker with rent or deposit still outstanding.
 *
 * The obligations gate is the RIGHT default and stays: a tenancy is normally
 * never created against unpaid money. This is the deliberate, attributed way
 * past it, for the case where the business has knowingly accepted the risk.
 *
 * Two things make it safe, and both are pinned here.
 *
 *   1. It is SENIOR-ONLY. LockerHub asked us to gate it, and there is no
 *      second approver on the action itself — so it sits with the people who
 *      APPROVE a waiver (admin / CXO), never with the NCD Manager who merely
 *      requests one. Letting the maker role hand a locker over for the same
 *      money would be the weaker control for the identical outcome.
 *   2. It is ATTRIBUTED. Both fields are mandatory, and we write our own audit
 *      entry as well as theirs: their log answers "an override happened", ours
 *      answers "who at NCD decided it".
 *
 * A plain allocate must never carry an override by accident, so the absence of
 * one is asserted too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];
/** Refuse like LockerHub does when money is outstanding and no override came. */
let unpaid = false;

const APP = 'la_override';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/allocate$/.test(url.pathname) && req.method === 'POST') {
        if (unpaid && !body.override) {
          return send(409, { error: 'obligations pending', code: 'obligations_pending', missing: ['rent'] });
        }
        return send(200, { success: true, tenant_id: 't_ov', locker_number: 'L1-1', lease_start: '2026-07-31', lease_end: '2027-07-30' });
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
const OVERRIDE = { reason: 'Deposit waived by CXO, ref WVR-2026-014', approved_by: 'A Senior Person' };
const allocCalls = () => seen.filter((s) => /\/allocate$/.test(s.path));

describe('the obligations gate still stands', () => {
  it('a plain allocate carries no override, and their 409 comes straight through', async () => {
    unpaid = true; seen = [];
    try {
      const r = await (await admin()).post(`/api/lockers/applications/${APP}/allocate`, {});
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.json)).toMatch(/obligations_pending/);
      expect(allocCalls()[0]!.body.override).toBeUndefined();   // never by accident
    } finally { unpaid = false; }
  });
});

describe('who may override', () => {
  // Owner 2026-08-22 opened this up — ANY enrolling staff can allot regardless
  // of the rent clearance, so the senior-only gate is gone.
  it('an NCD Manager can now — any enrolling staff may allot regardless', async () => {
    seen = [];
    const r = await (await as('ncd@demo.local')).post(`/api/lockers/applications/${APP}/allocate`, { override: OVERRIDE });
    expect(r.status).toBe(200);
    expect(allocCalls()[0]!.body.override).toMatchObject(OVERRIDE);
  });

  it('branch staff can now too', async () => {
    seen = [];
    const r = await (await as('staff@demo.local')).post(`/api/lockers/applications/${APP}/allocate`, { override: OVERRIDE });
    expect(r.status).toBe(200);
    expect(allocCalls()[0]!.body.override).toMatchObject(OVERRIDE);
  });

  it('an admin can, and it gets through the unpaid gate', async () => {
    unpaid = true; seen = [];
    try {
      const r = await (await admin()).post(`/api/lockers/applications/${APP}/allocate`, { override: OVERRIDE });
      expect(r.status).toBe(200);
      expect(r.json.locker_number).toBe('L1-1');
      expect(allocCalls()[0]!.body.override).toMatchObject(OVERRIDE);
    } finally { unpaid = false; }
  });

  it('the same people who can override still allot normally', async () => {
    seen = [];
    const r = await (await as('staff@demo.local')).post(`/api/lockers/applications/${APP}/allocate`, {});
    expect(r.status).toBe(200);                  // no override, no restriction
  });
});

describe('it must be attributable', () => {
  it('refuses a blank reason', async () => {
    seen = [];
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/allocate`, {
      override: { reason: '', approved_by: 'A Senior Person' },
    });
    expect(r.status).toBe(400);
    expect(allocCalls()).toHaveLength(0);
  });

  it('refuses a missing authoriser', async () => {
    seen = [];
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/allocate`, {
      override: { reason: 'Because I said so' },
    });
    expect(r.status).toBe(400);
    expect(allocCalls()).toHaveLength(0);
  });

  it('writes OUR audit entry too — their log says an override happened, ours says who decided', async () => {
    seen = [];
    await (await admin()).post(`/api/lockers/applications/${APP}/allocate`, { override: OVERRIDE });
    const row = (await ctx.db.query(
      `SELECT actor_id, after_data FROM audit_log
        WHERE action = 'locker.allot.override' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [APP])).rows[0] as any;
    expect(row).toBeTruthy();
    expect(Number(row.actor_id)).toBeGreaterThan(0);
    expect(row.after_data.reason).toBe(OVERRIDE.reason);
    expect(row.after_data.approved_by).toBe(OVERRIDE.approved_by);
  });

  it('records the override for any enroller now (owner 2026-08-22)', async () => {
    const before = (await ctx.db.query(
      "SELECT count(*)::int n FROM audit_log WHERE action = 'locker.allot.override'")).rows[0] as any;
    await (await as('staff@demo.local')).post(`/api/lockers/applications/${APP}/allocate`, { override: OVERRIDE });
    const after = (await ctx.db.query(
      "SELECT count(*)::int n FROM audit_log WHERE action = 'locker.allot.override'")).rows[0] as any;
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });
});
