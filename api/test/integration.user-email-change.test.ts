/**
 * An admin can change a user's login address (owner 2026-08-12: "i should be
 * able to change the username/mailid of a user for them to login").
 *
 * Why it matters: 24 agent-derived accounts live on a placeholder
 * `@agents.dhanam.local` address nobody can receive mail at. Until now the field
 * was display-only — updateUser simply ignored `email` — so those people could
 * never be given a working login.
 *
 * The address IS the credential, so the tests below check the whole loop: the
 * new address signs in, the old one stops working, and no two accounts can end
 * up answering to the same login (including by letter case, which is how login
 * compares them).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const PW = 'ChangeMe_Dev_123';

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: PW });
  return c;
}

let n = 0;
async function makeUser(email: string): Promise<number> {
  const c = await admin();
  const r = await c.post('/api/users', {
    email, full_name: `Login Case ${++n}`, role: 'branch_staff', password: PW, is_staff: true,
  });
  expect(r.status).toBe(201);
  return Number(r.json.id);
}

/** Can this address + password sign in? */
async function canLogIn(email: string, password = PW): Promise<boolean> {
  const c = new Client(ctx.base);
  const r = await c.post('/api/auth/login', { email, password });
  return r.status === 200;
}

const emailOf = async (id: number) => (await ctx.db.query<{ email: string }>(
  'SELECT email FROM users WHERE id = $1', [id])).rows[0]!.email;

describe('changing the login address', () => {
  it('the NEW address logs in and the OLD one stops working', async () => {
    const id = await makeUser('placeholder.a@agents.dhanam.local');
    expect(await canLogIn('placeholder.a@agents.dhanam.local')).toBe(true);

    const r = await (await admin()).put(`/api/users/${id}`, { email: 'realperson.a@dhanam.finance' });
    expect(r.status).toBe(200);

    expect(await canLogIn('realperson.a@dhanam.finance')).toBe(true);
    expect(await canLogIn('placeholder.a@agents.dhanam.local')).toBe(false);
  });

  it('the password is untouched by an address change', async () => {
    const id = await makeUser('placeholder.b@agents.dhanam.local');
    await (await admin()).put(`/api/users/${id}`, { email: 'realperson.b@dhanam.finance' });
    expect(await canLogIn('realperson.b@dhanam.finance', PW)).toBe(true);
    expect(await canLogIn('realperson.b@dhanam.finance', 'wrong-password-entirely')).toBe(false);
  });

  it('is stored lowercase, so it matches how login compares', async () => {
    const id = await makeUser('placeholder.c@agents.dhanam.local');
    await (await admin()).put(`/api/users/${id}`, { email: '  MiXeD.Case@Dhanam.Finance  ' });
    expect(await emailOf(id)).toBe('mixed.case@dhanam.finance');
    expect(await canLogIn('MIXED.CASE@DHANAM.FINANCE')).toBe(true);
  });

  it('editing other fields leaves the address alone', async () => {
    const id = await makeUser('placeholder.d@agents.dhanam.local');
    await (await admin()).put(`/api/users/${id}`, { full_name: 'Renamed Only' });
    expect(await emailOf(id)).toBe('placeholder.d@agents.dhanam.local');
  });

  it('records the change in the audit log', async () => {
    const id = await makeUser('placeholder.e@agents.dhanam.local');
    await (await admin()).put(`/api/users/${id}`, { email: 'realperson.e@dhanam.finance' });
    const { rows } = await ctx.db.query<{ before_data: any; after_data: any }>(
      `SELECT before_data, after_data FROM audit_log
        WHERE action = 'user.update' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(id)]);
    expect(rows[0]!.before_data.email).toBe('placeholder.e@agents.dhanam.local');
    expect(rows[0]!.after_data.email).toBe('realperson.e@dhanam.finance');
  });
});

describe('two accounts can never answer to one login', () => {
  it('rejects an address another user already has', async () => {
    await makeUser('taken.person@dhanam.finance');
    const other = await makeUser('mover.person@dhanam.finance');
    const r = await (await admin()).put(`/api/users/${other}`, { email: 'taken.person@dhanam.finance' });
    expect(r.status).toBe(409);
    expect(await emailOf(other)).toBe('mover.person@dhanam.finance');   // unchanged
  });

  it('rejects it in a DIFFERENT CASE too — login does not care about case', async () => {
    // The old `email TEXT UNIQUE` is case-sensitive, so this would have been
    // allowed, leaving one sign-in matching two accounts and the row chosen by
    // an ORDER BY. Migration 068 + the lower() check close that.
    await makeUser('casetaken@dhanam.finance');
    const other = await makeUser('casemover@dhanam.finance');
    const r = await (await admin()).put(`/api/users/${other}`, { email: 'CaseTaken@Dhanam.Finance' });
    expect(r.status).toBe(409);
    expect(await emailOf(other)).toBe('casemover@dhanam.finance');
  });

  it('the DATABASE refuses it even if the check were bypassed', async () => {
    await makeUser('dbguard@dhanam.finance');
    const other = await makeUser('dbguard.other@dhanam.finance');
    await expect(ctx.db.query(
      'UPDATE users SET email = $1 WHERE email = $2', ['DBGuard@Dhanam.Finance', 'dbguard.other@dhanam.finance'])
    ).rejects.toThrow();
  });

  it('keeping your own address is not a clash with yourself', async () => {
    const id = await makeUser('samesame@dhanam.finance');
    const r = await (await admin()).put(`/api/users/${id}`, { email: 'samesame@dhanam.finance', full_name: 'Same Same' });
    expect(r.status).toBe(200);
  });
});

describe('rubbish is refused', () => {
  it('rejects a malformed address', async () => {
    const id = await makeUser('validation@dhanam.finance');
    for (const bad of ['not-an-email', 'missing@domain', '']) {
      const r = await (await admin()).put(`/api/users/${id}`, { email: bad });
      expect(r.status, `should reject ${JSON.stringify(bad)}`).toBeGreaterThanOrEqual(400);
    }
    expect(await emailOf(id)).toBe('validation@dhanam.finance');
  });

  it('needs users:manage — a branch staff cannot change anyone-s login', async () => {
    const id = await makeUser('protected@dhanam.finance');
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    const r = await c.put(`/api/users/${id}`, { email: 'hijacked@dhanam.finance' });
    expect(r.status).toBe(403);
    expect(await emailOf(id)).toBe('protected@dhanam.finance');
  });
});
