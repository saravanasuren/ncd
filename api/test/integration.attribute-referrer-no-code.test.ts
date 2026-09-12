/**
 * Assigning a staff/agent to an app investment that arrived with no referral
 * code (owner 2026-09-12: "why am i seeing invalid error").
 *
 * TWO bugs, and the second is the dangerous one.
 *
 * 1. The page posted the payee's CODE. 8 of 30 selectable staff have none, so
 *    it posted an empty string and `z.string().min(1)` rejected it — the
 *    operator saw "Invalid request" with no clue why, and the suggestion row
 *    looked identical to a working one because a null code renders as a gap.
 *
 * 2. Falling back to the NAME fixes seven of those eight and silently
 *    misattributes the eighth. `referred_by_text` is free text that the
 *    incentive engine re-resolves through resolveReferrer, which searches
 *    `agents` BEFORE `users` and takes LIMIT 1 — so a code-less staff member
 *    sharing a name with an agent resolves to the AGENT. Padhmanathan is
 *    exactly that on production: the screen would have said "Assigned" and the
 *    money would have gone to somebody else.
 *
 * So the assignment is verified against the row that was clicked, and a name
 * that cannot identify one person is refused with what to do about it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A live investment with NO referrer — the app-investment shape. */
async function investment(a: Client, name: string, phone: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `4141${phone}`, ifsc: 'ICIC0001111' });
  const series = (await a.get('/api/series')).json.rows[0];
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount: 200000, date_money_received: '2026-09-01',
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return Number(create.json.id);
}

const assign = (a: Client, appId: number, body: Record<string, unknown>) =>
  a.post(`/api/applications/${appId}/attribute-referrer`, body);

describe('assigning a payee who has no code', () => {
  it('the search says which table each row came from', async () => {
    // The page needs it to report an unambiguous pick: a user with an agent
    // ROLE is shown as an agent while its id is a users.id, so `kind` alone
    // cannot tell the server which record was clicked.
    const a = await admin();
    const rows = (await a.get('/api/agents/payee-search?q=demo')).json.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(['agents', 'users']).toContain(r.source);
  });

  it('assigns a CODE-LESS staff member by name — the case that failed', async () => {
    const a = await admin();
    // A staff user with no code at all, exactly like VIRGINBIVINA P.
    const u = (await ctx.db.query<{ id: string; full_name: string }>(
      `INSERT INTO users (email, full_name, password_hash, role_id, is_active, is_staff)
       VALUES ('nocode.payee@demo.local', 'Nocode Payee',
               (SELECT password_hash FROM users WHERE email = 'staff@demo.local'),
               (SELECT role_id FROM users WHERE email = 'staff@demo.local'), TRUE, TRUE)
       RETURNING id, full_name`)).rows[0]!;

    const appId = await investment(a, 'No Code Assign', '9565000001');
    const r = await assign(a, appId, { payee: u.full_name, payee_source: 'users', payee_id: Number(u.id) });
    expect(r.status).toBe(200);

    const app = (await ctx.db.query<{ referred_by_text: string }>(
      'SELECT referred_by_text FROM applications WHERE id = $1', [appId])).rows[0]!;
    expect(app.referred_by_text).toBe('Nocode Payee');
    // And the incentive actually landed on THEM, which is the point.
    const acc = (await ctx.db.query<{ payee_type: string; payee_id: string }>(
      `SELECT payee_type, payee_id FROM incentive_accruals
        WHERE application_id = $1 AND matrix_cell = 'referrer'`, [appId])).rows[0];
    expect(acc).toBeTruthy();
    expect(acc!.payee_type).toBe('staff');
    expect(Number(acc!.payee_id)).toBe(Number(u.id));
  });

  it('REFUSES a name that resolves to somebody else, instead of paying them', async () => {
    /**
     * Padhmanathan on production: a code-less staff member whose name is also
     * an agent's. resolveReferrer checks agents first, so the name would have
     * credited the agent while the screen said "Assigned".
     */
    const a = await admin();
    const shared = 'Shared Name Person';
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, is_active) VALUES ('AG-SHARED-1', $1, TRUE)`, [shared]);
    const staffUser = (await ctx.db.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, role_id, is_active, is_staff)
       VALUES ('shared.name@demo.local', $1,
               (SELECT password_hash FROM users WHERE email = 'staff@demo.local'),
               (SELECT role_id FROM users WHERE email = 'staff@demo.local'), TRUE, TRUE)
       RETURNING id`, [shared])).rows[0]!;

    const appId = await investment(a, 'Ambiguous Assign', '9565000002');
    const r = await assign(a, appId, { payee: shared, payee_source: 'users', payee_id: Number(staffUser.id) });
    expect(r.status).toBe(400);
    // The envelope is { error: { code, message } } — and note that the failure
    // the owner reported, "Invalid request", is the ZodError message from that
    // same handler, which is why it carried no hint about the cause.
    expect(r.json.error.code).toBe('BAD_REQUEST');
    expect(String(r.json.error.message)).toMatch(/not unique|resolves to/i);

    // Nothing was written — no half-done attribution left behind.
    const app = (await ctx.db.query<{ referred_by_text: string | null }>(
      'SELECT referred_by_text FROM applications WHERE id = $1', [appId])).rows[0]!;
    expect(app.referred_by_text ?? '').toBe('');
  });

  it('still rejects an empty payee', async () => {
    const a = await admin();
    const appId = await investment(a, 'Empty Assign', '9565000003');
    const r = await assign(a, appId, { payee: '' });
    expect(r.status).toBe(400);
    // This is the exact response the screen was showing for every code-less
    // staff member, because the page posted a null code.
    expect(r.json.error.message).toBe('Invalid request');
  });
});
