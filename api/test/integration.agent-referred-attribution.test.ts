/**
 * An agent's page must count the business they REFERRED, not only what they
 * personally keyed in.
 *
 * Owner 2026-08-28, looking at Shivashanmugam: "im not seeing any details of the
 * agent? where are the customers they brought in". His page read 0 customers,
 * 0 investments and Rs 0 brought in — beside a correct Rs 8,10,000 of incentive.
 * All 39 investments (~Rs 4.05 crore) were there the whole time. The incentive
 * counted what he REFERRED (referred_by_text -> resolveReferrer); the page
 * counted what he ENROLLED (enrolled_by_agent_id). An agent who introduces
 * customers that office staff then key in enrols nothing, so the page was
 * structurally zero for every such agent.
 *
 * These tests pin the two halves that make the numbers agree, and the
 * precedence rule that stops the fix crediting the wrong person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const perf = async (a: Client, agentId: number) => (await a.get(`/api/dashboard/person/agent/${agentId}`)).json;

/** Staff enrol an investment for a customer the AGENT referred — the real shape. */
async function referredInvestment(a: Client, refText: string, name: string, phone: string, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone, referred_by_text: refText });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-10',
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return { custId: Number(cust.json.id), appId: Number(create.json.id) };
}

describe("an agent's page counts what they referred", () => {
  it('business the agent referred but staff keyed in now shows up', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Referring Agent', agent_code: 'AG-REF-1' });
    const agentId = Number(ag.json.id);

    // Before: nothing at all.
    const before = await perf(a, agentId);
    expect(before.kpis.customers).toBe(0);
    expect(before.kpis.investments).toBe(0);

    // Two investments introduced by the agent, entered by the admin — the agent
    // never touches the keyboard, so enrolled_by_agent_id stays null.
    await referredInvestment(a, 'AG-REF-1', 'Ref Cust One', '9705000001', 200000);
    await referredInvestment(a, 'Referring Agent', 'Ref Cust Two', '9705000002', 300000);

    const after = await perf(a, agentId);
    expect(after.kpis.customers).toBe(2);
    expect(after.kpis.investments).toBe(2);
    expect(Number(after.kpis.invested)).toBe(500000);
    expect(after.investments).toHaveLength(2);
    // Confirm the enroller really was NOT the agent — otherwise this test would
    // pass for the wrong reason.
    const rows = (await ctx.db.query(
      'SELECT enrolled_by_agent_id FROM applications WHERE id = ANY($1)',
      [after.investments.map((i: any) => Number(i.id))])).rows as any[];
    expect(rows.every((r) => r.enrolled_by_agent_id === null)).toBe(true);
  });

  it('matches on the agent CODE and on the full NAME, either case', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Case Agent', agent_code: 'AG-CASE' });
    const agentId = Number(ag.json.id);
    await referredInvestment(a, 'ag-case', 'Case Cust One', '9705000011', 100000);   // lowercase code
    await referredInvestment(a, 'CASE AGENT', 'Case Cust Two', '9705000012', 100000); // uppercase name
    const p = await perf(a, agentId);
    expect(p.kpis.investments).toBe(2);
    expect(Number(p.kpis.invested)).toBe(200000);
  });

  it('does NOT claim business referred to somebody else', async () => {
    const a = await admin();
    const mine = await a.post('/api/agents', { full_name: 'Mine Agent', agent_code: 'AG-MINE' });
    const other = await a.post('/api/agents', { full_name: 'Other Agent', agent_code: 'AG-OTHER' });
    await referredInvestment(a, 'AG-OTHER', 'Other Cust', '9705000021', 400000);
    const p = await perf(a, Number(mine.json.id));
    expect(p.kpis.investments).toBe(0);
    expect(Number(p.kpis.invested)).toBe(0);
    const q = await perf(a, Number(other.json.id));
    expect(q.kpis.investments).toBe(1);
  });

  it('still counts what the agent DID enrol — the old route is not lost', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Enroller Agent', agent_code: 'AG-ENROL' });
    const agentId = Number(ag.json.id);
    const cust = await a.post('/api/customers', { full_name: 'Enrolled Cust', phone: '9705000031' });
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 150000, date_money_received: '2026-07-10',
    });
    await approveInvestment(await as('ncd@demo.local'), create);
    // Stamp the agent as the enroller, the way an agent-entered investment lands.
    await ctx.db.query('UPDATE applications SET enrolled_by_agent_id = $1 WHERE id = $2', [agentId, Number(create.json.id)]);
    await ctx.db.query('UPDATE customers SET enrolled_by_agent_id = $1 WHERE id = $2', [agentId, Number(cust.json.id)]);

    const p = await perf(a, agentId);
    expect(p.kpis.investments).toBe(1);
    expect(p.kpis.customers).toBe(1);
    expect(Number(p.kpis.invested)).toBe(150000);
  });

  it('counts an investment once when the agent both referred AND enrolled it', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Both Agent', agent_code: 'AG-BOTH' });
    const agentId = Number(ag.json.id);
    const { appId, custId } = await referredInvestment(a, 'AG-BOTH', 'Both Cust', '9705000041', 250000);
    await ctx.db.query('UPDATE applications SET enrolled_by_agent_id = $1 WHERE id = $2', [agentId, appId]);
    await ctx.db.query('UPDATE customers SET enrolled_by_agent_id = $1 WHERE id = $2', [agentId, custId]);

    const p = await perf(a, agentId);
    expect(p.kpis.investments).toBe(1);           // not 2
    expect(p.kpis.customers).toBe(1);             // not 2
    expect(Number(p.kpis.invested)).toBe(250000); // not 500000
  });
});
