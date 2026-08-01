/**
 * Part payments (owner 2026-08-01). Money arrives in instalments — ₹50,000 now,
 * ₹50,000 next week — and is clubbed into one ₹1,00,000 investment. Staff must
 * be able to record what the bank statement actually shows.
 *
 * The denomination rule is NOT relaxed, only MOVED. The property that matters,
 * and the reason this file exists: a part payment can be RECORDED but can never
 * GO LIVE. Approval is what starts interest, so if an odd total could be
 * approved the book would pay interest on a non-existent NCD unit. Every test
 * below is really guarding that one line.
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
  const c = await staff.post('/api/customers', { full_name: uniqueName('Part Cust', phone), phone });
  return Number(c.json.id);
}

describe('part payments', () => {
  it('records a below-₹1L credit instead of refusing it at the door', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9896000001');
    const r = await staff.post('/api/applications', {
      ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 50000,
    });
    expect(r.status).toBe(201);
    // Recorded, but NOT live — it sits awaiting approval like any other.
    const st = (await ctx.db.query('SELECT status, total_amount FROM applications WHERE id = $1', [Number(r.json.id)])).rows[0] as any;
    expect(st.status).toBe('PendingApproval');
    expect(Number(st.total_amount)).toBe(50000);
  });

  it('REFUSES to approve a part payment — it must not go live or earn interest', async () => {
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9896000002');
    const app = await staff.post('/api/applications', {
      ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 50000,
    });

    const blocked = await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect(blocked.status).toBe(400);
    // Either refusal is correct and both name the unit: ₹50,000 trips "below
    // the minimum", ₹1,50,000 would trip "not a whole multiple". What matters
    // is that it is refused and says why in rupees the operator recognises.
    expect(blocked.json.error.message).toMatch(/₹1,00,000/);
    // Still pending — a refused approval must not half-apply.
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(app.json.id)])).rows[0].status).toBe('PendingApproval');
    // And nothing was scheduled, so nothing can be paid on it.
    const sched = (await ctx.db.query('SELECT count(*)::int AS n FROM disbursement_schedule WHERE application_id = $1', [Number(app.json.id)])).rows[0] as any;
    expect(Number(sched.n)).toBe(0);
  });

  it('two halves club into one whole unit, which then approves and goes live', async () => {
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9896000003');
    const sid = await seriesId();
    const schId = await schemeId();

    const first = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 50000,
    });
    const appId = Number(first.json.id);

    // The second credit is clubbed onto the first — one investment, two lines.
    const second = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 50000,
      club_with_application_id: appId,
    });
    expect(second.json.clubbed).toBe(true);
    expect(second.json.id).toBe(appId);

    const total = (await ctx.db.query('SELECT total_amount FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(Number(total.total_amount)).toBe(100000);

    // Now a whole unit → approval goes through and it goes live.
    const ok = await ncd.post(`/api/approvals/${first.json.subscription_request.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0].status).toBe('Active');
  });

  it('a part payment clubbed to a still-odd total STILL cannot be approved', async () => {
    // ₹50,000 + ₹30,000 = ₹80,000. Clubbing is not a way round the rule; only
    // reaching a whole unit is.
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9896000004');
    const sid = await seriesId();
    const schId = await schemeId();

    const first = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 50000,
    });
    await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 30000,
      club_with_application_id: Number(first.json.id),
    });

    const blocked = await ncd.post(`/api/approvals/${first.json.subscription_request.id}/approve`);
    expect(blocked.status).toBe(400);
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(first.json.id)])).rows[0].status).toBe('PendingApproval');
  });

  it('still refuses zero and negative amounts', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9896000005');
    const base = { ...requiredInvestmentFields(), customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId() };
    expect((await staff.post('/api/applications', { ...base, amount: 0 })).status).toBe(400);
    expect((await staff.post('/api/applications', { ...base, amount: -50000 })).status).toBe(400);
  });

  it('a whole unit still goes straight through, unchanged', async () => {
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9896000006');
    const app = await staff.post('/api/applications', {
      ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 500000,
    });
    expect(app.status).toBe(201);
    const ok = await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(app.json.id)])).rows[0].status).toBe('Active');
  });
});
