/**
 * Club a new credit into an ALREADY-ACTIVE investment (owner 2026-08-24). Allowed
 * only while no interest has been paid. The schedule is rebuilt so each tranche
 * gets its OWN broken first period from its money-received date, the tranches
 * combine from the next batch, and they mature together (deemed date + tenure).
 *
 * Interest logic is LOCKED — this pins that the added tranche's broken period is
 * SMALLER (fewer days) than the earlier tranche's, and the maturity is shared.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number; let schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('clubbing into an active investment', () => {
  it('rebuilds the schedule with a per-tranche broken period and a shared maturity', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Club Active', phone: '9701230001' });
    // First tranche: money in on the 10th → activate so a schedule exists.
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-10',
    });
    await approveInvestment(await as('ncd@demo.local'), first);
    const appId = Number(first.json.id);
    expect((await ctx.db.query("SELECT status FROM applications WHERE id=$1", [appId])).rows[0]!.status).toBe('Active');

    // It shows as a clubbing candidate now (Active, unpaid).
    const cands = await a.get(`/api/applications/clubbing-candidates?customer_id=${cust.json.id}&series_id=${seriesId}`);
    expect(cands.json.rows.some((r: any) => Number(r.id) === appId)).toBe(true);

    // Second tranche, SAME amount, later date (the 20th) → clubbed into the active one.
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.status).toBe(201);
    expect(club.json.clubbed).toBe(true);
    expect(club.json.id).toBe(appId);

    // Two tranches, total doubled.
    const lines = (await ctx.db.query('SELECT id, date_money_received FROM application_lines WHERE application_id=$1 ORDER BY id', [appId])).rows as any[];
    expect(lines).toHaveLength(2);
    expect(Number((await ctx.db.query('SELECT total_amount FROM applications WHERE id=$1', [appId])).rows[0]!.total_amount)).toBe(200000);

    // Each line's FIRST interest period is a broken one (fewer days than a full
    // month). Same amount, but the LATER tranche's first period is smaller — it
    // ran from the 20th, not the 10th — proving per-tranche start dates.
    const firstInterest = async (lineId: number) => Number((await ctx.db.query(
      "SELECT gross_amount FROM disbursement_schedule WHERE line_id=$1 AND due_type='Interest' ORDER BY due_date LIMIT 1", [lineId])).rows[0]?.gross_amount ?? 0);
    const g0 = await firstInterest(Number(lines[0].id)); // 10th
    const g1 = await firstInterest(Number(lines[1].id)); // 20th (later → fewer days)
    expect(g0).toBeGreaterThan(0);
    expect(g1).toBeGreaterThan(0);
    expect(g1).toBeLessThan(g0);

    // They mature TOGETHER (deemed date + tenure), one shared maturity.
    const mat = async (lineId: number) => (await ctx.db.query(
      "SELECT due_date FROM disbursement_schedule WHERE line_id=$1 AND due_type='Redemption' LIMIT 1", [lineId])).rows[0]?.due_date;
    expect(String(await mat(Number(lines[0].id)))).toBe(String(await mat(Number(lines[1].id))));
  });

  it('refuses once an interest payout has been made', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Club Paid', phone: '9701230002' });
    const inv = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-10',
    });
    await approveInvestment(await as('ncd@demo.local'), inv);
    const appId = Number(inv.json.id);
    // Mark one interest row Paid → clubbing must now be refused.
    await ctx.db.query("UPDATE disbursement_schedule SET status='Paid' WHERE application_id=$1 AND due_type IN ('Interest','BrokenInterest') AND id = (SELECT id FROM disbursement_schedule WHERE application_id=$1 ORDER BY due_date LIMIT 1)", [appId]);

    const cands = await a.get(`/api/applications/clubbing-candidates?customer_id=${cust.json.id}&series_id=${seriesId}`);
    expect(cands.json.rows.some((r: any) => Number(r.id) === appId)).toBe(false); // no longer a candidate
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 50000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.status).toBe(409);
  });
});
