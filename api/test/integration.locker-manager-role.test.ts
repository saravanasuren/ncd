/**
 * The Locker Manager role (owner 2026-09-25): "see the complete locker datas of
 * all branches and is able to boook lockers too, no delete access" — and, on
 * the customer side, "only customers with locker their investments can be seen".
 *
 * Two halves, and the second is the one that can go wrong quietly. Locker
 * access across every branch comes FREE, because locker branch scoping
 * restricts branch_staff alone; a new role is unrestricted without anyone
 * writing a line. What needs proving is the restraint: that this role cannot
 * see the customers and investments it has no business in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';
import { DEFAULT_ROLE_PERMISSIONS } from '@new-wealth/shared';
import { scopeFor } from '../src/lib/scope.js';

let ctx: TestCtx;
let lockerCustId = 0, plainCustId = 0;

beforeAll(async () => {
  ctx = await startTestServer();
  const a = new Client(ctx.base);
  await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);

  // One customer WITH a locker, one without — both with an investment.
  for (const [name, phone] of [['Locker Holder', '9567000001'], ['Plain Investor', '9567000002']] as Array<[string, string]>) {
    const c = await a.post('/api/customers', { full_name: name, phone });
    const id = Number(c.json.id);
    if (name === 'Locker Holder') lockerCustId = id; else plainCustId = id;
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
    });
    const checker = new Client(ctx.base);
    await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    await approveInvestment(checker, create);
  }
  // Only the first holds a locker.
  await ctx.db.query(
    `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name)
     VALUES ('la_lm_1', $1, 'Locker Holder')`, [lockerCustId]);

  // A Locker Manager to log in as.
  const roleId = Number((await ctx.db.query("SELECT id FROM roles WHERE name = 'locker_manager'")).rows[0]!.id);
  const hash = (await ctx.db.query("SELECT password_hash FROM users WHERE email = 'ncd@demo.local'")).rows[0]!.password_hash;
  await ctx.db.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, is_active)
     VALUES ('lm@demo.local', $1, 'Demo Locker Manager', $2, TRUE)`, [hash, roleId]);
});
afterAll(async () => { await ctx.close(); });

const lm = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'lm@demo.local', password: 'Demo_1234' }); return c; };

describe('the Locker Manager can do the locker job', () => {
  it('holds the permissions to work every locker page, and to book', () => {
    const p = DEFAULT_ROLE_PERMISSIONS.locker_manager;
    expect(p).toContain('lockers:enroll');               // every locker route and page
    expect(p).toContain('lockers:waive');                // maker; Admin/CXO approve
    expect(p).toContain('applications:confirm-collection');
    expect(p).toContain('reports:download');
    expect(p).toContain('customers:create');             // a walk-in has no record yet
  });

  it('logs in and is recognised', async () => {
    const me = (await (await lm()).get('/api/auth/me')).json;
    expect(me.user.role).toBe('locker_manager');
    expect(me.user.permissions).toContain('lockers:enroll');
  });

  it('is NOT branch-restricted on lockers — every branch, by default', async () => {
    const { lockerBranchScopeFor } = await import('../src/modules/lockers/branchScope.js');
    const scope = await lockerBranchScopeFor(ctx.db, { id: 1, role: 'locker_manager' } as never);
    expect(scope.restricted).toBe(false);
  });
});

describe('the Locker Manager cannot delete', () => {
  it('holds none of the delete permissions', () => {
    const p = DEFAULT_ROLE_PERMISSIONS.locker_manager as string[];
    for (const forbidden of ['lockers:remove-tenant', 'customers:delete', 'applications:delete', 'users:delete']) {
      expect(p).not.toContain(forbidden);
    }
  });

  it('is refused when it tries to remove a locker application', async () => {
    const r = await (await lm()).post('/api/lockers/applications/la_lm_1/remove', { reason: 'testing the guard' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the Locker Manager sees locker customers and no others', () => {
  it('scopes to locker holders, not the whole book', () => {
    const s = scopeFor({ id: 5, role: 'locker_manager', branchIds: [], agentId: null, customerId: null });
    expect(s.kind).toBe('locker-customers');
  });

  it('lists the customer who holds a locker, and not the one who does not', async () => {
    const rows = (await (await lm()).get('/api/customers?limit=200')).json.rows as Array<{ id: number; full_name: string }>;
    const names = rows.map((r) => r.full_name);
    expect(names).toContain('Locker Holder');
    expect(names).not.toContain('Plain Investor');
  });

  it('shows the locker holder\'s investments, and not the other customer\'s', async () => {
    // The list returns the customer NAME, not the id.
    const rows = (await (await lm()).get('/api/applications?limit=200')).json.rows as Array<{ customer_name: string }>;
    const names = rows.map((r) => r.customer_name);
    expect(names).toContain('Locker Holder');
    expect(names).not.toContain('Plain Investor');
    // And an admin sees both, so the difference is the SCOPE and not an empty list.
    const admin = new Client(ctx.base);
    await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const all = (await admin.get('/api/applications?limit=200')).json.rows as Array<{ customer_name: string }>;
    expect(all.map((r) => r.customer_name)).toEqual(expect.arrayContaining(['Locker Holder', 'Plain Investor']));
  });

  it('cannot reach the other customer by id either', async () => {
    const r = await (await lm()).get(`/api/customers/${plainCustId}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the scope denies rather than guesses', () => {
  it('a query that supplies no customer column shows NOTHING to this role', async () => {
    const { scopeWhere } = await import('../src/lib/scope.js');
    const s = scopeFor({ id: 5, role: 'locker_manager', branchIds: [], agentId: null, customerId: null });
    // No customerCol — e.g. a screen nobody has scoped for this role yet.
    const unscoped = scopeWhere(s, { userCol: 'x.user_id', agentCol: 'x.agent_id', branchCol: 'x.branch_id' });
    expect(unscoped.sql).toBe('FALSE');
    // With one, it filters to locker holders.
    const scoped = scopeWhere(s, { userCol: 'x.user_id', agentCol: 'x.agent_id', branchCol: 'x.branch_id', customerCol: 'x.customer_id' });
    expect(scoped.sql).toContain('locker_applications');
  });
});

describe('existing roles keep their ids', () => {
  it('locker_manager was APPENDED — nobody else moved', async () => {
    // Role ids are positional in seed.ts. Inserting rather than appending would
    // renumber every later role and silently repoint every user holding one.
    const rows = (await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM roles ORDER BY id')).rows;
    const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
    expect(byId[1]).toBe('super_admin');
    expect(byId[5]).toBe('branch_manager');
    expect(byId[6]).toBe('branch_staff');
    expect(byId[8]).toBe('customer');
    expect(byId[9]).toBe('locker_manager');
  });
});
