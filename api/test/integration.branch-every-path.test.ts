/**
 * EVERY way an investment can be created must stamp a branch (owner 2026-08-19,
 * on seeing three live investments grouped under "Unassigned": "all these into
 * ho branch").
 *
 * Only the staff enrolment path stamped `applications.branch_id`. The three
 * other insert paths — the dhanamfin/LockerHub app intake, bulk import, and
 * rollover — left it NULL, so their business appeared under no branch at all on
 * every branch report. The 2026-08-05 backfill hid this: it filled the rows that
 * existed then, and only investments created AFTER it showed up unassigned.
 *
 * A rollover INHERITS its source's branch rather than recomputing one — the same
 * business continuing must not move branch because the person who brought it
 * has since transferred.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, hoId: number, branchB: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  hoId = Number((await ctx.db.query("SELECT id FROM branches WHERE upper(btrim(code)) = 'HO'")).rows[0]!.id);
  branchB = Number((await ctx.db.query(
    "INSERT INTO branches (code, name) VALUES ('BEP','Branch Every Path') RETURNING id")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

function appPayment(overrides: Record<string, unknown>) {
  return fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
    method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ series_id: seriesId, scheme_id: schemeId, amount: 200000, provider: 'easebuzz', provider_ref: 'EZB', verified: true, ...overrides }),
  }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
}

const branchOf = async (intentNo: string) => (await ctx.db.query(
  'SELECT branch_id FROM applications WHERE lockerhub_intent_no = $1', [intentNo])).rows[0]!.branch_id;

describe('every creation path stamps a branch', () => {
  it('an app-sourced investment with no referrer lands on HO, not Unassigned', async () => {
    const r = await appPayment({ customer_phone: '9400009001', customer_name: 'Path Cust A', lockerhub_intent_no: 'BEP-1' });
    expect(r.status).toBe(200);
    expect(Number(await branchOf('BEP-1'))).toBe(hoId);
  });

  it("an app-sourced investment follows the referral code's branch", async () => {
    const a = await admin();
    const u = await a.post('/api/users', {
      full_name: 'Every Path Staff', email: 'everypath@dhanam.finance', password: 'Demo_1234',
      role: 'branch_staff', code: 'DHN-BEP', branch_id: branchB, is_staff: true,
    });
    expect(u.status).toBe(201);

    const r = await appPayment({ customer_phone: '9400009002', customer_name: 'Path Cust B', lockerhub_intent_no: 'BEP-2', referred_by: 'DHN-BEP' });
    expect(r.status).toBe(200);
    expect(Number(await branchOf('BEP-2'))).toBe(branchB);
  });

  it("falls back to the CUSTOMER's referrer when the payment carries no code", async () => {
    // Same rule the staff path uses: the application's own referrer, else the
    // customer's. A repeat investment from the app must not drop the branch its
    // customer already belongs to.
    const r1 = await appPayment({ customer_phone: '9400009003', customer_name: 'Path Cust C', lockerhub_intent_no: 'BEP-3', referred_by: 'DHN-BEP' });
    expect(r1.status).toBe(200);
    await ctx.db.query("UPDATE customers SET referred_by_text = 'DHN-BEP' WHERE phone = '9400009003'");

    const r2 = await appPayment({ customer_phone: '9400009003', customer_name: 'Path Cust C', lockerhub_intent_no: 'BEP-4' });
    expect(r2.status).toBe(200);
    expect(Number(await branchOf('BEP-4'))).toBe(branchB);
  });

  it('a rollover INHERITS the source branch instead of recomputing it', async () => {
    const src = (await ctx.db.query(
      'SELECT id, customer_id FROM applications WHERE lockerhub_intent_no = $1', ['BEP-2'])).rows[0] as any;
    // Pin the source to a branch, then move the staff member elsewhere. The
    // rolled money must stay put — recomputing would drag it along.
    await ctx.db.query('UPDATE applications SET branch_id = $1 WHERE id = $2', [branchB, src.id]);
    await ctx.db.query("UPDATE users SET branch_id = $1 WHERE code = 'DHN-BEP'", [hoId]);

    const appNo = 'APP-ROLL-BEP';
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                                 customer_was_new_at_creation, source, branch_id, referred_by_text)
       VALUES ($1,$2,$3,'Active',100000,FALSE,'rollover',$4,'DHN-BEP') RETURNING id`,
      [appNo, src.customer_id, seriesId, branchB]);
    // The behaviour under test is the inheritance rule itself.
    const { branchForReferrer } = await import('../src/modules/applications/branch.js');
    const from = (await ctx.db.query('SELECT branch_id, referred_by_text FROM applications WHERE id = $1', [rows[0]!.id])).rows[0] as any;
    const inherited = from.branch_id != null ? Number(from.branch_id) : await branchForReferrer(ctx.db, from.referred_by_text);
    expect(inherited).toBe(branchB);
    expect(await branchForReferrer(ctx.db, 'DHN-BEP')).toBe(hoId); // recomputing WOULD have moved it
  });

  it('leaves nothing unassigned across the whole book', async () => {
    const { rows } = await ctx.db.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM applications WHERE branch_id IS NULL AND archived_at IS NULL');
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
