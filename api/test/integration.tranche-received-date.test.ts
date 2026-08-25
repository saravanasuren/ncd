/**
 * A clubbed investment's tranches arrive on different days; each earns its FIRST
 * (broken) period from ITS OWN money-received date, not the application's single
 * interest_start_date (owner 2026-08-25). So in the first batch the credits show
 * separately with different day counts, and a later credit is not over-paid for
 * days before its money was in. 🔒 interest-logic-locked — this pins the day
 * counts. A single-tranche investment is unchanged (line date == start date).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';
import { roundRupee } from '../src/lib/dates.js';

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
const RATE = 12, DENOM = 365;

describe('first-batch payout accrues each tranche from its own received date', () => {
  it('gives a later credit fewer days than an earlier one, each from its own date', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Own Date', phone: '9704000001' });
    // Tranche 1 on the 5th; club tranche 2 on the 20th while still in-flight (so
    // both materialise as lines of one investment). interest_start_date = the 5th.
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.json.clubbed).toBe(true);
    await approveInvestment(await as('ncd@demo.local'), first);

    const lines = (await ctx.db.query(
      'SELECT id, date_money_received FROM application_lines WHERE application_id = $1 ORDER BY date_money_received', [appId])).rows as any[];
    expect(lines).toHaveLength(2);
    const early = Number(lines[0].id);   // 2026-07-05
    const late = Number(lines[1].id);    // 2026-07-20

    // First cut-off: both tranches are in their own broken period → two rows.
    const p = (await a.get('/api/payouts/preview?date=2026-07-28')).json;
    const rows = (p.rows as any[]).filter((r) => Number(r.application_id) === appId);
    expect(rows).toHaveLength(2);
    const rEarly = rows.find((r) => Number(r.line_id) === early)!;
    const rLate = rows.find((r) => Number(r.line_id) === late)!;

    // Each from its OWN date: 5th → 28th = 23 days (+1 first-period) = 24;
    // 20th → 28th = 8 (+1) = 9. Before the fix BOTH counted from the 5th (24).
    expect(Number(rEarly.days)).toBe(24);
    expect(Number(rLate.days)).toBe(9);
    expect(String(rEarly.from_date).slice(0, 10)).toBe('2026-07-05');
    expect(String(rLate.from_date).slice(0, 10)).toBe('2026-07-20');

    // Gross matches the per-tranche formula on its own days.
    expect(Number(rEarly.gross_amount)).toBe(roundRupee((100000 * RATE) / 100 * 24 / DENOM));
    expect(Number(rLate.gross_amount)).toBe(roundRupee((100000 * RATE) / 100 * 9 / DENOM));
    expect(Number(rLate.gross_amount)).toBeLessThan(Number(rEarly.gross_amount));
  });

  it('leaves a single-tranche investment counting from its own (== start) date', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Solo Date', phone: '9704000002' });
    const solo = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), solo);
    const rows = ((await a.get('/api/payouts/preview?date=2026-07-28')).json.rows as any[])
      .filter((r) => Number(r.application_id) === Number(solo.json.id));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.days)).toBe(24);   // 5th → 28th + 1, unchanged
    expect(Number(rows[0]!.gross_amount)).toBe(roundRupee((100000 * RATE) / 100 * 24 / DENOM));
  });
});
