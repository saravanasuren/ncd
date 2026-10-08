/**
 * A self-signed-up login does nothing until an admin approves it, and sign-up
 * is off unless the owner turns it on (owner 2026-10-08: "make signup need
 * admin approval before the account works", "turn off the self sign up button
 * - keep it UI editable").
 *
 * WHY. On 2026-10-08, seven accounts self-registered from one address via curl
 * between 07:37 and 07:58 IST and were creating customers within seconds. The
 * old rule was not "wait for approval" but "verify within THIRTY DAYS" — an
 * unverified account had a month of working staff or agent access. Approval is
 * now the gate, and the door itself is shut by default.
 *
 * The control that matters as much as the block: the four real people who
 * signed up and were approved must keep signing in, and an admin-created login
 * must be untouched by any of this.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const client = () => new Client(ctx.base);
const as = async (email: string, password = 'Demo_1234') => {
  const c = client(); const r = await c.post('/api/auth/login', { email, password });
  expect(r.status, `${email}: ${JSON.stringify(r.json)}`).toBe(200); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const setSignup = async (on: boolean) => {
  const a = await admin();
  const r = await a.put('/api/settings/auth.self_signup_enabled', { value: on });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
};

let n = 0;
const signup = (c: Client, over: Record<string, unknown> = {}) => {
  n += 1;
  return c.post('/api/auth/signup', {
    type: 'agent', full_name: `Signup Test ${n}`, mobile: `95550000${String(n).padStart(2, '0')}`,
    email: `signup.test.${n}@example.com`, password: 'Passw0rd123', ...over,
  });
};

describe('self sign-up is off by default', () => {
  it('is reported as off, and the sign-up is refused', async () => {
    // Default comes from the catalog — nothing needs setting for this to hold.
    const pub = await client().get('/api/auth/signup-enabled');
    expect(pub.status).toBe(200);
    expect(pub.json.enabled).toBe(false);

    const r = await signup(client());
    expect(r.status).toBe(403);
    expect(String(r.json.error.message)).toMatch(/turned off/i);
  });

  it('is a setting the owner can switch on, and the switch is public to read', async () => {
    await setSignup(true);
    expect((await client().get('/api/auth/signup-enabled')).json.enabled).toBe(true);
    await setSignup(false);
    expect((await client().get('/api/auth/signup-enabled')).json.enabled).toBe(false);
  });

  it('only a super admin may move it', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.put('/api/settings/auth.self_signup_enabled', { value: true })).status).toBe(403);
    expect((await client().put('/api/settings/auth.self_signup_enabled', { value: true })).status).toBe(401);
    expect((await client().get('/api/auth/signup-enabled')).json.enabled).toBe(false);
  });
});

describe('an approved admin is what makes a self-signup work', () => {
  it('the new login is refused until it is approved, then works', async () => {
    await setSignup(true);
    const email = 'approve.me@example.com';
    const pw = 'Passw0rd123';
    const created = await signup(client(), { email, password: pw, full_name: 'Approve Me' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const userId = Number(created.json.id);

    // Correct password, and still no session.
    const blocked = await client().post('/api/auth/login', { email, password: pw });
    expect(blocked.status).toBe(403);
    expect(String(blocked.json.error.message)).toMatch(/waiting for an administrator/i);

    // THE approval — the request the sign-up raised.
    const a = await admin();
    const req = (await ctx.db.query<{ id: string }>(
      `SELECT id FROM approval_requests WHERE request_type = 'user_verification' AND entity_id = $1
        AND status = 'Pending' ORDER BY id DESC LIMIT 1`, [String(userId)])).rows[0];
    expect(req, 'sign-up must raise a verification request').toBeTruthy();
    const approved = await a.post(`/api/approvals/${req!.id}/approve`);
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);

    // Now it works.
    const ok = await client().post('/api/auth/login', { email, password: pw });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await setSignup(false);
  });

  it('an unapproved account cannot keep a session alive by refreshing', async () => {
    // The old 30-day rule was re-checked on refresh; the approval rule has to
    // be too, or an account approved and later rejected rolls on for ever.
    await setSignup(true);
    const email = 'refresh.me@example.com';
    const pw = 'Passw0rd123';
    const created = await signup(client(), { email, password: pw, full_name: 'Refresh Me' });
    const userId = Number(created.json.id);

    // Approve, sign in, then withdraw the approval the way a rejection does.
    const a = await admin();
    const req = (await ctx.db.query<{ id: string }>(
      `SELECT id FROM approval_requests WHERE request_type = 'user_verification' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`, [String(userId)])).rows[0]!;
    await a.post(`/api/approvals/${req.id}/approve`);
    const c = client();
    expect((await c.post('/api/auth/login', { email, password: pw })).status).toBe(200);
    expect((await c.post('/api/auth/refresh', {})).status).toBe(200);

    await ctx.db.query('UPDATE users SET verified_at = NULL WHERE id = $1', [userId]);
    const after = await c.post('/api/auth/refresh', {});
    expect(after.status).toBe(403);
    expect(String(after.json.error.message)).toMatch(/waiting for an administrator/i);
    await setSignup(false);
  });

  it('CONTROL: an ALREADY-APPROVED self-signup still signs in', async () => {
    // The four real people on production are in exactly this state. If this
    // breaks, staff are locked out of the live system.
    await setSignup(true);
    const email = 'already.approved@example.com';
    const pw = 'Passw0rd123';
    const created = await signup(client(), { email, password: pw, full_name: 'Already Approved' });
    await ctx.db.query('UPDATE users SET verified_at = now() WHERE id = $1', [Number(created.json.id)]);
    expect((await client().post('/api/auth/login', { email, password: pw })).status).toBe(200);
    await setSignup(false);
  });

  it('CONTROL: an admin-created login is not affected at all', async () => {
    // is_self_signup is false for these, so the gate must not look at them —
    // every member of staff and the owner's own login included.
    for (const who of ['admin@dhanam.finance', 'ncd@demo.local', 'staff@demo.local', 'agent@demo.local']) {
      const c = client();
      const r = await c.post('/api/auth/login',
        { email: who, password: who === 'admin@dhanam.finance' ? 'ChangeMe_Dev_123' : 'Demo_1234' });
      expect(r.status, who).toBe(200);
      expect((await c.post('/api/auth/refresh', {})).status, `${who} refresh`).toBe(200);
    }
  });
});
