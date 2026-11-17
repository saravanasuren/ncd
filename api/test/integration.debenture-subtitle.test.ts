/**
 * The subtitle pill under the certificate title.
 *
 * Owner 2026-11-17: "in the ncd certificate remove the non convertable
 * debentures wordsngs, just keep secured and redeemable".
 *
 * ONE LINE DREW THAT PILL FOR TWO DOCUMENTS — the Debenture 1-5 certificate the
 * owner was looking at, and a real NCD Series 1-28 certificate. Asked which
 * should change, the owner chose Debenture 1-5 only, so Series 1-28 keep their
 * wording: "Do not disturb NCD Series 1-28 under any circumstances." The second
 * test here is the one that stops the change leaking, and it is the reason this
 * file exists at all.
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
const SHORT = '(Secured,RedeemableDebenture)';
const LONG = '(Secured,Redeemable,Non-ConvertibleDebentures)';

/** A series of the given kind, with one live holding, and its certificate. */
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
  // A holder name carries NO digits (validation refuses them) and none of the
  // words these assertions search for - the extracted PDF is one string.
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

const certificate = async (cid: number, sid: number, template?: 'debenture') => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, template)));
};

describe('the subtitle on a Debenture 1-5 certificate', () => {
  it('says Secured, Redeemable Debenture — and nothing about non-convertible debentures', async () => {
    const { cid, seriesId } = await holdingIn('SUB1', true, '9511100001', 'Holder Alpha');
    const t = await certificate(cid, seriesId, 'debenture');
    expect(t).toContain(SHORT);
    expect(t).not.toContain(LONG);
    expect(t).not.toContain('Non-ConvertibleDebentures');
    // The title above the pill is untouched.
    expect(t).toContain('DebentureCertificate');
  });

  it('leaves a real NCD Series 1-28 certificate word for word as it was', async () => {
    const { cid, seriesId } = await holdingIn('NCD1', false, '9511100002', 'Holder Beta');
    const t = await certificate(cid, seriesId);
    // The long wording stands. This is the standing rule, not a preference.
    expect(t).toContain(LONG);
    expect(t).not.toContain(SHORT);
  });

  it('leaves the subordinate certificate its own wording and denomination', async () => {
    const { cid, seriesId } = await holdingIn('SUB2', true, '9511100003', 'Holder Gamma');
    const t = await certificate(cid, seriesId);
    expect(t).toContain('SubordinateDebtCertificate');
    expect(t).toContain('SubordinateBondsoffacevalue');
    expect(t).not.toContain(SHORT);
  });
});
