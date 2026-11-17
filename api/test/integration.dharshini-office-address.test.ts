/**
 * DHARSHINI Business Centre, with an H.
 *
 * Owner 2026-11-17: "change the address as dharshini business centre for all
 * areas bonds and acknowledgments."
 *
 * One constant feeds SIX documents. Told that, and told it would leave the
 * company spelled two ways across the paperwork, the owner chose bonds and
 * acknowledgements ONLY. So this file pins both halves: the two that change,
 * and the ones that deliberately do not. The application-form test is not a
 * leftover — it is the owner's decision written down, and if someone later
 * "fixes" the inconsistency it should fail and send them back here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { withCorrectedOffice, COMPANY } from '../src/modules/reports/forms/shared.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;
let subSeries: number, plainSeries: number, schemeId: number, appId: number, plainAppId: number, custId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  subSeries = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('ADDR-SUB', 'ADDR-SUB', 'Open', 100000, TRUE, DATE '2026-10-31', DATE '2026-10-31') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [subSeries, schemeId]);
  // A subordinate series REFUSES a per-investment bond by design — it issues one
  // certificate covering the whole holding — so that render needs a plain series.
  plainSeries = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('ADDR-PLAIN', 'ADDR-PLAIN', 'Open', 100000, FALSE, DATE '2026-10-31', DATE '2026-10-31') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [plainSeries, schemeId]);
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });

  const cust = await admin.post('/api/customers', { full_name: 'Address Holder', phone: '9311100001' });
  custId = Number(cust.json.id);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId,
    series_id: subSeries, scheme_id: schemeId, amount: 400000, date_money_received: '2026-10-05',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  appId = Number(app.json.id);
  await approveInvestment(checker, app);

  const plainApp = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId,
    series_id: plainSeries, scheme_id: schemeId, amount: 400000, date_money_received: '2026-10-05',
  });
  expect(plainApp.status, JSON.stringify(plainApp.json)).toBe(201);
  plainAppId = Number(plainApp.json.id);
  await approveInvestment(checker, plainApp);
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');
// "Darshini" is NOT a substring of "Dharshini" (the h follows the D), so these
// two assertions can never both pass by accident.
const RIGHT = 'DharshiniBusinessCentre';
const WRONG = 'DarshiniBusinessCentre';

describe('the documents the owner named', () => {
  it('the Subordinate Bond certificate spells it Dharshini', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const t = squash(extractText(await consolidatedBondCertificatePdf(ctx.db, custId, subSeries)));
    expect(t).toContain(RIGHT);
    expect(t).not.toContain(WRONG);
  });

  it('the Debenture certificate spells it Dharshini, in the header AND the legal paragraph', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const t = squash(extractText(await consolidatedBondCertificatePdf(ctx.db, custId, subSeries, 'debenture')));
    // The address appears twice on this page; neither may keep the old spelling.
    expect((t.match(/DharshiniBusinessCentre/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(t).not.toContain(WRONG);
  });

  it('the per-investment bond certificate spells it Dharshini', async () => {
    // A bond is a bond: this is a plain NCD series, and the owner asked for the
    // corrected spelling on bonds, so it carries it too.
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const t = squash(extractText(await bondCertificatePdf(ctx.db, plainAppId)));
    expect(t).toContain(RIGHT);
    expect(t).not.toContain(WRONG);
  });

  it('the acknowledgement spells it Dharshini', async () => {
    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const t = squash(extractText(await acknowledgmentPdf(ctx.db, appId)));
    expect(t).toContain(RIGHT);
    expect(t).not.toContain(WRONG);
  });
});

describe('the documents the owner deliberately left alone', () => {
  it('the application form keeps the old spelling', async () => {
    const { applicationFormPdf } = await import('../src/modules/reports/forms/application-form.js');
    const { buffer } = await applicationFormPdf(ctx.db, appId);
    const t = squash(extractText(buffer));
    // Owner's explicit choice, asked and answered. Not an oversight.
    expect(t).toContain(WRONG);
    expect(t).not.toContain(RIGHT);
  });

  it('the stored constant itself is untouched, which is what leaves them alone', () => {
    expect(COMPANY.corporate_office_address).toContain('Darshini Business Centre');
    expect(COMPANY.corporate_office_address).not.toContain('Dharshini');
  });
});

describe('the correction itself', () => {
  const co = { corporate_office_address: COMPANY.corporate_office_address };

  it('changes the spelling and nothing else on the line', () => {
    const fixed = withCorrectedOffice(co).corporate_office_address;
    expect(fixed).toBe(COMPANY.corporate_office_address.replace('Darshini', 'Dharshini'));
    // Door number, floor, road, areas, city and pincode all survive.
    expect(fixed).toContain('2/191B, 2nd Floor');
    expect(fixed).toContain('Mylampatty Road');
    expect(fixed).toContain('TN - 641 062');
  });

  it('does nothing to an address that is already correct', () => {
    const already = { corporate_office_address: 'Dharshini Business Centre, Coimbatore' };
    expect(withCorrectedOffice(already).corporate_office_address).toBe(already.corporate_office_address);
  });
});
