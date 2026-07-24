/**
 * Locker branch scoping for branch_staff (owner 2026-07-24): "only those
 * staffs who are assigned to those specific branch gets to look only that
 * particular branch portfolio." branch_manager is deliberately NOT restricted
 * (owner declined extending it) — every role that can reach /api/lockers/*
 * except branch_staff sees every branch, as before.
 *
 * A local mock LockerHub (same pattern as integration.locker-enrollment.test.ts)
 * so the restricted:true path runs for real, over real HTTP, rather than being
 * dead code no test can reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { matchBranchesByName } from '../src/modules/lockers/branchScope.js';
import { config } from '../src/config.js';

// ── Pure matcher: no DB, no network, no server needed ──────────────────────
const LIVE_LOCKERHUB_BRANCHES = [
  { id: 'br_erode_2', name: 'Erode' },
  { id: 'br_salem', name: 'Salem' },
  { id: 'br_ganapathy', name: 'Ganapathy' }, // NCD has no branch by this name
];

describe('matchBranchesByName — pure', () => {
  it('matches case- and whitespace-insensitively', () => {
    const m = matchBranchesByName([' erode ', 'SALEM'], LIVE_LOCKERHUB_BRANCHES);
    expect(m.map((b) => b.id).sort()).toEqual(['br_erode_2', 'br_salem']);
  });
  it('a name with no LockerHub counterpart contributes nothing', () => {
    expect(matchBranchesByName(['Head Office'], LIVE_LOCKERHUB_BRANCHES)).toEqual([]);
  });
  it('an empty NCD name list matches nothing', () => {
    expect(matchBranchesByName([], LIVE_LOCKERHUB_BRANCHES)).toEqual([]);
  });
});

// ── restricted:true, for real — a local mock stands in for LockerHub ───────
describe('branch_staff restriction — real HTTP, mock LockerHub', () => {
  let ctx: TestCtx;
  let mock: Server;
  let erodeId: number, salemId: number, hoId: number;

  const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
  const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

  const makeStaff = async (email: string, branchId: number | null, extraBranchId?: number) => {
    const a = await admin();
    const u = await a.post('/api/users', { email, full_name: email, role: 'branch_staff', password: 'Demo_1234', branch_id: branchId ?? undefined });
    if (extraBranchId) await ctx.db.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2)', [u.json.id, extraBranchId]);
    return as(email);
  };

  beforeAll(async () => {
    ctx = await startTestServer();
    erodeId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'ERD'")).rows[0]!.id);
    salemId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'SLM'")).rows[0]!.id);
    hoId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);

    mock = createServer((req, res) => {
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (p === '/branches') return send(200, { branches: LIVE_LOCKERHUB_BRANCHES });
      if (p === '/locker-tenants') return send(200, { tenants: [] }); // roster itself is covered elsewhere; here we're pinning WHO may ask
      if (p === '/locker-inventory') {
        const b = url.searchParams.get('branch_id');
        const one = { total: 10, vacant: 6, occupied: 4, reserved: 0, other: 0, by_status: {} };
        return send(200, {
          as_of: 't', branch_id: b, totals: { ...one, occupancy_pct: 40, branches: b ? 1 : LIVE_LOCKERHUB_BRANCHES.length },
          by_size: [{ size: 'Medium', ...one }],
          pricing: [{ size: 'Medium', annual_fee: 3000, rent_incl_gst: 3540, deposit: 25000, gst_pct: 18 }],
          branches: (b ? LIVE_LOCKERHUB_BRANCHES.filter((x) => x.id === b) : LIVE_LOCKERHUB_BRANCHES)
            .map((x) => ({ branch_id: x.id, branch_name: x.name, address: '', ...one, occupancy_pct: 40, by_size: [{ size: 'Medium', ...one }] })),
        });
      }
      return send(404, { error: 'not found: ' + p });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const addr = mock.address();
    config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    config.LOCKERHUB_API_URL = undefined;
    await new Promise<void>((r) => mock.close(() => r()));
    await ctx.close();
  });

  it('a staff member assigned to a branch that matches LockerHub is confined to it', async () => {
    const staff = await makeStaff('erode.staff@demo.local', erodeId);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.status).toBe(200);
    expect(t.json.restricted_to).toEqual([{ id: 'br_erode_2', name: 'Erode' }]);
  });

  it('no branch_id given defaults to their own branch, not the whole network', async () => {
    const staff = await makeStaff('erode.staff2@demo.local', erodeId);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.status).toBe(200);
    expect(t.json.restricted_to).toEqual([{ id: 'br_erode_2', name: 'Erode' }]);
    const inv = await staff.get('/api/lockers/inventory');
    expect(inv.status).toBe(200);
    expect(inv.json.branches).toEqual([expect.objectContaining({ branch_id: 'br_erode_2' })]);
  });

  it('asking for their OWN branch explicitly still works', async () => {
    const staff = await makeStaff('erode.staff3@demo.local', erodeId);
    expect((await staff.get('/api/lockers/tenants?branch_id=br_erode_2')).status).toBe(200);
    expect((await staff.get('/api/lockers/inventory?branch_id=br_erode_2')).status).toBe(200);
  });

  it('asking for a DIFFERENT branch is refused — both endpoints', async () => {
    const staff = await makeStaff('erode.staff4@demo.local', erodeId);
    const t = await staff.get('/api/lockers/tenants?branch_id=br_salem');
    expect(t.status).toBe(403);
    const inv = await staff.get('/api/lockers/inventory?branch_id=br_salem');
    expect(inv.status).toBe(403);
  });

  it('assigned via user_branches (not users.branch_id) resolves the same way', async () => {
    const staff = await makeStaff('salem.staff@demo.local', null, salemId);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.status).toBe(200);
    expect(t.json.restricted_to).toEqual([{ id: 'br_salem', name: 'Salem' }]);
  });

  it('assigned to BOTH a matching and an unmatched branch is confined to the match only', async () => {
    const staff = await makeStaff('multi.staff@demo.local', erodeId, hoId);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.json.restricted_to).toEqual([{ id: 'br_erode_2', name: 'Erode' }]); // HO doesn't widen it
  });

  it('fails OPEN — assigned to HO, which has no LockerHub counterpart', async () => {
    const staff = await makeStaff('ho.staff@demo.local', hoId);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.status).toBe(200);
    expect(t.json.restricted_to).toBeNull();
    // Unrestricted, so a branch they were never assigned to is still reachable.
    expect((await staff.get('/api/lockers/tenants?branch_id=br_salem')).status).toBe(200);
  });

  it('fails OPEN — no branch assigned at all', async () => {
    const staff = await makeStaff('unassigned.staff@demo.local', null);
    const t = await staff.get('/api/lockers/tenants');
    expect(t.json.restricted_to).toBeNull();
  });

  it('branch_manager is never restricted, even assigned to a matching branch', async () => {
    const a = await admin();
    const u = await a.post('/api/users', { email: 'erode.bm@demo.local', full_name: 'Erode BM', role: 'branch_manager', password: 'Demo_1234', branch_id: erodeId });
    const bm = await as('erode.bm@demo.local');
    const t = await bm.get('/api/lockers/tenants');
    expect(t.json.restricted_to).toBeNull(); // owner explicitly declined restricting branch_manager
    expect((await bm.get('/api/lockers/tenants?branch_id=br_salem')).status).toBe(200);
    void u;
  });

  it('ncd_manager / admin are never restricted', async () => {
    for (const email of ['ncd@demo.local', 'admin@demo.local']) {
      const c = await as(email); // both are 'Demo_1234' demo accounts
      expect((await c.get('/api/lockers/tenants')).json.restricted_to).toBeNull();
    }
  });
});

// ── fail-open when LockerHub is unreachable (the default test environment) ─
describe('/api/lockers/tenants — fail-open with NO LockerHub configured', () => {
  let ctx: TestCtx;
  const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };

  beforeAll(async () => { ctx = await startTestServer(); });
  afterAll(async () => { await ctx.close(); });

  it('branch_staff still gets a 200 — a LockerHub outage must never lock staff out entirely', async () => {
    const staff = await as('staff@demo.local'); // seeded at HO
    const t = await staff.get('/api/lockers/tenants');
    expect(t.status).toBe(200);
    expect(t.json.restricted_to).toBeNull();
    expect(Array.isArray(t.json.rows)).toBe(true);
  });

  it('needs lockers:enroll regardless — an agent is refused outright', async () => {
    const agent = await as('agent@demo.local');
    expect((await agent.get('/api/lockers/tenants')).status).toBe(403);
  });
});
