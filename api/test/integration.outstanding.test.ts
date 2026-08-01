/**
 * The outstanding worklist (owner 2026-08-01) — everything started but not
 * finished, in one place.
 *
 * Each item already exists on some screen. The failure this guards against is
 * not a wrong figure but an item nobody happens to open: a part payment never
 * clubbed, a cheque never chased, a cleared cheque whose locker leg never
 * settled. So the tests are all "does it actually SURFACE this", plus the one
 * distinction that would send a checker to a button that refuses them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
const login = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => login('admin@dhanam.finance', 'ChangeMe_Dev_123');
const seriesId = () => ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'").then((r: any) => Number(r.rows[0].id));
const schemeId = () => ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'").then((r: any) => Number(r.rows[0].id));

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function customer(staff: Client, phone: string) {
  const c = await staff.post('/api/customers', { full_name: uniqueName('Outstanding Cust', phone), phone });
  return Number(c.json.id);
}
const list = async (staff: Client, customerId?: number) =>
  (await staff.get(`/api/reports/outstanding${customerId ? `?customer_id=${customerId}` : ''}`)).json.rows as any[];

describe('outstanding worklist', () => {
  it('surfaces a part payment, and says how much more it needs', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9898000001');
    const app = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 60000,
    });

    const row = (await list(staff, cid)).find((r) => r.reference === app.json.application_no);
    expect(row?.kind).toBe('part_payment');
    // The shortfall is the actionable bit — "needs ₹40,000 more".
    expect(row.detail).toContain('40,000');
    expect(Number(row.amount)).toBe(60000);
  });

  it('a whole-unit investment shows as awaiting approval, NOT as a part payment', async () => {
    // The distinction matters: a part payment CANNOT be approved yet, so
    // listing it under "awaiting approval" sends a checker to a button that
    // will refuse them.
    const staff = await admin();
    const cid = await customer(staff, '9898000002');
    const app = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 300000,
    });

    const row = (await list(staff, cid)).find((r) => r.reference === app.json.application_no);
    expect(row?.kind).toBe('awaiting_approval');
  });

  it('drops off the list once it goes live', async () => {
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9898000003');
    const app = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 200000,
    });
    expect((await list(staff, cid)).some((r) => r.reference === app.json.application_no)).toBe(true);

    await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);

    expect((await list(staff, cid)).some((r) => r.reference === app.json.application_no)).toBe(false);
  });

  it('surfaces an uncleared cheque, and a cleared one whose settlement failed', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9898000004');
    // Two cheques written straight to the register: one still pending, one
    // cleared on our side but never accepted by LockerHub — the case the
    // cheque code itself calls "exactly the thing that otherwise goes
    // unnoticed", because the locker will never allot.
    await ctx.db.query(
      `INSERT INTO locker_cheques (lockerhub_application_id, customer_id, leg, amount, cheque_no, bank_name, received_on, status)
       VALUES ('la_out_1', $1, 'rent', 3540, 'CHQ-PENDING', 'SBI', '2026-06-01', 'Pending')`, [cid]);
    await ctx.db.query(
      `INSERT INTO locker_cheques (lockerhub_application_id, customer_id, leg, amount, cheque_no, bank_name, received_on, status, cleared_on, lockerhub_error)
       VALUES ('la_out_2', $1, 'deposit', 25000, 'CHQ-STUCK', 'SBI', '2026-06-02', 'Cleared', '2026-06-10', 'upstream 409 obligations_pending')`, [cid]);

    const rows = await list(staff, cid);
    const pending = rows.find((r) => r.reference.startsWith('CHQ-PENDING'));
    const stuck = rows.find((r) => r.reference.startsWith('CHQ-STUCK'));

    expect(pending?.kind).toBe('cheque_uncleared');
    expect(stuck?.kind).toBe('cheque_settle_failed');
    // The upstream reason is carried through — without it there is nothing to act on.
    expect(stuck.detail).toContain('obligations_pending');
    // Age is measured from CLEARING for a stuck one, not from when it was taken.
    expect(stuck.since).toBe('2026-06-10');
  });

  it('a cleared-and-settled cheque is finished, so it is not listed', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9898000005');
    await ctx.db.query(
      `INSERT INTO locker_cheques (lockerhub_application_id, customer_id, leg, amount, cheque_no, received_on, status, cleared_on, lockerhub_settled_at)
       VALUES ('la_out_3', $1, 'rent', 3540, 'CHQ-DONE', '2026-06-01', 'Cleared', '2026-06-05', now())`, [cid]);
    expect((await list(staff, cid)).some((r) => r.reference.startsWith('CHQ-DONE'))).toBe(false);
  });

  it('is oldest-first — the top of the list is where the risk is', async () => {
    const staff = await admin();
    const rows = await list(staff);
    const ages = rows.map((r) => r.age_days ?? 0);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  });

  it('an agent cannot read the whole book through it', async () => {
    // Same scoping as every other application view — an agent sees their own.
    const agent = await login('agent@demo.local');
    const r = await agent.get('/api/reports/outstanding');
    expect(r.status).toBe(200);
    const staffRows = await list(await admin());
    expect(r.json.rows.length).toBeLessThan(staffRows.length);
  });
});
