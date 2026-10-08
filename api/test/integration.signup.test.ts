/**
 * Self-service sign-up (Staff / Agent) — owner spec 2026-07-18, tightened
 * 2026-10-08.
 *
 * The MECHANICS are unchanged and still tested here: login by mobile, an
 * Admin/CXO verification item in Approvals, agent numbering, the real email,
 * duplicates, password rules.
 *
 * What changed is when the login starts working. It used to work the moment
 * someone signed up, blocked only after 30 days unverified; now an admin must
 * approve it first, and sign-up is OFF unless the owner turns it on. So these
 * tests turn the switch on, and the 30-day case is replaced by the real rule
 * (see integration.signup-needs-approval.test.ts for the gate itself).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
  // Sign-up is off by default now (owner 2026-10-08). These tests are about
  // what happens WHEN it is open, so they open it.
  const a = await admin();
  const r = await a.put('/api/settings/auth.self_signup_enabled', { value: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

/** Approve the verification request a sign-up raised, so the login works. */
async function approveSignup(mobile: string): Promise<void> {
  const a = await admin();
  const q = await a.get('/api/approvals/queue');
  const req = q.json.rows.find((x: any) => x.request_type === 'user_verification' && x.metadata.mobile === mobile);
  expect(req, `no verification request for ${mobile}`).toBeTruthy();
  expect((await a.post(`/api/approvals/${req.id}/approve`)).status).toBe(200);
}

describe('self-service sign-up', () => {
  it('staff signup → login by mobile → verification item → admin approves', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000001', email: 'u9800000001@example.com', password: 'Passw0rd', full_name: 'New Staff', employee_id: 'E-1', branch_id: branchId });
    expect(su.status).toBe(201);

    // NOT yet: the login does nothing until an admin approves it.
    const login = new Client(ctx.base);
    const early = await login.post('/api/auth/login', { email: '9800000001', password: 'Passw0rd' });
    expect(early.status).toBe(403);

    // A user_verification item is waiting for Admin/CXO.
    const a = await admin();
    const q = await a.get('/api/approvals/queue');
    const req = q.json.rows.find((x: any) => x.request_type === 'user_verification' && x.metadata.mobile === '9800000001');
    expect(req).toBeTruthy();

    const ap = await a.post(`/api/approvals/${req.id}/approve`);
    expect(ap.status).toBe(200);

    // ...and now it works, by mobile, own-scope branch_staff.
    const lr = await login.post('/api/auth/login', { email: '9800000001', password: 'Passw0rd' });
    expect(lr.status).toBe(200);
    expect(lr.json.user.role).toBe('branch_staff');
    expect((await ctx.db.query("SELECT verified_at FROM users WHERE phone = '9800000001'")).rows[0]!.verified_at).toBeTruthy();
  });

  it('agent signup auto-generates an agent number + links a user, branch HO', async () => {
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000002', email: 'u9800000002@example.com', password: 'Secret99', full_name: 'Ravi Kumar' });
    expect(su.status).toBe(201);
    expect(su.json.agent_code).toMatch(/^AG-/);
    const row = (await ctx.db.query("SELECT agent_code, user_id FROM agents WHERE phone = '9800000002'")).rows[0]!;
    expect(row.agent_code).toBe(su.json.agent_code);
    expect(row.user_id).toBeTruthy();
    // ...and once approved, logs in by mobile with role 'agent'.
    await approveSignup('9800000002');
    const login = new Client(ctx.base);
    const lr = await login.post('/api/auth/login', { email: '9800000002', password: 'Secret99' });
    expect(lr.status, JSON.stringify(lr.json)).toBe(200);
    expect(lr.json.user.role).toBe('agent');
  });

  it('a duplicate mobile is rejected', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000001', email: 'u9800000001@example.com', password: 'Passw0rd', full_name: 'Dup', employee_id: 'E-9', branch_id: branchId });
    expect(su.status).toBe(409);
  });

  it('staff signup requires employee id and branch', async () => {
    const c = new Client(ctx.base);
    const noEmp = await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000011', email: 'u9800000011@example.com', password: 'Passw0rd', full_name: 'No Emp' });
    expect(noEmp.status).toBe(400);
  });

  it('a weak password (no number) is rejected', async () => {
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000009', email: 'u9800000009@example.com', password: 'abcdefgh', full_name: 'Weak Pw Agent' });
    expect(su.status).toBe(400);
  });

  it('an unapproved account is blocked from login — however old it is', async () => {
    // This replaces the 30-day rule. Age is no longer what decides: a brand new
    // unapproved account is blocked, and so is one left for 40 days.
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    await c.post('/api/auth/signup', { type: 'staff', mobile: '9800000003', email: 'u9800000003@example.com', password: 'Passw0rd', full_name: 'Old Staff', employee_id: 'E-3', branch_id: branchId });
    const login = new Client(ctx.base);
    expect((await login.post('/api/auth/login', { email: '9800000003', password: 'Passw0rd' })).status).toBe(403);

    await ctx.db.query("UPDATE users SET created_at = now() - interval '40 days' WHERE phone = '9800000003'");
    expect((await login.post('/api/auth/login', { email: '9800000003', password: 'Passw0rd' })).status).toBe(403);

    // Approval is the only thing that opens it.
    await approveSignup('9800000003');
    expect((await login.post('/api/auth/login', { email: '9800000003', password: 'Passw0rd' })).status).toBe(200);
  });

  // Owner 2026-07-23: store the address they actually signed up with — the old
  // `<mobile>@signup.local` placeholder is gone.
  it('stores the real signup email, shows it on the approval, and logs in with it', async () => {
    const branchId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'HO'")).rows[0]!.id);
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', {
      type: 'staff', mobile: '9800000021', email: '  Aneesha.K@Dhanam.Finance ', password: 'Passw0rd',
      full_name: 'Aneesha K', employee_id: 'E-21', branch_id: branchId,
    });
    expect(su.status).toBe(201);

    // Stored verbatim (normalised to lowercase/trimmed) — never synthetic.
    const row = (await ctx.db.query("SELECT email FROM users WHERE phone = '9800000021'")).rows[0]! as any;
    expect(row.email).toBe('aneesha.k@dhanam.finance');
    expect(row.email).not.toMatch(/signup\.local/);

    // The approver sees the real address — read while the request is still
    // pending, because approving it takes it out of the queue.
    const a = await admin();
    const q = await a.get('/api/approvals/queue');
    const req = q.json.rows.find((x: any) => x.request_type === 'user_verification' && x.metadata.mobile === '9800000021');
    expect(req, 'verification request should be in the queue').toBeTruthy();
    expect(req.metadata.email).toBe('aneesha.k@dhanam.finance');
    const det = await a.get(`/api/approvals/${req.id}`);
    expect(JSON.stringify(det.json)).toContain('aneesha.k@dhanam.finance');

    // Then, approved, either identifier signs them in.
    expect((await a.post(`/api/approvals/${req.id}/approve`)).status).toBe(200);
    for (const ident of ['aneesha.k@dhanam.finance', '9800000021']) {
      const lr = await new Client(ctx.base).post('/api/auth/login', { email: ident, password: 'Passw0rd' });
      expect(lr.status, ident).toBe(200);
    }
  });

  it('rejects a missing/invalid email, and a duplicate one with a clean 409', async () => {
    const c = new Client(ctx.base);
    const noEmail = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000022', password: 'Passw0rd', full_name: 'No Email Agent' });
    expect(noEmail.status).toBe(400);
    const bad = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000022', email: 'not-an-email', password: 'Passw0rd', full_name: 'Bad Email Agent' });
    expect(bad.status).toBe(400);

    const first = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000023', email: 'shared@example.com', password: 'Passw0rd', full_name: 'Shared A' });
    expect(first.status).toBe(201);
    // Same email, different mobile → 409, not a unique-violation 500.
    const dup = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000024', email: 'shared@example.com', password: 'Passw0rd', full_name: 'Shared B' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.message).toMatch(/email address already exists/i);
  });

  // Owner 2026-07-23: the agent list must show people, not codes.
  it('keeps the agent\'s real name on both the login and the agent record', async () => {
    const c = new Client(ctx.base);
    const su = await c.post('/api/auth/signup', {
      type: 'agent', mobile: '9800000031', email: 'meena@example.com', password: 'Passw0rd', full_name: '  Meena Raghavan  ',
    });
    expect(su.status).toBe(201);
    expect(su.json.agent_code).toMatch(/^AG-/);

    // The generated code identifies them; the NAME is what they typed.
    const agent = (await ctx.db.query("SELECT agent_code, full_name FROM agents WHERE phone = '9800000031'")).rows[0]! as any;
    expect(agent.agent_code).toBe(su.json.agent_code);
    expect(agent.full_name).toBe('Meena Raghavan');
    expect(agent.full_name).not.toMatch(/^Agent AG-/);

    const user = (await ctx.db.query("SELECT full_name FROM users WHERE phone = '9800000031'")).rows[0]! as any;
    expect(user.full_name).toBe('Meena Raghavan');

    // The approver sees the person, not the code.
    const a = await admin();
    const q = await a.get('/api/approvals/queue');
    const req = q.json.rows.find((x: any) => x.request_type === 'user_verification' && x.metadata.mobile === '9800000031');
    expect(req.metadata.name).toBe('Meena Raghavan');
  });

  it('an agent signing up without a name is refused', async () => {
    const c = new Client(ctx.base);
    const r = await c.post('/api/auth/signup', { type: 'agent', mobile: '9800000032', email: 'noname@example.com', password: 'Passw0rd' });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Name is required/i);
  });
});
