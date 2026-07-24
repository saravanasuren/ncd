/**
 * Every agent is a user (owner 2026-07-24).
 *
 * Agents used to live only in `agents`, so deleting someone from the Users page
 * left their name on the Agents and Incentives lists — the owner deleted Prem
 * and still saw him offering a "Grant" button. Now each agent has a users row,
 * and deleting that user RETIRES the agent everywhere.
 *
 * Retire, not hard-delete: incentive_accruals.payee_id is a plain BIGINT with
 * no FK, so removing the row would orphan money already accrued and lose the
 * payee's name on it. Their customers fall back to Direct referrals, which is
 * what the owner asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('agents are users', () => {
  it('the migration gave every existing agent a user account', async () => {
    const orphans = (await ctx.db.query(
      'SELECT agent_code FROM agents WHERE user_id IS NULL AND deleted_at IS NULL')).rows;
    expect(orphans).toEqual([]);
  });

  it('a new agent is created WITH a user — no email or password needed', async () => {
    const a = await admin();
    const r = await a.post('/api/agents', { full_name: 'Userless Agent' });
    expect(r.status).toBe(201);
    const ag = (await ctx.db.query(
      'SELECT user_id, agent_code FROM agents WHERE id = $1', [r.json.id])).rows[0]! as any;
    expect(ag.user_id).toBeTruthy();

    const u = (await ctx.db.query(
      `SELECT u.email, u.password_hash, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [ag.user_id])).rows[0]! as any;
    expect(u.role).toBe('agent');
    // Synthesised address, and NO password — the account cannot authenticate
    // until someone sets a real one.
    expect(String(u.email)).toBe(`${String(ag.agent_code).toLowerCase()}@agents.dhanam.local`);
    expect(u.password_hash).toBeNull();
  });

  it('an agent whose email already belongs to a user is LINKED, not duplicated', async () => {
    const a = await admin();
    const before = Number((await ctx.db.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'shared@demo.local'")).rows[0]!.n);
    expect(before).toBe(0);
    const first = await a.post('/api/agents', { full_name: 'Shared One', email: 'shared@demo.local' });
    expect(first.status).toBe(201);
    const second = await a.post('/api/agents', { full_name: 'Shared Two', email: 'shared@demo.local' });
    expect(second.status).toBe(201);
    const after = Number((await ctx.db.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'shared@demo.local'")).rows[0]!.n);
    expect(after).toBe(1);   // one person, one user
    const users = (await ctx.db.query('SELECT user_id FROM agents WHERE id IN ($1,$2)', [first.json.id, second.json.id])).rows as any[];
    expect(Number(users[0].user_id)).toBe(Number(users[1].user_id));
  });
});

describe('deleting the user retires the agent everywhere', () => {
  it('the name disappears from the agents list, pickers and the incentives grant list', async () => {
    const a = await admin();
    const created = await a.post('/api/agents', { full_name: 'Retire Me' });
    const agentId = created.json.id;
    const userId = Number((await ctx.db.query('SELECT user_id FROM agents WHERE id = $1', [agentId])).rows[0]!.user_id);

    // Present everywhere first.
    expect(((await a.get('/api/agents')).json.rows as any[]).some((x) => Number(x.id) === Number(agentId))).toBe(true);
    expect(((await a.get('/api/incentives/agents')).json.rows as any[]).some((x) => Number(x.id) === Number(agentId))).toBe(true);

    expect((await a.del(`/api/users/${userId}`)).status).toBe(200);

    // …and gone from all of them.
    expect(((await a.get('/api/agents')).json.rows as any[]).some((x) => Number(x.id) === Number(agentId))).toBe(false);
    expect(((await a.get('/api/incentives/agents')).json.rows as any[]).some((x) => Number(x.id) === Number(agentId))).toBe(false);
    const row = (await ctx.db.query('SELECT deleted_at, is_active FROM agents WHERE id = $1', [agentId])).rows[0]! as any;
    expect(row.deleted_at).toBeTruthy();      // retired, not deleted — money history survives
    expect(row.is_active).toBe(false);
  });

  it("their customers fall back to Direct referrals", async () => {
    const a = await admin();
    const created = await a.post('/api/agents', { full_name: 'Has Customers' });
    const agentId = Number(created.json.id);
    const userId = Number((await ctx.db.query('SELECT user_id FROM agents WHERE id = $1', [agentId])).rows[0]!.user_id);

    const cust = await a.post('/api/customers', { full_name: 'Brought In', phone: '9770000101' });
    await ctx.db.query(
      "UPDATE customers SET enrolled_by_agent_id = $1, referred_by_text = 'Has Customers' WHERE id = $2",
      [agentId, cust.json.id]);

    expect((await a.del(`/api/users/${userId}`)).status).toBe(200);

    const c = (await ctx.db.query(
      'SELECT enrolled_by_agent_id, referred_by_text FROM customers WHERE id = $1', [cust.json.id])).rows[0]! as any;
    expect(c.enrolled_by_agent_id).toBeNull();   // Direct
    expect(c.referred_by_text).toBeNull();
    // The customer itself is untouched — only the attribution moved.
    const still = (await ctx.db.query('SELECT id FROM customers WHERE id = $1', [cust.json.id])).rows[0];
    expect(still).toBeTruthy();
  });

  it('a retired agent cannot be re-attached by a free-text "referred by"', async () => {
    const a = await admin();
    const created = await a.post('/api/agents', { full_name: 'Ghost Referrer' });
    const userId = Number((await ctx.db.query('SELECT user_id FROM agents WHERE id = $1', [created.json.id])).rows[0]!.user_id);
    expect((await a.del(`/api/users/${userId}`)).status).toBe(200);

    // Naming them on a new customer must NOT resurrect the retired agent; it
    // raises a fresh PendingApproval agent instead.
    const cust = await a.post('/api/customers', { full_name: 'New Via Ghost', phone: '9770000102', referred_by_text: 'Ghost Referrer' });
    expect(cust.status).toBe(201);
    const attached = (await ctx.db.query(
      'SELECT enrolled_by_agent_id FROM customers WHERE id = $1', [cust.json.id])).rows[0]! as any;
    expect(attached.enrolled_by_agent_id).not.toBe(Number(created.json.id));
  });

  it('a STAFF user with real records is still protected from deletion', async () => {
    const a = await admin();
    const u = await a.post('/api/users', {
      email: 'protected@demo.local', full_name: 'Protected Staff', role: 'branch_staff', password: 'Demo_1234',
    });
    const cust = await a.post('/api/customers', { full_name: 'Staff Customer', phone: '9770000103' });
    await ctx.db.query('UPDATE customers SET enrolled_by_user_id = $1 WHERE id = $2', [u.json.id, cust.json.id]);
    const r = await a.del(`/api/users/${u.json.id}`);
    expect(r.status).toBe(409);
    expect(String(r.json.error?.message ?? '')).toMatch(/disable the account instead/i);
  });
});
