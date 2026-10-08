/**
 * The two follow-ups from the 2026-10-08 self sign-ups (owner: "fix all of
 * them").
 *
 * 1. A PAID third-party call behind approval. Three penny-drops — a Decentro
 *    bank check we are billed for — were spent by an account nobody had
 *    approved, minutes after it signed itself up. A self-signup can no longer
 *    get a session at all, so this is the second lock on the same door: it also
 *    covers the ~15 minutes an access token outlives a withdrawn approval.
 *
 * 2. A 500 on bad input. GET /api/applications/clubbing-candidates took its two
 *    ids with Number(req.query...), so omitting them sent NaN into the query and
 *    came back 500 — our fault reported for a caller's mistake. The probe found
 *    it by simply leaving them off.
 *
 * The provider is the stub here (KYC_PRIMARY_PROVIDER unset), so nothing is
 * billed by this test.
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

const ACCOUNT = { account_number: '50100123456789', ifsc: 'HDFC0001234', name: 'Test Holder' };

describe('a paid bank check needs an approved account', () => {
  it('refuses a self-signup whose approval was withdrawn mid-session', async () => {
    // Built directly rather than through /signup, so this test says nothing
    // about whether sign-up is open — it is about the paid call. The account is
    // APPROVED while it signs in (the only way a self-signup ever gets a
    // session), and the approval is then withdrawn with the session still live:
    // the ~15 minutes an access token outlives its approval, which is exactly
    // the gap this guard exists to close.
    const u = (await ctx.db.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role_id, phone, is_active, is_self_signup, verified_at)
       SELECT 'penny.tester@example.com', 'Penny Tester', password_hash, role_id, '9512300001', TRUE, TRUE, now()
         FROM users WHERE email = 'staff@demo.local'
       RETURNING id`)).rows[0]!;
    const userId = Number(u.id);

    // Approved → signs in, and the paid call goes through.
    const c = await as('penny.tester@example.com');
    const okBefore = await c.post('/api/lookups/penny-drop', ACCOUNT);
    expect(okBefore.status, JSON.stringify(okBefore.json)).toBe(200);

    // Approval withdrawn, same live session.
    await ctx.db.query('UPDATE users SET verified_at = NULL WHERE id = $1', [userId]);

    const blocked = await c.post('/api/lookups/penny-drop', ACCOUNT);
    expect(blocked.status).toBe(403);
    expect(String(blocked.json.error.message)).toMatch(/waiting for an administrator/i);
  });

  it('CONTROL: staff and admins created by an admin are unaffected', async () => {
    // is_self_signup is false for them, so the guard must not look at them —
    // this is the enrolment flow every branch uses.
    for (const who of ['staff@demo.local', 'admin@dhanam.finance']) {
      const c = await as(who, who === 'admin@dhanam.finance' ? 'ChangeMe_Dev_123' : 'Demo_1234');
      const r = await c.post('/api/lookups/penny-drop', ACCOUNT);
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(200);
    }
  });
});

describe('clubbing-candidates answers bad input with 400, not 500', () => {
  it('no ids, half the ids, or junk → 400', async () => {
    const a = await admin();
    for (const qs of ['', '?customer_id=1', '?series_id=1', '?customer_id=&series_id=',
      '?customer_id=abc&series_id=1', '?customer_id=1&series_id=abc',
      '?customer_id=-1&series_id=1', '?customer_id=0&series_id=0']) {
      const r = await a.get(`/api/applications/clubbing-candidates${qs}`);
      expect(r.status, `"${qs}" should be a 400, got ${r.status}`).toBe(400);
    }
  });

  it('still answers properly with both ids', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Clubbing Ask', phone: '9512300002' });
    const series = (await a.get('/api/series')).json.rows[0];
    const r = await a.get(`/api/applications/clubbing-candidates?customer_id=${cust.json.id}&series_id=${series.id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
  });
});
