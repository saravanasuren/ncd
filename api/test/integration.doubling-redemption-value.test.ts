/**
 * What a Doubling certificate says the holder gets back.
 *
 * Owner 2026-11-17: "for investments in doubling scheme - the redemption amount
 * should be the double of the investment amount in the certificates. check it -
 * its now showing wrong datas." The row was hard-coded to the principal, so a
 * Rs 3,00,000 Doubling bond read Rs 3,00,000 back.
 *
 * PRINCIPAL + RATE x TERM, not a hard-coded 2x — the owner's choice when asked.
 * For Doubling the two agree exactly (20% for 60 months is 100%); for the
 * inactive CUMULATIVE scheme (15%, 36 months) they do not, and the fourth test
 * is what proves which rule is actually implemented.
 *
 * Nothing here touches the interest engine. These certificates read no schedule
 * and move no money — in production every Doubling line carries zero schedule
 * rows, so there is no stored figure for this to contradict.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { redemptionValue } from '../src/modules/reports/forms/bond.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

/** A scheme with an explicit rate, term and payout shape, plus a series. */
async function setup(tag: string, rate: number, tenure: number, freq: string, sub: boolean) {
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  const schemeId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING id`,
    [`SCH-${tag}`, `Plan ${tag}`, tenure, freq, rate, base.face_value, base.min_ticket,
     base.multiple_of, base.day_count_convention, base.commission_rule, base.tds_rule_id])).rows[0]!.id);
  const seriesId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,$2,'2026-10-31'::date,'2026-10-31'::date) RETURNING id`,
    [`SER-${tag}`, sub])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [seriesId, schemeId]);
  return { schemeId, seriesId };
}

async function holding(seriesId: number, schemeId: number, holder: string, phone: string, amount: number) {
  const cust = await admin.post('/api/customers', { full_name: holder, phone });
  expect(cust.status, JSON.stringify(cust.json)).toBe(201);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-10-05',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  await approveInvestment(checker, app);
  return { cid: Number(cust.json.id), appId: Number(app.json.id) };
}

const cert = async (cid: number, sid: number, template?: 'debenture') => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, template)));
};

describe('a Doubling holding', () => {
  it('says the holder gets DOUBLE back, on the Subordinate Bond certificate', async () => {
    const { seriesId, schemeId } = await setup('DBL1', 20, 60, 'AtMaturity', true);
    const { cid } = await holding(seriesId, schemeId, 'Holder Alpha', '9211100001', 300000);
    const t = await cert(cid, seriesId);
    expect(t).toContain('InvestmentValue(Rs.)Rs.3,00,000');
    expect(t).toContain('Rs.6,00,000');
  });

  it('says the same on the Debenture certificate — one holding, one figure', async () => {
    const { seriesId, schemeId } = await setup('DBL2', 20, 60, 'AtMaturity', true);
    const { cid } = await holding(seriesId, schemeId, 'Holder Beta', '9211100002', 300000);
    const t = await cert(cid, seriesId, 'debenture');
    expect(t).toContain('RedemptionValue(Rs.)Rs.6,00,000');
  });

  it('promises that same sum in the legal paragraph, and tells the truth about the interest', async () => {
    const { seriesId, schemeId } = await setup('DBL3', 20, 60, 'AtMaturity', true);
    const { cid } = await holding(seriesId, schemeId, 'Holder Gamma', '9211100003', 300000);
    const t = await cert(cid, seriesId, 'debenture');
    // The promised sum matches the row, in figures and in words.
    expect(t).toContain('thesumofRs.6,00,000(RupeesSixLakhOnly)');
    expect(t).toContain('principalamounttogetherwiththeinterestaccruedthereon');
    // The stock sentence is untrue here and must be gone.
    expect(t).not.toContain('interestshallbepaidseparately');
  });

  it('is the FORMULA, not a hard-coded double — 15% over 36 months is 1.45x', async () => {
    const { seriesId, schemeId } = await setup('CUM1', 15, 36, 'AtMaturity', true);
    const { cid } = await holding(seriesId, schemeId, 'Holder Delta', '9211100004', 100000);
    const t = await cert(cid, seriesId, 'debenture');
    expect(t).toContain('RedemptionValue(Rs.)Rs.1,45,000');
    expect(t).not.toContain('Rs.2,00,000');
  });
});

describe('a periodic holding is untouched', () => {
  it('still gets its principal back, with the original sentence', async () => {
    const { seriesId, schemeId } = await setup('PER1', 13, 36, 'Monthly', true);
    const { cid } = await holding(seriesId, schemeId, 'Holder Epsilon', '9211100005', 300000);
    const t = await cert(cid, seriesId, 'debenture');
    // Its interest has already been paid out month by month.
    expect(t).toContain('RedemptionValue(Rs.)Rs.3,00,000');
    expect(t).toContain('interestshallbepaidseparately');
    expect(t).not.toContain('Rs.6,00,000');
  });

  it('and a plain NCD series certificate is unaffected too', async () => {
    const { seriesId, schemeId } = await setup('PER2', 13, 36, 'Monthly', false);
    const { cid } = await holding(seriesId, schemeId, 'Holder Zeta', '9211100006', 500000);
    const t = await cert(cid, seriesId);
    expect(t).toContain('RedemptionValue(Rs.)Rs.5,00,000');
  });
});

describe('the calculation on its own', () => {
  it('returns the principal for every frequency that pays as it accrues', () => {
    for (const f of ['Monthly', 'Quarterly', 'HalfYearly', 'Annual']) {
      expect(redemptionValue(300000, 20, 60, f)).toBe(300000);
    }
  });
  it('doubles a 20% holding over 60 months', () => {
    expect(redemptionValue(300000, 20, 60, 'AtMaturity')).toBe(600000);
    expect(redemptionValue(100000, 20, 60, 'AtMaturity')).toBe(200000);
  });
  it('is proportional, not a doubling rule', () => {
    expect(redemptionValue(100000, 15, 36, 'AtMaturity')).toBe(145000);
    expect(redemptionValue(100000, 20, 30, 'AtMaturity')).toBe(150000);
  });
  it('falls back to the principal rather than invent a number', () => {
    // A certificate that understates is recoverable; one that invents is not.
    expect(redemptionValue(100000, null, 60, 'AtMaturity')).toBe(100000);
    expect(redemptionValue(100000, 20, null, 'AtMaturity')).toBe(100000);
    expect(redemptionValue(100000, 0, 60, 'AtMaturity')).toBe(100000);
  });
});
