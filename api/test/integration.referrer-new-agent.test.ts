/**
 * Typing a referrer nobody has heard of registers them as an agent, awaiting
 * approval — from EVERY place a referrer can be typed.
 *
 * Owner, 2026-08-19: "IF I TYPE IN A FRESH AGENT WHO IS NOT IN OUR DB - THEN IT
 * SHOULD ACCEPT THEM AND CREATE THEM AS A AGENT UPON APPROVAL."
 *
 * The behaviour already existed on customer creation. It did NOT exist on the
 * investment approval screen or on a customer correction, both of which just
 * UPDATEd the text — so the same name produced an agent on one screen and
 * nothing on two others, and staff had no way to tell which was which. That
 * asymmetry is what these tests exist to prevent coming back.
 *
 * Nothing goes live either way: the agent is created PendingApproval + inactive,
 * with an agent_registration approval for a human to accept or reject.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const agentNamed = async (name: string) => (await ctx.db.query(
  'SELECT id, agent_code, commission_status, is_active FROM agents WHERE lower(btrim(full_name)) = lower($1)',
  [name])).rows[0];
const approvalFor = async (agentId: number) => (await ctx.db.query(
  `SELECT status, metadata FROM approval_requests
    WHERE request_type = 'agent_registration' AND entity_id = $1`, [String(agentId)])).rows[0];

describe('a fresh referrer becomes an agent awaiting approval', () => {
  it('from CUSTOMER CREATION — and lands PendingApproval, inactive', async () => {
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Ref Cust One', phone: '9000011101', referred_by_text: 'NIKIL KAARTHICK' });
    const ag = await agentNamed('NIKIL KAARTHICK');
    expect(ag).toBeTruthy();
    // Nothing goes live on typing — that is the whole point of "upon approval".
    expect(ag.commission_status).toBe('PendingApproval');
    expect(ag.is_active).toBe(false);
    const appr = await approvalFor(Number(ag.id));
    expect(appr?.status).toBe('Pending');
  });

  it('from an APPROVAL-TIME EDIT of the investment', async () => {
    const a = await admin();
    const c = await a.post('/api/customers', { full_name: 'Ref Cust Two', phone: '9000011102' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: c.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-08-01',
    });
    const res = await (await as('ncd@demo.local')).post(
      `/api/approvals/${app.json.subscription_request.id}/approve`,
      { extra: { edits: { referred_by_text: 'FRESH CHECKER AGENT' } } });
    expect(res.status).toBe(200);
    const ag = await agentNamed('FRESH CHECKER AGENT');
    expect(ag).toBeTruthy();
    expect(ag.is_active).toBe(false);
  });

  it('from a CUSTOMER CORRECTION', async () => {
    const a = await admin();
    const c = await a.post('/api/customers', { full_name: 'Ref Cust Three', phone: '9000011103' });
    const req = await a.post(`/api/customers/${c.json.id}/correction-request`, {
      changes: { referred_by_text: 'FRESH CORRECTION AGENT' }, reason: 'referrer was missed at enrolment',
    });
    const reqId = req.json.id ?? req.json.request?.id;
    await (await as('ncd@demo.local')).post(`/api/approvals/${reqId}/approve`, {});
    const ag = await agentNamed('FRESH CORRECTION AGENT');
    expect(ag).toBeTruthy();
    expect(ag.is_active).toBe(false);
  });
});

describe('what must NOT happen', () => {
  it('does not duplicate an agent who already exists', async () => {
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Ref Cust Four', phone: '9000011104', referred_by_text: 'NIKIL KAARTHICK' });
    const all = (await ctx.db.query(
      "SELECT id FROM agents WHERE lower(btrim(full_name)) = lower('NIKIL KAARTHICK')")).rows;
    expect(all.length).toBe(1);
  });

  it('matches case-insensitively, so one person is not registered twice', async () => {
    // The book carries "Yamini ma" AND "Yamini Ma" — the same person typed two
    // ways. They must collapse to one agent, not two.
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Ref Cust Five', phone: '9000011105', referred_by_text: 'Yamini ma' });
    await a.post('/api/customers', { full_name: 'Ref Cust Six', phone: '9000011106', referred_by_text: 'Yamini Ma' });
    const all = (await ctx.db.query(
      "SELECT id FROM agents WHERE lower(btrim(full_name)) = lower('Yamini ma')")).rows;
    expect(all.length).toBe(1);
  });

  it('creates nothing when the referrer is an EXISTING staff member', async () => {
    // Staff refer customers too. Registering them as an agent would give one
    // person two identities and split their business across both.
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Ref Cust Seven', phone: '9000011107', referred_by_text: 'Demo Branch Staff' });
    expect(await agentNamed('Demo Branch Staff')).toBeUndefined();
  });

  it('creates nothing for a blank referrer', async () => {
    const a = await admin();
    const before = (await ctx.db.query('SELECT count(*)::int AS n FROM agents')).rows[0]!.n;
    await a.post('/api/customers', { full_name: 'Ref Cust Eight', phone: '9000011108', referred_by_text: '   ' });
    const after = (await ctx.db.query('SELECT count(*)::int AS n FROM agents')).rows[0]!.n;
    expect(after).toBe(before);
  });
});
