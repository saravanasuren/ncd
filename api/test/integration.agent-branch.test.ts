/**
 * An agent can be attributed to a branch (owner 2026-08-19: "make raju p
 * investments come in hosur branch").
 *
 * Until now branch attribution was: the referrer's branch if they are STAFF,
 * else HO — "which is where agent relationships sit". There was no way to say a
 * particular agent's business belongs to a particular branch, because the agents
 * table had no branch column at all.
 *
 * The HO default is UNCHANGED and is what these tests mostly protect: an agent
 * with no branch set must still land on HO, so nobody else's attribution moves
 * because this column now exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { branchForReferrer } from '../src/modules/applications/branch.js';

let ctx: TestCtx;
let hosurId: number, hoId: number, seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  hoId = Number((await ctx.db.query("SELECT id FROM branches WHERE upper(btrim(code)) = 'HO'")).rows[0]!.id);
  hosurId = Number((await ctx.db.query(
    "INSERT INTO branches (code, name) VALUES ('Hosur','Hosur') ON CONFLICT DO NOTHING RETURNING id")).rows[0]?.id
    ?? (await ctx.db.query("SELECT id FROM branches WHERE code = 'Hosur'")).rows[0]!.id);
  await ctx.db.query(
    `INSERT INTO agents (agent_code, full_name, is_active) VALUES ('RAJU-P','RAJU P',TRUE)
     ON CONFLICT DO NOTHING`);
  await ctx.db.query(
    `INSERT INTO agents (agent_code, full_name, is_active) VALUES ('NOBRANCH','No Branch Agent',TRUE)
     ON CONFLICT DO NOTHING`);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const setBranch = async (code: string, branchId: number | null) => {
  const id = Number((await ctx.db.query('SELECT id FROM agents WHERE agent_code = $1', [code])).rows[0]!.id);
  await (await admin()).put(`/api/agents/${id}`, { branch_id: branchId });
  return id;
};

describe('agent branch attribution', () => {
  it('an agent with NO branch still counts under HO — the default is untouched', async () => {
    // The most important case here. This column existing must not move anyone.
    expect(await branchForReferrer(ctx.db, 'NOBRANCH')).toBe(hoId);
    expect(await branchForReferrer(ctx.db, 'No Branch Agent')).toBe(hoId);
  });

  it('sends an agent-referred investment to the agent\'s branch once set', async () => {
    await setBranch('RAJU-P', hosurId);
    // Both spellings on the book: the CODE and the NAME.
    expect(await branchForReferrer(ctx.db, 'RAJU-P')).toBe(hosurId);
    expect(await branchForReferrer(ctx.db, 'RAJU P')).toBe(hosurId);
    // Case and padding must not matter — the book carries both spellings.
    expect(await branchForReferrer(ctx.db, ' raju-p ')).toBe(hosurId);
  });

  it('stamps a NEW investment with that branch end to end', async () => {
    const a = await admin();
    const c = await a.post('/api/customers', {
      full_name: 'Raju Referred Cust', phone: '9000022201', referred_by_text: 'RAJU-P',
    });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: c.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-08-01',
    });
    const row = (await ctx.db.query('SELECT branch_id FROM applications WHERE id = $1', [app.json.id])).rows[0]!;
    expect(Number(row.branch_id)).toBe(hosurId);
  });

  it('clearing the branch puts them back on HO', async () => {
    await setBranch('RAJU-P', null);
    expect(await branchForReferrer(ctx.db, 'RAJU-P')).toBe(hoId);
    await setBranch('RAJU-P', hosurId);   // leave it as the owner wants it
  });

  it('STAFF still win over an agent on the same text', async () => {
    // A staff member's branch is their posting; an agent's is an attribution
    // choice. If both match, the posting decides — otherwise naming an agent
    // after a staff member would silently move that staff member's business.
    const staff = (await ctx.db.query(
      "SELECT id, full_name, branch_id FROM users WHERE is_staff = TRUE AND branch_id IS NOT NULL LIMIT 1")).rows[0];
    if (!staff) return;
    await ctx.db.query(
      "INSERT INTO agents (agent_code, full_name, is_active, branch_id) VALUES ('CLASH',$1,TRUE,$2) ON CONFLICT DO NOTHING",
      [staff.full_name, hosurId]);
    expect(await branchForReferrer(ctx.db, String(staff.full_name))).toBe(Number(staff.branch_id));
  });

  it('an unmatched referrer still counts under HO', async () => {
    expect(await branchForReferrer(ctx.db, 'NOBODY AT ALL')).toBe(hoId);
    expect(await branchForReferrer(ctx.db, '')).toBe(hoId);
    expect(await branchForReferrer(ctx.db, null)).toBe(hoId);
  });
});
