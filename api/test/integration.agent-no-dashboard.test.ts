/**
 * An agent does not get the company dashboard (owner 2026-08-05).
 *
 * Reported as "he is getting all the dashboard views". No data leaked — an
 * agent's scope is `enrolled_by_agent_id = <their agent id>` and every
 * dashboard query goes through it; on production Srinish D could see 0 of 809
 * investments. The objection is to what the page IS: the company's book.
 *
 * The trap this guards: `role_permissions` is a DB table and
 * `syncRolePermissions` is ADDITIVE ONLY, so editing DEFAULT_ROLE_PERMISSIONS
 * alone changes nothing on a live box. Migration 059 does the revoking. These
 * tests run against a migrated database, so they fail if either half is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { DEFAULT_ROLE_PERMISSIONS } from '@new-wealth/shared';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };

describe('the agent role', () => {
  it('does not carry dashboard:view in the code map', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('dashboard:view');
  });

  it('does not carry it in the DATABASE either — the additive sync cannot revoke', async () => {
    const { rows } = await ctx.db.query(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'agent' AND rp.permission = 'dashboard:view'`);
    expect(rows).toHaveLength(0);
  });

  // The test database is SEEDED from the code map, so the assertion above would
  // pass even with no migration at all. A live box is the opposite: the row is
  // already there and only a DELETE removes it. Re-grant it and run the real
  // migration file to prove the statement that ships actually revokes.
  it('migration 059 revokes it from a database that already has it', async () => {
    const sqlPath = fileURLToPath(new URL('../src/db/migrations/059_agents_lose_dashboard.sql', import.meta.url));
    const sql = await readFile(sqlPath, 'utf8');
    await ctx.db.query(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT id, 'dashboard:view' FROM roles WHERE name = 'agent' ON CONFLICT DO NOTHING`);
    const before = await ctx.db.query(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'agent' AND rp.permission = 'dashboard:view'`);
    expect(before.rows, 'the live-box state could not be recreated').toHaveLength(1);

    await ctx.db.query(sql);

    const after = await ctx.db.query(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'agent' AND rp.permission = 'dashboard:view'`);
    expect(after.rows).toHaveLength(0);
    // and it took nothing else with it
    const others = await ctx.db.query(
      `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission = 'dashboard:view' AND r.name <> 'agent'`);
    expect(Number((others.rows[0] as any).n)).toBeGreaterThan(0);
  });

  it('keeps the funnel — they still source business', async () => {
    for (const p of ['leads:create', 'leads:read', 'customers:create', 'customers:read',
                     'applications:create', 'earnings:read-own'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS.agent, `agent lost ${p}`).toContain(p);
    }
  });

  it('still cannot verify KYC on a customer they enrolled', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('kyc:verify');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('kyc:reject');
  });
});

describe('the endpoints behind the page', () => {
  it('the dashboard overview is refused', async () => {
    const r = await (await as('agent@demo.local')).get('/api/dashboard/overview');
    expect(r.status).toBe(403);
  });

  it('so is a drill-down, including the branch one', async () => {
    const a = await as('agent@demo.local');
    for (const w of ['new-investments', 'branch', 'staff']) {
      expect((await a.get(`/api/dashboard/drill/${w}`)).status, w).toBe(403);
    }
  });

  it('but their own earnings still work', async () => {
    const r = await (await as('agent@demo.local')).get('/api/incentives/my-earnings');
    expect([200, 404]).toContain(r.status);   // 200 with rows, 404 if unlinked — never 403
  });
});

describe('staff are unaffected', () => {
  it('branch_staff never had it and still does not', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.branch_staff).not.toContain('dashboard:view');
  });

  it('an ncd_manager still opens the dashboard', async () => {
    const r = await (await as('ncd@demo.local')).get('/api/dashboard/overview');
    expect(r.status).toBe(200);
  });

  it('and so does an admin', async () => {
    const r = await (await as('admin@dhanam.finance', 'ChangeMe_Dev_123')).get('/api/dashboard/overview');
    expect(r.status).toBe(200);
  });
});
