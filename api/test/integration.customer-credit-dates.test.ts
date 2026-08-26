/**
 * A clubbed debenture shows EVERY credit's date on the customer's profile.
 *
 * Owner 2026-08-26, in their words: customer A invests 50,000 today, 50,000
 * tomorrow and 1,00,000 the day after — those three are clubbed as ONE
 * debenture. All three dates must be captured, and on the customer page the
 * received-date area must show that it arrived on several dates, so it is
 * obvious this investment has tranches.
 *
 * The profile previously returned only the application's single
 * date_money_received, so the tranches were invisible there — the same blind
 * spot that let Mythili D's stale date go unnoticed on the payout sheet.
 *
 * The payout behaviour that goes with this (separate tranche rows in the FIRST
 * batch, folded into one line afterwards) is pinned by
 * integration.tranche-received-date.test.ts and
 * integration.payout-tranche-consolidation.test.ts.
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

describe("a clubbed debenture's credit dates on the customer profile", () => {
  it('reports all three dates and amounts, oldest first', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Tranche Dates A', phone: '9704200001' });
    const custId = Number(cust.json.id);

    // 50,000 on the 5th, 50,000 on the 6th, 1,00,000 on the 7th — one debenture.
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
      amount: 50000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    for (const [amount, date] of [[50000, '2026-07-06'], [100000, '2026-07-07']] as const) {
      const c = await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
        amount, date_money_received: date, club_with_application_id: appId,
      });
      expect(c.json.clubbed).toBe(true);
    }
    await approveInvestment(await as('ncd@demo.local'), first);

    const profile = await a.get(`/api/customers/${custId}`);
    expect(profile.status).toBe(200);
    const inv = (profile.json.applications as any[]).find((x) => Number(x.id) === appId)!;
    expect(inv).toBeDefined();

    // ONE debenture, three credits.
    expect(Number(inv.line_count)).toBe(3);
    expect(Number(inv.amount)).toBe(200000);

    // Every credit's own date and amount, oldest first — this is what the
    // received-date column renders.
    const credits = (inv.credits as any[]).map((c) => ({
      date: String(c.date).slice(0, 10), amount: Number(c.amount),
    }));
    expect(credits).toEqual([
      { date: '2026-07-05', amount: 50000 },
      { date: '2026-07-06', amount: 50000 },
      { date: '2026-07-07', amount: 100000 },
    ]);
  });

  it('a single-credit investment still reports exactly one date', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Tranche Dates B', phone: '9704200002' });
    const custId = Number(cust.json.id);
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), create);

    const profile = await a.get(`/api/customers/${custId}`);
    const inv = (profile.json.applications as any[]).find((x) => Number(x.id) === Number(create.json.id))!;
    expect(Number(inv.line_count)).toBe(1);
    expect((inv.credits as any[]).length).toBe(1);
    expect(String((inv.credits as any[])[0].date).slice(0, 10)).toBe('2026-07-05');
  });
});
