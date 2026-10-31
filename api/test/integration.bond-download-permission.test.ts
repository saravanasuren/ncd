/**
 * Who may print a bond / subordinate debt certificate (owner 2026-10-31).
 *
 * The certificate is a signed acknowledgement of debt carrying three directors'
 * signatures, and downloading one MINTS a permanent certificate number. It was
 * gated on `customers:read` — held by everyone who works with a customer — so
 * any branch staff member could print one. It is now `bonds:download`:
 * Admin, CXO and NCD Manager only.
 *
 * The assertions are deliberately "403 or not 403" rather than 200: in a fresh
 * test database there may be no issuable investment to render, so the route can
 * legitimately 404. What matters is whether the caller got past the gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base);
  const r = await c.post('/api/auth/login', { email, password });
  expect(r.status, `${email}: ${JSON.stringify(r.json)}`).toBe(200);
  return c;
};

/** Any application id — the gate is checked before the row is looked up. */
const BOND = '/api/reports/bond/1.pdf';
const CONSOLIDATED = '/api/reports/consolidated-bond/1/1.pdf';

describe('printing a certificate of indebtedness is restricted', () => {
  it('BRANCH STAFF are refused — this is the hole being closed', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.raw(BOND)).status, 'branch staff must not print a bond').toBe(403);
    expect((await staff.raw(CONSOLIDATED)).status, 'nor the consolidated one').toBe(403);
  });

  it('a BRANCH MANAGER is refused too — the owner named only Admin, CXO and NCD Manager', async () => {
    const bm = await as('bm@demo.local');
    expect((await bm.raw(BOND)).status).toBe(403);
    expect((await bm.raw(CONSOLIDATED)).status).toBe(403);
  });

  it('CONTROL: Admin, CXO and NCD Manager still get through the gate', async () => {
    for (const [who, pw] of [
      ['admin@dhanam.finance', 'ChangeMe_Dev_123'],
      ['cxo@demo.local', undefined],
      ['ncd@demo.local', undefined],
    ] as const) {
      const c = await as(who, pw);
      for (const url of [BOND, CONSOLIDATED]) {
        const r = await c.raw(url);
        expect(r.status, `${who} was blocked from ${url}`).not.toBe(403);
      }
    }
  });

  it('and signing in is still required at all', async () => {
    const anon = new Client(ctx.base);
    expect((await anon.raw(BOND)).status).toBe(401);
  });
});
