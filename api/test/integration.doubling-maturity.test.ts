/**
 * A Doubling holding redeemed AT MATURITY must be paid its interest.
 *
 * The bug this pins: createRequest read `: { gross: 0 }` for every maturity
 * redemption. Right for a periodic holding — its interest was paid monthly and
 * the stub is already on the schedule — and catastrophic for a cumulative one,
 * whose ENTIRE interest falls due exactly there.
 *
 * It left a cliff a day wide. On APP-2026-001274's Rs 21,00,000 the premature path
 * (which has always accrued from interest_start_date) paid Rs 42,02,301 on
 * 30-Aug-2031, and the maturity path paid Rs 21,00,000 on 31-Aug-2031 — the
 * normal thing to do, and the wrong half.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // The real Doubling series carries its deemed date; the demo one must too,
  // because the term is measured from it.
  await ctx.db.query("UPDATE series SET deemed_date = DATE '2026-08-31' WHERE id = $1", [seriesId]);
});
afterAll(async () => { await ctx.close(); });

/** An Active investment, optionally turned into a cumulative Doubling line. */
async function investment(holder: string, phone: string, amount: number, cumulative: boolean) {
  const cust = await admin.post('/api/customers', { full_name: holder, phone });
  const cid = Number(cust.json.id);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-08-29',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  await approveInvestment(checker, app);
  const appId = Number(app.json.id);
  if (cumulative) {
    await ctx.db.query(
      `UPDATE application_lines SET payout_frequency = 'AtMaturity', coupon_rate_pct = 20,
              tenure_months = 60, day_count_convention = 'Actual365',
              date_money_received = DATE '2026-08-29'
        WHERE application_id = $1`, [appId]);
    await ctx.db.query("UPDATE applications SET interest_start_date = DATE '2026-08-29' WHERE id = $1", [appId]);
  }
  return appId;
}

const redemption = async (appId: number) => (await ctx.db.query(
  `SELECT principal, broken_interest, broken_tds, net_payment, type
     FROM redemptions WHERE application_id = $1 ORDER BY id DESC LIMIT 1`, [appId])).rows[0] as any;

describe('a Doubling holding redeemed at maturity', () => {
  it('is paid its whole interest, not just its principal back', async () => {
    const appId = await investment('Holder Doubling', '9765000001', 2100000, true);
    const r = await checker.post('/api/redemptions/maturity', { application_id: appId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);

    const row = await redemption(appId);
    expect(Number(row.principal)).toBe(2100000);
    // 100% of the term + 2 days before the deemed date, to the rupee.
    expect(Number(row.broken_interest)).toBe(2102301);
    // The thing that was broken: this was 0.
    expect(Number(row.broken_interest)).toBeGreaterThan(0);
  });

  it('deducts TDS on it, because it is interest', async () => {
    const appId = await investment('Holder Taxed', '9765000002', 2100000, true);
    await checker.post('/api/redemptions/maturity', { application_id: appId });
    const row = await redemption(appId);
    expect(Number(row.broken_tds)).toBeGreaterThan(0);
  });

  it('closes the cliff — maturity and the day before now agree', async () => {
    // Redeeming one day early used to pay double and redeeming on the day
    // paid half. They must land within a day's interest of each other.
    const atMaturity = await investment('Holder OnTheDay', '9765000003', 2100000, true);
    await checker.post('/api/redemptions/maturity', { application_id: atMaturity });
    const onDay = Number((await redemption(atMaturity)).broken_interest);

    const early = await investment('Holder DayBefore', '9765000004', 2100000, true);
    const p = await checker.post('/api/redemptions/premature', {
      application_id: early, reason: 'Redeeming a day early', holding_mode: 'Demat',
      redemption_date: '2031-08-30',
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const dayBefore = Number((await redemption(early)).broken_interest);

    const oneDay = 2100000 * 0.20 / 365;
    expect(Math.abs(onDay - dayBefore)).toBeLessThan(oneDay * 2);
  });
});

describe('every other holding is untouched', () => {
  it('a Monthly line at maturity still accrues nothing here', async () => {
    // Its interest was paid month by month, and the stub to the maturity date
    // is a BrokenInterest row on the schedule — not this field. If this ever
    // becomes non-zero the book is paying twice.
    const appId = await investment('Holder Monthly', '9765000005', 2100000, false);
    const r = await checker.post('/api/redemptions/maturity', { application_id: appId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(Number((await redemption(appId)).broken_interest)).toBe(0);
  });
});
