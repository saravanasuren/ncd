/**
 * The two holes the 2026-10-08 sign-ups actually got data through (owner: fix
 * the paid call, the crash, the banks and the locker scope).
 *
 * What they could NOT read is instructive: the customer list came back empty,
 * because it is branch-scoped and their accounts had no branch. These two were
 * not.
 *
 * 1. /api/banks was guarded by LOGIN ALONE. It returns the company's six
 *    accounts with full account numbers and IFSC codes, so any role — an
 *    external agent included — could read them. Now banks:read, which every
 *    in-house role holds and agents and customers do not.
 *
 * 2. The LOCKER data came out two ways:
 *      · the lists call lockerBranchScopeFor, which failed OPEN for a
 *        branch_staff with NO branch assigned — exactly what a fresh sign-up
 *        is — so "no branch" meant "every branch": 117 applications with
 *        116 phone numbers;
 *      · the rent report applied NO scope at all: 83 tenancies with names,
 *        phones and rent, and the same as .xlsx.
 *    Checked on production before changing it: ZERO active branch_staff lack a
 *    branch, so failing closed takes nothing from anybody real.
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

describe('the company bank list is not reference data', () => {
  it('an AGENT cannot read it — they are not in the company', async () => {
    const agent = await as('agent@demo.local');
    const r = await agent.get('/api/banks');
    expect(r.status).toBe(403);
  });

  it('CONTROL: in-house roles still get it — the credited-to dropdown needs it', async () => {
    for (const [who, pw] of [['admin@dhanam.finance', 'ChangeMe_Dev_123'], ['ncd@demo.local', undefined],
      ['staff@demo.local', undefined], ['bm@demo.local', undefined], ['cxo@demo.local', undefined]] as const) {
      const c = await as(who, pw);
      const r = await c.get('/api/banks');
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(200);
      expect(Array.isArray(r.json.rows), who).toBe(true);
    }
  });

  it('and not without logging in at all', async () => {
    expect((await client().get('/api/banks')).status).toBe(401);
  });
});

describe('locker data follows the branch you are assigned to', () => {
  /** A branch_staff login with no branch — what a fresh sign-up looked like. */
  async function branchlessStaff(email: string): Promise<Client> {
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash('Passw0rd123', 10);
    await ctx.db.query(
      `INSERT INTO users (email, full_name, password_hash, role_id, is_active, branch_id)
       SELECT $1, 'Branchless Staff', $2, role_id, TRUE, NULL FROM users WHERE email = 'staff@demo.local'`,
      [email, hash]);
    return as(email, 'Passw0rd123');
  }

  it('no branch assigned now means NO lockers, where it used to mean all of them', async () => {
    // A real locker on the book first — otherwise "sees nothing" would pass on
    // an empty table and prove nothing.
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Locker Scope Cust', phone: '9733000001' });
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone,
                                        branch_id, branch_name, locker_size, locker_number, status)
       VALUES ('la_scope_1', $1, 'Locker Scope Cust', '9733000001', 'b-rsp', 'RS Puram', 'Large', 'S1-1', 'approved')`,
      [Number(cust.json.id)]);

    // The unrestricted role can see it — so the row IS visible to somebody.
    const seen = await a.get('/api/lockers/applications');
    expect(seen.status).toBe(200);
    expect(seen.json.rows.some((r: any) => r.lockerhub_application_id === 'la_scope_1'),
      'admin must see the seeded locker, or this test proves nothing').toBe(true);

    // The branchless staff member sees none of it.
    const c = await branchlessStaff('branchless.one@example.com');
    const list = await c.get('/api/lockers/applications');
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.rows.length, 'a staff member with no branch has no portfolio').toBe(0);
  });

  it('the scope itself reports restricted-with-nothing, not unrestricted', async () => {
    // The load-bearing line. The rent report's rows come from LockerHub, which
    // is unreachable in tests, so asserting "0 rows" there would be vacuous —
    // this asserts the decision the report (and every locker list) acts on.
    const { lockerBranchScopeFor } = await import('../src/modules/lockers/branchScope.js');
    const bcrypt = (await import('bcryptjs')).default;
    const hash = await bcrypt.hash('Passw0rd123', 10);
    const u = (await ctx.db.query<{ id: string; role: string }>(
      `INSERT INTO users (email, full_name, password_hash, role_id, is_active, branch_id)
       SELECT 'scope.probe@example.com', 'Scope Probe', $1, role_id, TRUE, NULL FROM users WHERE email = 'staff@demo.local'
       RETURNING id, (SELECT name FROM roles WHERE id = role_id) AS role`, [hash])).rows[0]!;
    const actor = { id: Number(u.id), role: u.role, permissions: [], branchIds: [], agentId: null,
      customerId: null, email: 'scope.probe@example.com', fullName: 'Scope Probe' } as never;
    const scope = await lockerBranchScopeFor(ctx.db, actor);
    expect(scope.restricted, 'no branch must NOT mean unrestricted').toBe(true);
    expect(scope.branchIds).toEqual([]);
    expect(scope.branches).toEqual([]);
  });

  it('the spreadsheet is the same data by another door, and gets the same scope', async () => {
    // They took rent-report.xlsx as well as the JSON, so the file cannot be a
    // way around the rule.
    const c = await branchlessStaff('branchless.two@example.com');
    const r = await c.raw('/api/lockers/rent-report.xlsx');
    expect(r.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer as never);
    const ws = wb.getWorksheet('Locker rent')!;
    const text: string[] = [];
    ws.eachRow((row) => { text.push((row.values as unknown[]).slice(1).map((v) => String(v ?? '')).join(' | ')); });
    // Header and summary lines may be present; no tenant rows may be.
    const anyPhone = text.some((l) => /\b[6-9]\d{9}\b/.test(l));
    expect(anyPhone, 'no phone number may appear for a caller with no branch').toBe(false);
  });

  it('CONTROL: an unrestricted role still sees the whole book', async () => {
    // admin/ncd_manager/branch_manager are deliberately unrestricted — if this
    // breaks, the locker pages are empty for the people who run them.
    for (const [who, pw] of [['admin@dhanam.finance', 'ChangeMe_Dev_123'], ['bm@demo.local', undefined]] as const) {
      const c = await as(who, pw);
      const list = await c.get('/api/lockers/applications');
      expect(list.status, who).toBe(200);
      const rep = await c.get('/api/lockers/rent-report');
      expect(rep.status, who).toBe(200);
      // Nothing is filtered away for them: the scope reports unrestricted, so
      // the rows are whatever the book holds (0 in a fresh test DB, but the
      // call must succeed and must not be scoped to nothing by accident).
      expect(Array.isArray(rep.json.rows), who).toBe(true);
    }
  });
});
