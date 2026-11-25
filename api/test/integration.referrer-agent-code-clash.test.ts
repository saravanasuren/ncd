/**
 * Approving a referrer change must survive a clash on the agent code.
 *
 * THE OUTAGE THIS PINS (2026-11-25). Correcting a customer's referrer to a
 * name nobody holds creates an agent for it. The AG-#### counter had fallen
 * behind the codes in use, so that INSERT hit the UNIQUE constraint — and
 * because `ensureAgentForReferrerText` caught the error WITHOUT a savepoint,
 * the approval's transaction was already aborted and every later statement
 * in it failed. The checker saw "Internal server error" while the log said
 * only that a referrer could not be registered.
 *
 * Two independent defences, one test each:
 *   · allocation skips a code already taken, so the clash does not happen;
 *   · a failure inside the helper rolls back to a savepoint, so the approval
 *     survives whatever else may go wrong there in future.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
};
const SELF_APPROVE = { extra: { self_approval_reason: 'Referrer confirmed with the branch; approving as super admin.' } };

/** Put the counter exactly where production had it: pointing at a taken code. */
async function makeCounterCollide(): Promise<string> {
  const used = (await ctx.db.query<{ n: string }>(
    `SELECT COALESCE(max(substring(agent_code from 4)::int), 0) AS n
       FROM agents WHERE agent_code ~ '^AG-[0-9]+$'`)).rows[0]!;
  const n = Number(used.n) + 5;
  const code = `AG-${String(n).padStart(4, '0')}`;
  await ctx.db.query(
    `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
     VALUES ($1, 'Holder Of The Clashing Code', 'manual', 'Approved', TRUE)`, [code]);
  await ctx.db.query(
    `INSERT INTO number_sequences (key, next_value) VALUES ('agent', $1)
     ON CONFLICT (key) DO UPDATE SET next_value = EXCLUDED.next_value`, [n]);
  return code;
}

describe('a referrer correction when the agent counter has fallen behind', () => {
  it('approves, instead of dying with Internal server error', async () => {
    const a = await admin();
    const taken = await makeCounterCollide();

    const cust = await a.post('/api/customers', { full_name: 'Referrer Clash Cust', phone: '9846900001' });
    const id = Number(cust.json.id);

    const req = await a.post(`/api/customers/${id}/correction-request`, {
      changes: { referred_by_text: 'Someone Entirely New / Partner' },
      reason: 'Referrer name changed by the branch.',
    });
    expect(req.status, JSON.stringify(req.json)).toBe(201);

    // THE REGRESSION: this returned 500 before the fix.
    const approve = await a.post(`/api/approvals/${req.json.request.id}/approve`, SELF_APPROVE);
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);

    // The correction applied...
    const row = (await ctx.db.query<{ referred_by_text: string }>(
      'SELECT referred_by_text FROM customers WHERE id = $1', [id])).rows[0]!;
    expect(row.referred_by_text).toBe('Someone Entirely New / Partner');

    // ...and the agent was created, on a code that is NOT the taken one.
    const agent = (await ctx.db.query<{ agent_code: string; commission_status: string; is_active: boolean }>(
      "SELECT agent_code, commission_status, is_active FROM agents WHERE lower(full_name) = lower('Someone Entirely New / Partner')")).rows[0];
    expect(agent, 'an agent should have been created for the new name').toBeTruthy();
    expect(agent!.agent_code).not.toBe(taken);
    expect(agent!.commission_status).toBe('PendingApproval');
    expect(agent!.is_active).toBe(false);
  });

  it('raises an agent_registration approval for the new name', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Referrer Appr Cust', phone: '9846900002' });
    const id = Number(cust.json.id);
    const req = await a.post(`/api/customers/${id}/correction-request`, {
      changes: { referred_by_text: 'Brand New Referrer Person' },
      reason: 'Referrer name supplied by the branch.',
    });
    await a.post(`/api/approvals/${req.json.request.id}/approve`, SELF_APPROVE);

    const agent = (await ctx.db.query<{ id: string }>(
      "SELECT id FROM agents WHERE lower(full_name) = lower('Brand New Referrer Person')")).rows[0]!;
    const appr = (await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM approval_requests
        WHERE request_type = 'agent_registration' AND entity_id = $1`, [Number(agent.id)])).rows[0]!;
    expect(Number(appr.n)).toBe(1);
  });

  it('a referrer that already exists creates no second agent', async () => {
    const a = await admin();
    const before = (await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM agents')).rows[0]!;
    const cust = await a.post('/api/customers', { full_name: 'Referrer Known Cust', phone: '9846900003' });
    const id = Number(cust.json.id);
    const req = await a.post(`/api/customers/${id}/correction-request`, {
      changes: { referred_by_text: 'Holder Of The Clashing Code' },
      reason: 'Existing agent, named properly.',
    });
    expect((await a.post(`/api/approvals/${req.json.request.id}/approve`, SELF_APPROVE)).status).toBe(200);
    const after = (await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM agents')).rows[0]!;
    expect(Number(after.n)).toBe(Number(before.n));
  });
});

describe('the code allocator', () => {
  it('skips codes already in use rather than throwing', async () => {
    const { nextFreeAgentCode } = await import('../src/modules/agents/service.js');
    const taken = await makeCounterCollide();
    const code = await ctx.db.withTx((tx) => nextFreeAgentCode(tx));
    expect(code).not.toBe(taken);
    expect(code).toMatch(/^AG-\d{4}$/);
    const clash = await ctx.db.query('SELECT 1 FROM agents WHERE agent_code = $1', [code]);
    expect(clash.rows.length, 'the allocated code must be free').toBe(0);
  });
});
