/**
 * A referrer must read as a PERSON, never as a bare code.
 *
 * Owner 2026-10-09, looking at "New business by agent": "why am i seeing no
 * names and instead codes for some agents?" — four rows read DHN1185, DHN1163,
 * DHN1195, DHN1166. Those are staff CODES, and the enrol form stores the code.
 * The staff lateral requires `is_staff = TRUE`; these people have it FALSE, so
 * nothing matched and the report printed the raw text it was given.
 *
 * The fix resolves the name through a lateral WITHOUT the is_staff gate — and
 * ONLY for display. These tests therefore pin both halves: the name appears,
 * and the business does NOT move between Staff-wise and Agent-wise. Resolving
 * through `sref` instead would have shifted Rs 15.28 cr between two tiles,
 * which is an attribution change the owner did not ask for.
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

/** A user who carries a CODE and is or isn't flagged as staff. */
async function makeUser(code: string, fullName: string, isStaff: boolean, role = 'cxo') {
  const roleId = Number((await ctx.db.query('SELECT id FROM roles WHERE name = $1', [role])).rows[0]!.id);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, role_id, code, is_staff, is_active)
     VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
    [`${code.toLowerCase()}@demo.local`, fullName, roleId, code, isStaff]);
  return Number(rows[0]!.id);
}

/** Staff key in an investment for a customer that `refText` introduced. */
async function referredInvestment(a: Client, refText: string, name: string, phone: string, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone, referred_by_text: refText });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-10',
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return Number(create.json.id);
}

const groupsOf = async (a: Client, by: 'agent' | 'staff') => (await a.get(`/api/reports/segments/${by}`)).json.groups as any[];
const keys = (gs: any[]) => gs.map((g) => g.key);

describe('a referrer stored as a code reads as a name', () => {
  it('shows the person, not their code, when the user is not flagged staff', async () => {
    const a = await admin();
    await makeUser('DHN9001', 'Unflagged Person', false);
    await referredInvestment(a, 'DHN9001', 'Cust Code Ref', '9801000001', 400000);

    const agent = await groupsOf(a, 'agent');
    expect(keys(agent)).toContain('Unflagged Person');
    expect(keys(agent)).not.toContain('DHN9001');   // the bare code must be gone
    const g = agent.find((x) => x.key === 'Unflagged Person');
    expect(Number(g.outstanding)).toBe(400000);
  });

  it('does NOT move the business to Staff-wise — only the label changed', async () => {
    const a = await admin();
    // The same person's row is still agent-side, because `staff_ref` (is_staff)
    // is what splits the two tiles and nothing about it changed.
    expect(keys(await groupsOf(a, 'staff'))).not.toContain('Unflagged Person');
    expect(keys(await groupsOf(a, 'agent'))).toContain('Unflagged Person');
  });

  it('a properly flagged staff member still lands Staff-wise, by name', async () => {
    const a = await admin();
    await makeUser('DHN9002', 'Flagged Person', true);
    await referredInvestment(a, 'DHN9002', 'Cust Staff Ref', '9801000002', 500000);

    expect(keys(await groupsOf(a, 'staff'))).toContain('Flagged Person');
    expect(keys(await groupsOf(a, 'agent'))).not.toContain('Flagged Person');
    expect(keys(await groupsOf(a, 'agent'))).not.toContain('DHN9002');
  });

  it('an agent still wins over the un-flagged user lookup', async () => {
    const a = await admin();
    // Same text matches BOTH an agent row and a non-staff user. The agent is the
    // established answer, so it must keep winning — the new lookup is a last
    // resort, not a new precedence.
    await a.post('/api/agents', { full_name: 'The Agent Row', agent_code: 'DHN9003' });
    await makeUser('DHN9003-U', 'The User Row', false);
    await ctx.db.query("UPDATE users SET code = 'DHN9003' WHERE code = 'DHN9003-U'");
    await referredInvestment(a, 'DHN9003', 'Cust Both Ref', '9801000003', 600000);

    const agent = await groupsOf(a, 'agent');
    expect(keys(agent)).toContain('The Agent Row');
    expect(keys(agent)).not.toContain('The User Row');
  });

  it('a referrer matching nobody at all still shows its raw text', async () => {
    const a = await admin();
    await referredInvestment(a, 'Walk In Friend', 'Cust No Match', '9801000004', 700000);
    expect(keys(await groupsOf(a, 'agent'))).toContain('Walk In Friend');
  });

  it('two spellings of one person collapse into a single row once both resolve', async () => {
    const a = await admin();
    // The live shape: Gokul appeared twice — once as "Gokul" (raw text) and once
    // as "DHN1195" (his code). Both now resolve to the one name, so the dashboard
    // stops showing the same person on two lines.
    await makeUser('DHN9004', 'Twice Listed', false);
    await referredInvestment(a, 'DHN9004', 'Cust Via Code', '9801000005', 300000);
    await referredInvestment(a, 'Twice Listed', 'Cust Via Name', '9801000006', 200000);

    const rows = (await groupsOf(a, 'agent')).filter((g) => g.key === 'Twice Listed');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].outstanding)).toBe(500000);
  });
});
