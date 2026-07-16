/**
 * Phase 2 integration — auth, RBAC, settings, masters over real HTTP (PGlite).
 * Verifies the Phase 2 "done" criteria (docs/11).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.close();
});

describe('auth', () => {
  it('rejects bad credentials', async () => {
    const c = new Client(ctx.base);
    const r = await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'wrong' });
    expect(r.status).toBe(401);
  });

  it('logs in the seed admin and returns role + permissions', async () => {
    const c = new Client(ctx.base);
    const r = await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe('super_admin');
    expect(r.json.user.permissions).toContain('settings:manage');
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe('admin@dhanam.finance');
  });

  it('blocks mutations without the CSRF header', async () => {
    const res = await fetch(ctx.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x', password: 'y' }),
    });
    expect(res.status).toBe(403);
  });
});

async function admin(): Promise<Client> {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('settings registry', () => {
  it('exposes the corrected interest defaults', async () => {
    const c = await admin();
    const r = await c.get('/api/settings');
    expect(r.status).toBe(200);
    const interest = r.json.groups.Interest as any[];
    const payoutDay = interest.find((s) => s.key === 'interest.payout_day_of_month');
    expect(payoutDay.value).toBe(28);
    const conv = interest.find((s) => s.key === 'interest.day_count_convention');
    expect(conv.value).toBe('Actual365');
  });

  it('updates a setting with audit and rejects an invalid value', async () => {
    const c = await admin();
    const ok = await c.put('/api/settings/interest.payout_day_of_month', { value: 28 });
    expect(ok.status).toBe(200);
    const bad = await c.put('/api/settings/interest.day_count_convention', { value: 'Nonsense' });
    expect(bad.status).toBe(400);
    // audit row written
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'setting.update'");
    expect((rows[0] as any).n).toBeGreaterThan(0);
  });
});

describe('RBAC — role-correct access', () => {
  it('CXO cannot read settings (read-only role)', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'cxo@demo.local', password: 'Demo_1234' });
    const r = await c.get('/api/settings');
    expect(r.status).toBe(403);
  });

  it('branch staff cannot manage users', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    const r = await c.get('/api/users');
    expect(r.status).toBe(403);
  });

  it('NCD Manager can read settings (workflow-config) but not manage users', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    expect((await c.get('/api/settings')).status).toBe(200);
    expect((await c.get('/api/users')).status).toBe(403);
  });
});

describe('masters — a series can be configured end to end', () => {
  it('admin creates a scheme then a series linked to it', async () => {
    const c = await admin();
    const tds = await c.get('/api/tds-rules');
    const tdsId = tds.json.rows[0]?.id ? Number(tds.json.rows[0].id) : null;
    const scheme = await c.post('/api/schemes', {
      code: 'NCD-TEST-1',
      name: 'Test 12% Monthly 36m',
      tenure_months: 36,
      payout_frequency: 'Monthly',
      coupon_rate_pct: 12,
      tds_rule_id: tdsId,
    });
    expect(scheme.status).toBe(201);
    const series = await c.post('/api/series', {
      code: 'NCD 99',
      name: 'Test Series 99',
      deemed_date: '2026-08-01',
      scheme_ids: [scheme.json.id],
    });
    expect(series.status).toBe(201);
    // status transition Open → Closing is legal; Open → Closed is not
    const okT = await c.post(`/api/series/${series.json.id}/status`, { to: 'Closing' });
    expect(okT.status).toBe(200);
    const badT = await c.post(`/api/series/${series.json.id}/status`, { to: 'Closed' });
    expect(badT.status).toBe(409);
  });

  it('users:manage lets admin create a user', async () => {
    const c = await admin();
    const r = await c.post('/api/users', {
      email: 'newstaff@demo.local',
      full_name: 'New Staff',
      role: 'branch_staff',
      password: 'Secret_12345',
    });
    expect(r.status).toBe(201);
  });

  it('admin can edit a user and reset their password; the new password works', async () => {
    const c = await admin();
    const created = await c.post('/api/users', {
      email: 'editme@demo.local',
      full_name: 'Edit Me',
      role: 'branch_staff',
      password: 'FirstPw_123',
    });
    expect(created.status).toBe(201);
    const id = created.json.id;

    const upd = await c.put(`/api/users/${id}`, { full_name: 'Edited Name', password: 'SecondPw_456' });
    expect(upd.status).toBe(200);

    const fresh = new Client(ctx.base);
    expect((await fresh.post('/api/auth/login', { email: 'editme@demo.local', password: 'FirstPw_123' })).status).toBe(401);
    const ok = await fresh.post('/api/auth/login', { email: 'editme@demo.local', password: 'SecondPw_456' });
    expect(ok.status).toBe(200);
    expect(ok.json.user.fullName).toBe('Edited Name');
  });

  it('users:manage lists branches for the create-user form; others cannot', async () => {
    const c = await admin();
    const r = await c.get('/api/users/branches');
    expect(r.status).toBe(200);
    expect(r.json.rows.some((b: { code: string }) => b.code === 'HO')).toBe(true);

    const staff = new Client(ctx.base);
    await staff.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    expect((await staff.get('/api/users/branches')).status).toBe(403);
  });
});
