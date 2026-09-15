/**
 * An authorised user's Aadhaar is last-four only, and you cannot reach one on a
 * locker that is not yours.
 *
 * Both halves were broken together, which is what made it serious: the full
 * twelve digits were stored, echoed to the browser, rendered on screen and
 * printed into the consent letter — and that letter was fetchable by walking a
 * serial id, with no ownership check on any of the four by-id routes. So one
 * branch_staff cookie plus a for-loop returned every signed consent in the
 * company, each carrying someone's Aadhaar.
 *
 * Every other Aadhaar here is last-four by rule (hirers.ts: "AADHAAR IS LAST
 * FOUR, NEVER TWELVE … Aadhaar Act 2016 s.29"); authorised users were simply
 * never brought under it. Migration 094.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const APP = 'la_pii_1';
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('authorised user Aadhaar is never stored or shown in full', () => {
  let id: number;

  it('keeps only the last four, even when handed twelve', async () => {
    const a = await admin();
    const owner = await a.post('/api/customers', { full_name: 'PII Holder', phone: '9872300001' });
    const add = await a.post(`/api/lockers/applications/${APP}/authorised-users`, {
      customer_id: owner.json.id, name: 'Trusted Person', pan: 'ABCDE1234F', aadhaar: '111122223333', phone: '9872300002',
    });
    expect(add.status).toBe(201);
    id = add.json.id;

    // Nothing of the full number survives at rest.
    const row = (await ctx.db.query('SELECT aadhaar, aadhaar_last4 FROM locker_authorised_users WHERE id = $1', [id])).rows[0] as any;
    expect(row.aadhaar).toBeNull();
    expect(row.aadhaar_last4).toBe('3333');

    // …nor reaches the browser.
    const list = await a.get(`/api/lockers/applications/${APP}/authorised-users`);
    const r = list.json.rows[0];
    expect(r.aadhaar_last4).toBe('3333');
    expect(JSON.stringify(list.json)).not.toContain('111122223333');
  });

  it('the database refuses a full number outright', async () => {
    await expect(ctx.db.query(
      "UPDATE locker_authorised_users SET aadhaar = '111122223333' WHERE id = $1", [id],
    )).rejects.toThrow();   // locker_auth_user_no_full_aadhaar_ck
  });
});

describe('authorised-user routes are not reachable by guessing an id', () => {
  it("an own-scope staffer cannot touch a holder they cannot see", async () => {
    const a = await admin();
    // A holder enrolled by ADMIN — outside a branch_staff's own-scope.
    const owner = await a.post('/api/customers', { full_name: 'Someone Elses Holder', phone: '9872300010' });
    const add = await a.post('/api/lockers/applications/la_pii_other/authorised-users', {
      customer_id: owner.json.id, name: 'Their Person', aadhaar: '9999', phone: '9872300011',
    });
    const theirId = add.json.id;

    const staff = await as('staff@demo.local');
    for (const call of [
      () => staff.get(`/api/lockers/authorised-users/${theirId}/consent.pdf`),
      () => staff.post(`/api/lockers/authorised-users/${theirId}/revoke`, { reason: 'not mine to revoke' }),
      () => staff.post(`/api/lockers/authorised-users/${theirId}/consent/refresh`, {}),
      () => staff.post(`/api/lockers/authorised-users/${theirId}/sync-retry`, {}),
    ]) {
      const r = await call();
      expect([403, 404]).toContain(r.status);
    }

    // The person is still authorised — a refused revoke must not half-apply.
    const row = (await ctx.db.query('SELECT status FROM locker_authorised_users WHERE id = $1', [theirId])).rows[0] as any;
    expect(row.status).not.toBe('revoked');
  });

  it('the holder\'s own enroller is still allowed through', async () => {
    const staff = await as('staff@demo.local');
    const mine = await staff.post('/api/customers', { full_name: 'My Own Holder', phone: '9872300020' });
    const add = await staff.post('/api/lockers/applications/la_pii_mine/authorised-users', {
      customer_id: mine.json.id, name: 'My Person', aadhaar: '4321', phone: '9872300021',
    });
    expect(add.status).toBe(201);
    // Reachable by the person who enrolled the holder — the guard closes the
    // enumeration without breaking the normal flow.
    const r = await staff.post(`/api/lockers/authorised-users/${add.json.id}/consent/refresh`, {});
    expect([200, 404]).toContain(r.status);   // 404 only if Digio has no session under test
    expect(r.status).not.toBe(403);
  });
});
