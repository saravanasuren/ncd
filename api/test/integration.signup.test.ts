/**
 * Self-service sign-up (Staff / Agent) — owner spec 2026-07-18.
 * Login by mobile, immediate own-scope access (unverified), an Admin/CXO
 * verification item in Approvals, and the 30-day unverified login block.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('self-service sign-up', () => {
  it('staff signup → login by mobile → verification item → admin approves', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000001', password: 'Passw0rd', full_name: 'New Staff', employee_id: 'E-1', branch_id: branchId });
    expect(su.status).toBe(201);

    // Log in immediately with the mobile — own-scope branch_staff, unverified.
    const login = new Client(ctx.base);
    const lr = await login.post('/api/auth/login', { email: '9800000001', password: 'Passw0rd' });
    expect(lr.status).toBe(200);
    expect(lr.json.user.role).toBe('branch_staff');

    // A user_verification item is waiting for Admin/CXO.
    const a = await admin();
    const q = await a.get('/api/approvals/queue');
    const req = q.json.rows.find((x: any) => x.request_type === 'user_verification' && x.metadata.mobile === '9800000001');
    expect(req).toBeTruthy();

    const ap = await a.post(`/api/approvals/${req.id}/approve`);
    expect(ap.status).toBe(200);
    expect((await ctx.db.query("SELECT verified_at FROM users WHERE phone = '9800000001'")).rows[0]!.verified_at).toBeTruthy();
  });

  it('agent signup auto-generates an agent number + links a user, branch HO', async () => {
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000002', password: 'Secret99' });
    expect(su.status).toBe(201);
    expect(su.json.agent_code).toMatch(/^AG-/);
    const row = (await ctx.db.query("SELECT agent_code, user_id FROM agents WHERE phone = '9800000002'")).rows[0]!;
    expect(row.agent_code).toBe(su.json.agent_code);
    expect(row.user_id).toBeTruthy();
    // logs in by mobile with role 'agent'
    const login = new Client(ctx.base);
    const lr = await login.post('/api/auth/login', { email: '9800000002', password: 'Secret99' });
    expect(lr.json.user.role).toBe('agent');
  });

  it('a duplicate mobile is rejected', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000001', password: 'Passw0rd', full_name: 'Dup', employee_id: 'E-9', branch_id: branchId });
    expect(su.status).toBe(409);
  });

  it('staff signup requires employee id and branch', async () => {
    const c = new Client(ctx.base);
    const noEmp = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000011', password: 'Passw0rd', full_name: 'No Emp' });
    expect(noEmp.status).toBe(400);
  });

  it('a weak password (no number) is rejected', async () => {
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000009', password: 'abcdefgh' });
    expect(su.status).toBe(400);
  });

  it('an unverified account older than 30 days is blocked from login', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000003', password: 'Passw0rd', full_name: 'Old Staff', employee_id: 'E-3', branch_id: branchId });
    await ctx.db.query("UPDATE users SET created_at = now() - interval '40 days' WHERE phone = '9800000003'");
    const login = new Client(ctx.base);
    const lr = await login.post('/api/auth/login', { email: '9800000003', password: 'Passw0rd' });
    expect(lr.status).toBe(403);
  });
});
