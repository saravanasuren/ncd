/**
 * Enroller performance — the staff/agent detail opened from universal search.
 * Sums the customers + investments a branch-staff user (or agent) sourced, the
 * money they brought in, and their incentive ledger. Management-only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, staffId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  staffId = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'staff@demo.local'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('enroller performance (staff/agent detail)', () => {
  it('summarises a staff member’s sourced customers, investments and incentives', async () => {
    // Branch staff enrols a customer + an investment (attributed to them), then
    // it's approved to Active.
    const staff = await as('staff@demo.local');
    const cust = await staff.post('/api/customers', { full_name: 'Perf Cust', phone: '9770000001' });
    expect(cust.status).toBe(201);
    const app = await staff.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 300000, date_money_received: '2026-07-12' });
    expect(app.status).toBe(201);
    await approveInvestment(await as('ncd@demo.local'), app);

    const r = await (await admin()).get(`/api/dashboard/person/staff/${staffId}`);
    expect(r.status).toBe(200);
    expect(r.json.person.type).toBe('staff');
    expect(r.json.person.id).toBe(staffId);
    expect(r.json.kpis.customers).toBeGreaterThanOrEqual(1);
    expect(r.json.kpis.investments).toBeGreaterThanOrEqual(1);
    expect(r.json.kpis.live_investments).toBeGreaterThanOrEqual(1);
    expect(Number(r.json.kpis.invested)).toBeGreaterThanOrEqual(300000);
    expect(r.json.investments.some((x: any) => x.id === app.json.id)).toBe(true);
    expect(r.json.incentives).toHaveProperty('balance');
  });

  it('counts investments migrated with no enroller of their own (via the customer’s enroller)', async () => {
    const staff = await as('staff@demo.local');
    const cust = await staff.post('/api/customers', { full_name: 'Migrated Cust', phone: '9770000002' });
    const app = await staff.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000, date_money_received: '2026-07-12' });
    // Simulate a wealth-migrated investment: enroller stripped from the app,
    // kept only on the customer (real prod state for imported investments).
    await ctx.db.query('UPDATE applications SET enrolled_by_user_id = NULL, enrolled_by_agent_id = NULL WHERE id = $1', [app.json.id]);

    const r = await (await admin()).get(`/api/dashboard/person/staff/${staffId}`);
    expect(r.status).toBe(200);
    expect(r.json.investments.some((x: any) => x.id === app.json.id)).toBe(true); // still attributed
  });

  it('is management-only — a branch staff cannot open it', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.get(`/api/dashboard/person/staff/${staffId}`)).status).toBe(403);
  });

  it('404s an unknown person', async () => {
    const a = await admin();
    expect((await a.get('/api/dashboard/person/agent/999999')).status).toBe(404);
  });
});
