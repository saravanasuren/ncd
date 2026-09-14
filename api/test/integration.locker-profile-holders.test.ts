/**
 * The locker profile must be able to name HIRER 1 (owner 2026-09-14: "in the
 * locker tenent page when i click on the customers name im not seeing the 1st
 * hirers details").
 *
 * It resolved the customer only through a CHEQUE or an NCD PLEDGE — money
 * paths. A locker whose rent was waived and which backs no NCD investment has
 * neither, so the page found nobody and rendered hirer 1 as a dash while
 * listing hirer 2 by name directly underneath.
 *
 * locker_applications carries the customer for every application NCD creates.
 * It is the obvious source and was not consulted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const profile = async (appId: string) => {
  const { lockerProfile } = await import('../src/modules/lockers/profile.js');
  return await lockerProfile(ctx.db, appId) as Record<string, unknown>;
};

describe('the locker profile names hirer 1', () => {
  it('finds the customer from the application index — no cheque, no pledge', async () => {
    // Exactly L10-12's shape on production: rent waived, no NCD backing it.
    const a = new Client(ctx.base);
    await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const cust = await a.post('/api/customers', { full_name: 'Locker Holder One', phone: '9713000001' });
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone, locker_size, status)
       VALUES ('LKR-PROF-1', $1, 'Locker Holder One', '9713000001', 'Large', 'approved')`, [Number(cust.json.id)]);

    const p = await profile('LKR-PROF-1');
    const c = p.customer as Record<string, unknown> | null;
    expect(c).toBeTruthy();
    expect(c!.full_name).toBe('Locker Holder One');
    expect(Number(c!.id)).toBe(Number(cust.json.id));
  });

  it('still names a walk-in with no NCD customer row at all', async () => {
    // Created straight on LockerHub, so there is nobody in `customers` — but
    // the index knows the name, and a name beats a dash on the line that says
    // who holds the locker.
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_name, phone, locker_size, status)
       VALUES ('LKR-PROF-2', 'Walk In Holder', '9713000002', 'Medium', 'approved')`);
    const p = await profile('LKR-PROF-2');
    const c = p.customer as Record<string, unknown> | null;
    expect(c).toBeTruthy();
    expect(c!.full_name).toBe('Walk In Holder');
    expect(c!.phone).toBe('9713000002');
    expect(c!.id).toBeNull();     // no NCD record to link to
  });

  it('carries our OWN signing record, which is what the page must show', async () => {
    // The page was reading LockerHub's A19 status. Since #421 the signing is
    // entirely ours, so theirs reads "not started" for ever — a signed
    // agreement looked unsigned and Check could never say otherwise.
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status)
       VALUES ('LKR-PROF-1', 'esign', 'CustomerSigned')`);
    const p = await profile('LKR-PROF-1');
    const sg = p.signing as Record<string, unknown> | null;
    expect(sg).toBeTruthy();
    expect(sg!.status).toBe('CustomerSigned');
    expect(sg!.method).toBe('esign');
  });

  it('a locker nobody is recorded against still returns, rather than throwing', async () => {
    const p = await profile('LKR-PROF-NOBODY');
    expect(p.customer ?? null).toBeNull();
    expect(Array.isArray(p.hirers)).toBe(true);
  });
});
