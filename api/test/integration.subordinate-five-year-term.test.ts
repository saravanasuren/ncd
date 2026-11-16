/**
 * The Subordinate Bond Certificate states a FIVE-YEAR term for Debenture 1-5,
 * whatever term the money actually runs.
 *
 * Owner 2026-11-16: "all subordinate bonds should have the maturity dates as 5
 * years tenure - even if the investment scheme is of 36 months". Asked whether
 * that moved the money or only the document: "Only the certificate says 5
 * years."
 *
 * So the certificate and the schedule disagree ON PURPOSE for a 36-month
 * holding. The tests below assert BOTH halves of that: the document says five
 * years, and the record still says three. A test that only checked the
 * document would pass just as well if this had quietly moved a maturity date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;
let tag = 0;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

/** A subordinate series, with or without a close date, plus a scheme. */
async function setup(tenure: number, close: string | null, freq = 'Monthly') {
  const t = ++tag;
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  const schemeId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING id`,
    [`S5-${t}`, `S5 ${t} - ${tenure} Months`, tenure, freq, base.coupon_rate_pct, base.face_value,
     base.min_ticket, base.multiple_of, base.day_count_convention, base.commission_rule, base.tds_rule_id])).rows[0]!.id);
  const seriesId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,TRUE,$2::date,$2::date) RETURNING id`, [`SUB5-${t}`, close])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [seriesId, schemeId]);
  return { schemeId, seriesId };
}

async function holding(seriesId: number, schemeId: number, name: string, phone: string) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-11-05',
  });
  await approveInvestment(checker, app);
  return { customerId: Number(cust.json.id), appId: Number(app.json.id) };
}

const subForm = async (cid: number, sid: number) => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid)));
};

describe('the subordinate certificate states five years', () => {
  it('a 36-month holding redeems at five years ON THE CERTIFICATE', async () => {
    const { schemeId, seriesId } = await setup(36, '2026-11-30');
    const { customerId } = await holding(seriesId, schemeId, 'Thirty Six Sub', '9556110001');

    const text = await subForm(customerId, seriesId);
    expect(text).toContain(squash('30-11-2031'));       // close + 60
    expect(text).not.toContain(squash('30-11-2029'));   // not close + 36
    expect(text).toContain(squash('Effective Date'));
    expect(text).toContain(squash('30-11-2026'));
  });

  it('...and the RECORD still matures at three years', async () => {
    // The other half. The owner chose a document-only change; if this ever
    // starts moving maturity dates, the money moves with it.
    const { schemeId, seriesId } = await setup(36, '2026-11-30');
    const { customerId, appId } = await holding(seriesId, schemeId, 'Record Unmoved', '9556110002');
    await subForm(customerId, seriesId);

    const row = (await ctx.db.query<{ app: string; line: string }>(
      `SELECT a.maturity_date::text AS app, l.maturity_date::text AS line
         FROM applications a JOIN application_lines l ON l.application_id = a.id WHERE a.id = $1`, [appId])).rows[0]!;
    expect(row.app).toBe('2029-11-30');
    expect(row.line).toBe('2029-11-30');
  });

  it('a Doubling holding is unaffected — it already ran five years', async () => {
    const { schemeId, seriesId } = await setup(60, '2026-11-30', 'AtMaturity');
    const { customerId } = await holding(seriesId, schemeId, 'Doubling Sub', '9556110003');
    expect(await subForm(customerId, seriesId)).toContain(squash('30-11-2031'));
  });

  it('a subordinate series with no close date is left exactly as it was', async () => {
    // NCD BOND, NCD 29 and NCD Doubling carry no close date. The owner scoped
    // this to Debenture 1-5, and having a close date is what distinguishes
    // them — so no series name appears in the code at all.
    const { schemeId, seriesId } = await setup(36, null);
    const { customerId, appId } = await holding(seriesId, schemeId, 'No Close Date', '9556110004');
    const stored = (await ctx.db.query<{ d: string }>(
      'SELECT maturity_date::text AS d FROM applications WHERE id = $1', [appId])).rows[0]!.d;

    const text = await subForm(customerId, seriesId);
    // Whatever the record says is what prints — unchanged behaviour.
    const [y, m, d] = stored.split('-');
    expect(text).toContain(squash(`${d}-${m}-${y}`));
  });

  it('the Debenture form still states three years', async () => {
    // "debenture 1-5 will have the subordinate certificates ALONE as 5 yrs."
    // The NCD/Debenture rendering keeps the owner's 6 Nov three-year rule.
    const { schemeId, seriesId } = await setup(36, '2026-11-30');
    const { customerId } = await holding(seriesId, schemeId, 'Ncd Form Three', '9556110005');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const ncd = squash(extractText(await consolidatedBondCertificatePdf(ctx.db, customerId, seriesId, 'debenture')));

    expect(ncd).toContain(squash('30-11-2029'));
    expect(ncd).not.toContain(squash('30-11-2031'));
  });

  it('a reprint of a per-investment subordinate bond states five years too', async () => {
    const { schemeId, seriesId } = await setup(36, '2026-11-30');
    const { customerId, appId } = await holding(seriesId, schemeId, 'Reprint Five', '9556110006');
    void customerId;
    await ctx.db.query("UPDATE applications SET bond_serial_no = 'BC-2026-000099' WHERE id = $1", [appId]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(extractText(await bondCertificatePdf(ctx.db, appId)));
    expect(text).toContain(squash('30-11-2031'));
    expect(text).not.toContain(squash('30-11-2029'));
  });
});
