/**
 * A temporary password buys one thing: the chance to replace it (owner
 * 2026-10-08: "reset those 11 passwords - on the next login ask the users to
 * reset their own password").
 *
 * WHY. odpulse's /api/users returned every account WITH its plaintext password
 * to anyone who asked, and 23.153.36.167 took it three times on 2026-10-08.
 * Eleven NCD logins used one of those two passwords — a CXO, an NCD Manager, a
 * Branch Manager, six branch staff and two agents. Each was given a fresh
 * temporary password, which is only safe if it cannot be USED as a password.
 *
 * So the rule under test is not "we ask them nicely": while the flag is set,
 * every call is refused except the few needed to comply, and setting a new
 * password is what lifts it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const client = () => new Client(ctx.base);
const TEMP = 'TempPass123';

/** A staff login holding a temporary password, exactly as the reset leaves it. */
async function lockedUser(email: string): Promise<number> {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash(TEMP, 10);
  const u = (await ctx.db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role_id, is_active, must_change_password)
     SELECT $1, 'Reset Me', $2, role_id, TRUE, TRUE FROM users WHERE email = 'staff@demo.local'
     RETURNING id`, [email, hash])).rows[0]!;
  return Number(u.id);
}

describe('a temporary password unlocks only the password form', () => {
  it('signs in, then is refused everywhere else', async () => {
    await lockedUser('locked.one@example.com');
    const c = client();
    const login = await c.post('/api/auth/login', { email: 'locked.one@example.com', password: TEMP });
    expect(login.status, JSON.stringify(login.json)).toBe(200);
    expect(login.json.user.mustChangePassword, 'the screen needs to know').toBe(true);

    // Everything they might otherwise reach.
    for (const path of ['/api/customers', '/api/applications', '/api/leads', '/api/lockers/applications',
      '/api/banks', '/api/reports/outstanding', '/api/nav/badges', '/api/dashboard/search?q=a']) {
      const r = await c.get(path);
      expect(r.status, `${path} should be refused, got ${r.status}`).toBe(403);
      expect(String(r.json.error.message)).toContain('PASSWORD_CHANGE_REQUIRED');
    }
    // A write, too — not just reads.
    const w = await c.post('/api/leads', { full_name: 'Should Not Exist' });
    expect(w.status).toBe(403);
    expect((await ctx.db.query(
      "SELECT 1 FROM investor_leads WHERE full_name = 'Should Not Exist'")).rowCount).toBe(0);
  });

  it('can still do the few things needed to comply', async () => {
    await lockedUser('locked.two@example.com');
    const c = client();
    await c.post('/api/auth/login', { email: 'locked.two@example.com', password: TEMP });
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect((await c.post('/api/auth/refresh', {})).status).toBe(200);
  });

  it('setting a new password lifts it, in the same session', async () => {
    const id = await lockedUser('locked.three@example.com');
    const c = client();
    await c.post('/api/auth/login', { email: 'locked.three@example.com', password: TEMP });
    expect((await c.get('/api/customers')).status).toBe(403);

    const ch = await c.post('/api/auth/change-password', { currentPassword: TEMP, newPassword: 'MyOwnPass99' });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);

    // The flag is gone in the database…
    expect((await ctx.db.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM users WHERE id = $1', [id])).rows[0]!.must_change_password).toBe(false);
    // …and the session works without signing in again.
    expect((await c.get('/api/customers')).status).toBe(200);
    expect((await c.get('/api/auth/me')).json.user.mustChangePassword).toBe(false);

    // The temporary password is dead; the new one works.
    expect((await client().post('/api/auth/login', { email: 'locked.three@example.com', password: TEMP })).status).toBe(401);
    expect((await client().post('/api/auth/login', { email: 'locked.three@example.com', password: 'MyOwnPass99' })).status).toBe(200);
  });

  it('a wrong temporary password does not lift it', async () => {
    await lockedUser('locked.four@example.com');
    const c = client();
    await c.post('/api/auth/login', { email: 'locked.four@example.com', password: TEMP });
    const bad = await c.post('/api/auth/change-password', { currentPassword: 'not-it', newPassword: 'MyOwnPass99' });
    expect(bad.status).toBe(400);
    expect((await c.get('/api/customers')).status).toBe(403);
  });

  it('CONTROL: everybody else is completely unaffected', async () => {
    // 36 logins exist on production and only 11 were reset. If this breaks,
    // the whole company is locked out.
    for (const [who, pw] of [['admin@dhanam.finance', 'ChangeMe_Dev_123'], ['staff@demo.local', 'Demo_1234'],
      ['ncd@demo.local', 'Demo_1234'], ['agent@demo.local', 'Demo_1234']] as const) {
      const c = client();
      const l = await c.post('/api/auth/login', { email: who, password: pw });
      expect(l.status, who).toBe(200);
      expect(l.json.user.mustChangePassword, `${who} must NOT be flagged`).toBe(false);
      expect((await c.get('/api/customers')).status, `${who} customers`).toBe(200);
    }
  });
});
