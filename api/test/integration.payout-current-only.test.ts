/**
 * The NEFT preview's "vs last batch" comparison shows CURRENT data (owner
 * 2026-08-27): a redemption slice's principal is LEAVING, so it's excluded from
 * the Outstanding figure and from the customer/investment counts — while still
 * being a paid row (in `count`, gross/TDS/net). This pins that the counts equal
 * the non-redemption sets and a fully-redeemed investment drops out of them.
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

describe('payout preview counts current data only', () => {
  it('excludes a fully-redeemed investment (slice only) from customers/investments/outstanding', async () => {
    const a = await admin();
    // A — a live, regular investment (stays current).
    const custA = await a.post('/api/customers', { full_name: 'Curr A', phone: '9709000001' });
    const appA = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custA.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-01',
    });
    await approveInvestment(await as('ncd@demo.local'), appA);

    // B — fully redeemed: zero its line and drop in a redemption slice
    // (BrokenInterest carrying a principal_basis) so B appears ONLY as a slice.
    const custB = await a.post('/api/customers', { full_name: 'Curr B', phone: '9709000002' });
    const appB = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custB.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 200000, date_money_received: '2026-07-01',
    });
    await approveInvestment(await as('ncd@demo.local'), appB);
    const lineB = Number((await ctx.db.query('SELECT id FROM application_lines WHERE application_id=$1', [appB.json.id])).rows[0]!.id);
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE id = $1", [lineB]);
    await ctx.db.query(
      "INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, principal_basis, status) VALUES ($1,$2,'2026-07-20','BrokenInterest',500,0,500,200000,'Scheduled')",
      [lineB, appB.json.id]);

    const p = (await a.get('/api/payouts/preview?date=2026-07-28')).json;
    const rows = p.rows as any[];

    // B's redemption slice IS a paid row in the batch…
    expect(rows.some((r) => Number(r.application_id) === Number(appB.json.id) && r.schedule_id)).toBe(true);

    // …but B (redemption-only) is NOT among the current customers/investments.
    const currentCust = new Set(rows.filter((r) => !r.schedule_id).map((r) => Number(r.customer_id)));
    const currentApp = new Set(rows.filter((r) => !r.schedule_id).map((r) => Number(r.application_id)));
    expect(currentCust.has(Number(custB.json.id))).toBe(false);
    expect(currentApp.has(Number(appB.json.id))).toBe(false);
    expect(currentApp.has(Number(appA.json.id))).toBe(true);   // A is current

    // The returned counts are exactly the current-only sets (the change).
    expect(p.customers).toBe(currentCust.size);
    expect(p.investments).toBe(currentApp.size);
  });
});
