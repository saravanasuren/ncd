/**
 * An agent's own customer's investment must be attributed to that agent, even
 * when a staff member or admin records the application.
 *
 * The bug: createApplication set enrolled_by_agent_id = the acting user's agent
 * id, which is NULL for staff/admin — so a staff-booked investment for an
 * agent's customer had no agent, and the agent's scoped dashboard read ₹0.
 * The fix inherits the customer's agent when the actor isn't one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function bookAppFor(a: Client, customerId: number) {
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(),
    customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12',
  });
  expect(app.status).toBe(201);
  return Number(app.json.id);
}

describe('application agent attribution', () => {
  it("inherits the customer's agent when staff/admin books the investment", async () => {
    const a = await admin();
    const agentId = Number((await ctx.db.query(
      "INSERT INTO agents (agent_code, full_name, is_active) VALUES ('AG-ATTR1', 'Attr Agent', TRUE) RETURNING id")).rows[0]!.id);

    const cust = await a.post('/api/customers', { full_name: 'Agent Owned Cust', phone: '9846600001' });
    // Customer belongs to the agent (as if the agent enrolled them).
    await ctx.db.query('UPDATE customers SET enrolled_by_agent_id = $1 WHERE id = $2', [agentId, cust.json.id]);

    const appId = await bookAppFor(a, cust.json.id);
    const row = (await ctx.db.query('SELECT enrolled_by_agent_id FROM applications WHERE id = $1', [appId])).rows[0] as { enrolled_by_agent_id: string | null };
    expect(Number(row.enrolled_by_agent_id)).toBe(agentId);
  });

  it('leaves the agent NULL when the customer has no agent (no false attribution)', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Staff Owned Cust', phone: '9846600002' });
    const appId = await bookAppFor(a, cust.json.id);
    const row = (await ctx.db.query('SELECT enrolled_by_agent_id FROM applications WHERE id = $1', [appId])).rows[0] as { enrolled_by_agent_id: string | null };
    expect(row.enrolled_by_agent_id).toBeNull();
  });
});
