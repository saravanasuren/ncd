/**
 * Not one "NCD" on a Debenture 1-5 certificate.
 *
 * Owner 2026-11-17: "remove all the ncd words and in the bottom rename it like
 * - discharge of the debenture certificate, make sure there is not NCD words in
 * the certificate. change it only for debenture 1-5."
 *
 * So the first test counts occurrences rather than checking labels one by one —
 * "make sure there is not NCD words" is a statement about the WHOLE document,
 * and a label added later would slip past a list of four assertions.
 *
 * "change it only for debenture 1-5" is the other half, and the NCD Series 1-28
 * test is what enforces it. Those certificates keep every NCD word they have
 * always carried.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { bondLegalParagraph } from '../src/modules/reports/forms/bond.js';
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

/** A series of the given kind with one live holding.
 *
 *  THE TAG MUST NOT CONTAIN "NCD" EITHER. It becomes the series code AND the
 *  scheme name, and the scheme name is PRINTED on the certificate now — a tag
 *  of "NONCD" put the very word this file counts onto the page and failed the
 *  first test for the wrong reason. The holder's name likewise carries no
 *  digits (validation refuses them) and no word under test. */
async function holdingIn(tag: string, sub: boolean, phone: string, holder: string) {
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  const schemeId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,36,'Monthly',$3,$4,$5,$6,$7,$8,$9,TRUE) RETURNING id`,
    [`SCH-${tag}`, `Plan ${tag}`, base.coupon_rate_pct, base.face_value, base.min_ticket,
     base.multiple_of, base.day_count_convention, base.commission_rule, base.tds_rule_id])).rows[0]!.id);
  const seriesId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,$2,'2026-10-31'::date,'2026-10-31'::date) RETURNING id`,
    [`SER-${tag}`, sub])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [seriesId, schemeId]);
  const cust = await admin.post('/api/customers', { full_name: holder, phone });
  expect(cust.status, JSON.stringify(cust.json)).toBe(201);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-10-05',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  await approveInvestment(checker, app);
  return { cid: Number(cust.json.id), seriesId };
}

const text = async (cid: number, sid: number, template?: 'debenture') => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, template));
};

describe('a Debenture 1-5 certificate', () => {
  it('does not contain the word NCD anywhere on the page', async () => {
    const { cid, seriesId } = await holdingIn('DEBA', true, '9411100001', 'Holder Alpha');
    const t = await text(cid, seriesId, 'debenture');
    // The whole document, not a list of labels.
    expect(t.match(/NCD/g) ?? []).toHaveLength(0);
  });

  it('calls the holder and the instrument a Debenture', async () => {
    const { cid, seriesId } = await holdingIn('DEBB', true, '9411100002', 'Holder Beta');
    const t = squash(await text(cid, seriesId, 'debenture'));
    expect(t).toContain('NameofDebentureHolder');
    expect(t).toContain('AddressofDebentureHolder');
    expect(t).toContain('NumberofDebentures');
    expect(t).toContain('FaceValueperDebenture(Rs.)');
  });

  it('closes on "discharge of the Debenture Certificate"', async () => {
    const { cid, seriesId } = await holdingIn('DEBC', true, '9411100003', 'Holder Gamma');
    const t = squash(await text(cid, seriesId, 'debenture'));
    // The owner's own wording: THE, not THIS.
    expect(t).toContain('dischargeoftheDebentureCertificate');
  });

  it('leaves an NCD Series 1-28 certificate every NCD word it had', async () => {
    const { cid, seriesId } = await holdingIn('PLAINSER', false, '9411100004', 'Holder Delta');
    const t = squash(await text(cid, seriesId));
    expect(t).toContain('NameofNCDHolder');
    expect(t).toContain('NumberofNCDs');
    expect(t).toContain('FaceValueperNCD(Rs.)');
    expect(t).toContain('dischargeofthisNCDCertificate');
    expect(t).not.toContain('DebentureHolder');
  });

  it('leaves the subordinate certificate its Bond wording', async () => {
    const { cid, seriesId } = await holdingIn('SUBSER', true, '9411100005', 'Holder Epsilon');
    const t = squash(await text(cid, seriesId));
    expect(t).toContain('NameofBondHolder');
    expect(t).toContain('dischargeofthisBondCertificate');
  });
});

describe('the legal paragraph on its own', () => {
  const LEGAL = 'Dhanam Investment and Finance Limited', OFFICE = 'Somewhere, Coimbatore';
  it('still reads exactly as it did for an NCD and for a Bond', () => {
    expect(bondLegalParagraph(LEGAL, OFFICE, 100000)).toContain('discharge of this NCD Certificate');
    expect(bondLegalParagraph(LEGAL, OFFICE, 100000, true)).toContain('discharge of this Bond Certificate');
  });
  it('reads "the Debenture Certificate" only when asked for that form', () => {
    const p = bondLegalParagraph(LEGAL, OFFICE, 100000, false, true);
    expect(p).toContain('discharge of the Debenture Certificate');
    expect(p).not.toContain('NCD');
    // Nothing else in the sentence moved.
    expect(p).toContain('on the date of redemption as mentioned above');
    expect(p).toContain('Rs. 1,00,000 (Rupees One Lakh Only)');
  });
});
