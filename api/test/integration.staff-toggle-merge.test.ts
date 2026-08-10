/**
 * Marking a user "staff" auto-folds any agent record they hold into their staff
 * identity (owner 2026-08-10) — so their incentive moves to the Staff side and
 * they stop showing as an agent, with no separate manual merge step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('marking a user staff auto-merges their agent record', () => {
  it('moves the agent incentive to the staff side and retires the agent row', async () => {
    const a = await admin();
    // An agent (createAgent also makes the paired login user).
    const ag = await a.post('/api/agents', { full_name: 'AutoMerge Tester' });
    const agentId = Number(ag.json.id);
    const shadowUserId = Number(ag.json.user_id);

    // Give the agent a real accrual on a real application.
    const cust = await a.post('/api/customers', { full_name: 'AM Cust', phone: '9846000111', pan: 'AMCUS1234A' });
    await a.post('/api/applications', {
      ...requiredInvestmentFields(),
      customer_id: Number(cust.json.id), series_id: seriesId, scheme_id: schemeId,
      amount: 100000, collection_reference: 'AM-1',
    });
    const appId = Number((await ctx.db.query('SELECT id FROM applications WHERE customer_id = $1 ORDER BY id DESC LIMIT 1', [Number(cust.json.id)])).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1, 'agent', $2, 'percent', 2, 5000, CURRENT_DATE)`, [appId, agentId]);

    // Mark the person staff (role + flag). This should auto-merge.
    const res = await a.put(`/api/users/${shadowUserId}`, {
      full_name: 'AutoMerge Tester', role: 'branch_staff', is_staff: true, is_active: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.agentMerged).toBeTruthy();
    expect(res.json.agentMerged.agent_code).toBe(ag.json.agent_code);
    expect(res.json.agentMergeSkipped).toBeNull();

    // The accrual is now on the staff side, keyed to the user.
    const acc = (await ctx.db.query('SELECT payee_type, payee_id FROM incentive_accruals WHERE application_id = $1 AND amount = 5000', [appId])).rows[0] as any;
    expect(acc.payee_type).toBe('staff');
    expect(Number(acc.payee_id)).toBe(shadowUserId);

    // The agent record is retired (soft-deleted), so they no longer double as an agent.
    const agRow = (await ctx.db.query('SELECT deleted_at FROM agents WHERE id = $1', [agentId])).rows[0] as any;
    expect(agRow.deleted_at).not.toBeNull();
  });

  it('does nothing (no error) when a staff user has no agent record', async () => {
    const a = await admin();
    const u = await a.post('/api/users', { full_name: 'Plain Staff', email: 'plainstaff@demo.local', password: 'Password1', role: 'branch_staff', is_staff: false });
    const uid = (await a.get('/api/users')).json.rows.find((x: any) => x.email === 'plainstaff@demo.local').id;
    const res = await a.put(`/api/users/${uid}`, { full_name: 'Plain Staff', role: 'branch_staff', is_staff: true, is_active: true });
    expect(res.status).toBe(200);
    expect(res.json.agentMerged).toBeNull();
    expect(res.json.agentMergeSkipped).toBeNull();
  });
});
