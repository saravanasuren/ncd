/**
 * The redemption date on the Debenture form of a Debenture 1-5 holding.
 *
 * THREE YEARS, EXCEPT DOUBLING.
 *
 * Owner 2026-11-06: this form states the NCD's own three-year term even where
 * the holding runs longer (#514, deliberate). Owner 2026-11-16, asked whether
 * point 9 reversed that: "nov 6 stands, except for doubling schemee. doubling
 * acheme alone will have 5 yrs ternure in both." The exception is the PRODUCT,
 * not the number — a 60-month holding that is not Doubling still prints three
 * years, which is what the second test here pins.
 *
 * Point 9 also asked for the end-of-month convention to be preserved. The form
 * had its own month arithmetic, which rolls past a month end where the
 * interest engine clamps to it.
 *
 * The SUBORDINATE form is not touched by any of this — it reads maturity_date
 * off the record. Only this form calculates a date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
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

/** A scheme of a given tenure and frequency, and a subordinate series closing
 *  on `close`. A non-periodic frequency is what makes it a Doubling product. */
async function setup(tag: string, tenure: number, close: string, sub = true, freq = 'Monthly') {
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  const schemeId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING id`,
    [`SCH-${tag}`, `${tag} - ${tenure} Months`, tenure, freq, base.coupon_rate_pct,
     base.face_value, base.min_ticket, base.multiple_of, base.day_count_convention,
     base.commission_rule, base.tds_rule_id])).rows[0]!.id);
  const seriesId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,$2,$3::date,$3::date) RETURNING id`, [`DEB-${tag}`, sub, close])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [seriesId, schemeId]);
  return { schemeId, seriesId };
}

async function holding(seriesId: number, schemeId: number, name: string, phone: string) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-10-05',
  });
  await approveInvestment(checker, app);
  return Number(cust.json.id);
}

const ncdForm = async (cid: number, sid: number) => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, 'debenture')));
};
const subForm = async (cid: number, sid: number) => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid)));
};

describe('the redemption date follows the holding, not a constant', () => {
  it('a Doubling holding redeems in five years, not three', async () => {
    // "doubling acheme alone will have 5 yrs ternure in both."
    const { schemeId, seriesId } = await setup('DOUBLING', 60, '2026-09-30', true, 'Cumulative');
    const cid = await holding(seriesId, schemeId, 'Doubling Holder', '9554110001');

    const text = await ncdForm(cid, seriesId);
    expect(text).toContain(squash('30-09-2031'));
    expect(text).not.toContain(squash('30-09-2029'));
  });

  it('a 60-month holding that is NOT Doubling still prints three years', async () => {
    // The exception is the PRODUCT, not the number. This is the test that
    // separates "nov 6 stands, except for doubling" from "use the actual
    // tenure", which would have printed 2031 here.
    const { schemeId, seriesId } = await setup('SIXTYMONTHLY', 60, '2026-09-30');
    const cid = await holding(seriesId, schemeId, 'Sixty Monthly', '9554110007');

    const text = await ncdForm(cid, seriesId);
    expect(text).toContain(squash('30-09-2029'));
    expect(text).not.toContain(squash('30-09-2031'));
  });

  it('a 36-month holding is unchanged', async () => {
    const { schemeId, seriesId } = await setup('THIRTYSIX', 36, '2026-10-31');
    const cid = await holding(seriesId, schemeId, 'Thirty Six', '9554110002');
    expect(await ncdForm(cid, seriesId)).toContain(squash('31-10-2029'));
  });

  it('both forms of a Doubling holding agree on the date', async () => {
    // Two renderings of one instrument. If they disagree, one of them is lying
    // to the holder about when they get their money back — which is exactly
    // what the owner's exception is for.
    const { schemeId, seriesId } = await setup('AGREE', 60, '2026-09-30', true, 'Cumulative');
    const cid = await holding(seriesId, schemeId, 'Both Agree', '9554110003');
    expect(await ncdForm(cid, seriesId)).toContain(squash('30-09-2031'));
    expect(await subForm(cid, seriesId)).toContain(squash('30-09-2031'));
  });

  it('clamps to the end of the month instead of rolling past it', async () => {
    // 31 Aug + 6 months. lib/dates clamps to 28 Feb; the form's own arithmetic
    // rolled to 3 Mar. Never visible at 36 or 60 months, where the
    // day-of-month survives untouched — which is why it sat there.
    const { schemeId, seriesId } = await setup('MONTHEND', 6, '2026-08-31', true, 'Cumulative');
    const cid = await holding(seriesId, schemeId, 'Month End', '9554110004');

    const text = await ncdForm(cid, seriesId);
    expect(text).toContain(squash('28-02-2027'));
    expect(text).not.toContain(squash('03-03-2027'));
  });

  it('says so rather than guessing when a Doubling holding disagrees with itself', async () => {
    const { schemeId, seriesId } = await setup('MIXED', 36, '2026-10-31', true, 'Cumulative');
    const cid = await holding(seriesId, schemeId, 'Mixed Tenure', '9554110005');
    // A second line in the same series at a different term.
    await ctx.db.query(
      `UPDATE application_lines SET tenure_months = 60
        WHERE application_id = (SELECT id FROM applications WHERE customer_id = $1 AND series_id = $2 ORDER BY id DESC LIMIT 1)`,
      [cid, seriesId]);
    const second = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId,
      scheme_id: schemeId, amount: 300000, date_money_received: '2026-10-09',
    });
    await approveInvestment(checker, second);

    expect(await ncdForm(cid, seriesId)).toContain(squash('As per breakup below'));
  });

  it('leaves a real NCD series reading off its own investments', async () => {
    // "Do not disturb NCD Series 1-28." A non-subordinate series never takes
    // the calculated path at all — its dates come from the records.
    const { schemeId, seriesId } = await setup('PLAINNCD', 36, '2026-10-31', false);
    const cid = await holding(seriesId, schemeId, 'Plain Ncd', '9554110006');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const auto = extractText(await consolidatedBondCertificatePdf(ctx.db, cid, seriesId));
    const asked = extractText(await consolidatedBondCertificatePdf(ctx.db, cid, seriesId, 'debenture'));
    expect(asked).toBe(auto);
  });
});
