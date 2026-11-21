/**
 * The bridge between a redemption in the book and the consent letter.
 *
 * The document itself — its six clauses, the declarations, where it breaks
 * across pages — is covered by unit.consent-letter.test.ts. Nothing here
 * re-tests that. What IS tested here is the half that only exists for a real
 * redemption: that the right facts come out of the database, above all the
 * BANK BLOCK (a payment instruction, which must name the same account the NEFT
 * sheet pays) and the Mode of holding (which is answered by a person and must
 * never be inferred).
 *
 * Fixture names are neutral word-only names: the letter prints the holder, and
 * assertions search the rendered text for words like "Demat" and "Physical".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields, SIGNED_SCAN_PNG} from './helpers/server.js';

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
  // The seeded demo series carries no face value; every real NCD series does
  // (checked against production — all 19 redemptions since the cut-off have
  // one). Without it the letter leaves the debenture count BLANK rather than
  // inventing a denomination on a document somebody signs, which is correct
  // and is what unit.consent-letter.test.ts pins. Give the fixture one so
  // these tests can check the arithmetic that runs in production.
  await ctx.db.query('UPDATE series SET face_value = 100000 WHERE id = $1', [seriesId]);
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

async function redemptionFor(
  holder: string, phone: string, amount: number,
  opts: { bank?: { acct: string; ifsc: string; name: string }; mode?: 'Demat' | 'Physical'; redeem?: number } = {},
) {
  const cust = await admin.post('/api/customers', { full_name: holder, phone, pan: undefined });
  expect(cust.status, JSON.stringify(cust.json)).toBe(201);
  const cid = Number(cust.json.id);
  if (opts.bank) {
    await admin.post(`/api/customers/${cid}/bank-accounts`, {
      account_number: opts.bank.acct, ifsc: opts.bank.ifsc, bank_name: opts.bank.name, holder_name: holder,
    });
  }
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-10-05',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  await approveInvestment(checker, app);
  const r = await checker.post('/api/redemptions/premature', {
    application_id: Number(app.json.id), reason: 'Needs it early',
    holding_mode: opts.mode ?? 'Demat',
    ...(opts.redeem ? { amount: opts.redeem } : {}),
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { cid, appId: Number(app.json.id), rid: Number(r.json.redemption_id) };
}

const rowFor = async (rid: number) => {
  const { redemptionConsentRow } = await import('../src/modules/redemptions/letter.js');
  return redemptionConsentRow(ctx.db, rid);
};
const pdfFor = async (rid: number) => {
  const { redemptionLetterPdf } = await import('../src/modules/redemptions/letter.js');
  return squash(extractText(await redemptionLetterPdf(ctx.db, rid)));
};

describe('a redemption fills its own consent letter', () => {
  it('carries the holder, the series, the rate and the debenture count', async () => {
    const { rid } = await redemptionFor('Holder Alpha', '9760000001', 400000);
    const row = await rowFor(rid);
    expect(row.holder_name).toBe('Holder Alpha');
    expect(row.series).toBeTruthy();
    expect(row.coupon_rate_pct).toBeGreaterThan(0);
    // Rs 4,00,000 at a face value of Rs 1,00,000 is four debentures.
    expect(row.ncd_count).toBe('4');

    const t = await pdfFor(rid);
    expect(t).toContain('ConsentforPrematureRedemption');
    expect(t).toContain('HolderAlpha');
  });

  it('prints the Demat or Physical answer the person actually gave', async () => {
    const demat = await redemptionFor('Holder Beta', '9760000002', 100000, { mode: 'Demat' });
    expect((await rowFor(demat.rid)).mode_of_holding).toBe('Demat');
    expect(await pdfFor(demat.rid)).toContain('Demat');

    const physical = await redemptionFor('Holder Gamma', '9760000003', 100000, { mode: 'Physical' });
    expect((await rowFor(physical.rid)).mode_of_holding).toBe('Physical');
    const t = await pdfFor(physical.rid);
    expect(t).toContain('Physical');
    // Never both — the answer is recorded, not guessed from the demat columns.
    expect(t).not.toContain('Demat');
  });

  it('refuses to raise a redemption without that answer', async () => {
    const cust = await admin.post('/api/customers', { full_name: 'Holder Delta', phone: '9760000004' });
    const app = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: Number(cust.json.id), series_id: seriesId,
      scheme_id: schemeId, amount: 100000, date_money_received: '2026-10-05',
    });
    await approveInvestment(checker, app);
    const r = await checker.post('/api/redemptions/premature', {
      application_id: Number(app.json.id), reason: 'No mode given',
    });
    expect(r.status).toBe(400);
  });

  it('names the ACTIVE bank account — the one the NEFT sheet will pay', async () => {
    const { cid, rid } = await redemptionFor('Holder Epsilon', '9760000005', 600000,
      { bank: { acct: '976000000501', ifsc: 'ICIC0000505', name: 'ICICI Bank' } });
    // A second account that is NOT active must not win.
    await admin.post(`/api/customers/${cid}/bank-accounts`, {
      account_number: '976000000599', ifsc: 'SBIN0000505', bank_name: 'State Bank', holder_name: 'Holder Epsilon',
    });
    const row = await rowFor(rid);
    expect(row.account_no).toBe('976000000501');
    expect(row.ifsc).toBe('ICIC0000505');
    expect(row.bank_and_branch).toContain('ICICI Bank');

    const t = await pdfFor(rid);
    expect(t).toContain('976000000501');
    expect(t).not.toContain('976000000599');
  });

  it('leaves the bank block blank rather than failing when no account is on file', async () => {
    const { rid } = await redemptionFor('Holder Zeta', '9760000006', 100000);
    const row = await rowFor(rid);
    expect(row.account_no).toBe('');
    expect(row.bank_and_branch).toBe('');
    // Still a letter, with the labels there to fill in by hand.
    const t = await pdfFor(rid);
    expect(t).toContain('AccountNo.');
    expect(t).toContain('IFSC');
  });

  it('consents to the part being withdrawn on a partial redemption', async () => {
    const { rid } = await redemptionFor('Holder Theta', '9760000007', 900000, { redeem: 300000 });
    const row = await rowFor(rid);
    // Three of the nine, not all nine — the holder consents to what is
    // actually being redeemed (owner 2026-11-20).
    expect(row.ncd_count).toBe('3');
    expect(await pdfFor(rid)).toContain(squash('to redeem all 3 NCDs held by me'));
  });
});

describe('filing a signed consent letter against a redemption already approved', () => {
  it('accepts the scan, and does not un-approve or re-gate anything', async () => {
    const { rid, appId } = await redemptionFor('Holder Iota', '9760000008', 500000);
    // Carry it all the way through, the way the 19 already went.
    await checker.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: SIGNED_SCAN_PNG, filename: 'first.png', signed_on: new Date().toISOString().slice(0, 10),
    });
    const submit = await checker.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status, JSON.stringify(submit.json)).toBe(201);
    const cxo = new Client(ctx.base);
    await cxo.post('/api/auth/login', { email: 'cxo@demo.local', password: 'Demo_1234' });
    expect((await cxo.post(`/api/approvals/${submit.json.request.id}/approve`)).json.request.status).toBe('Approved');

    // Now it is Approved — exactly the state the 19 are in. Clear the signing
    // row so this stands in for one that never had a letter at all.
    await ctx.db.query('DELETE FROM redemption_signings WHERE redemption_id = $1', [rid]);

    const up = await checker.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: SIGNED_SCAN_PNG, filename: 'collected-later.png',
      signed_on: new Date().toISOString().slice(0, 10), note: 'Collected after approval',
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json.status).toBe('Signed');

    // The redemption is untouched by the filing — this records, it does not act.
    const red = (await ctx.db.query('SELECT status FROM redemptions WHERE id = $1', [rid])).rows[0] as any;
    expect(red.status).toBe('Approved');
    const app = (await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.status).toBe('Redeemed');
    // And it can be read back.
    expect((await checker.raw(`/api/redemptions/${rid}/signed-letter.pdf`)).status).toBe(200);
  });

  it('still refuses a redemption that was settled before the cut-off', async () => {
    const { rid } = await redemptionFor('Holder Kappa', '9760000009', 100000);
    // Backdate it to before the consent letter applied, and settle it.
    await ctx.db.query(
      "UPDATE redemptions SET status = 'Approved', created_at = DATE '2026-10-01' WHERE id = $1", [rid]);
    await ctx.db.query('DELETE FROM redemption_signings WHERE redemption_id = $1', [rid]);
    const up = await checker.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: SIGNED_SCAN_PNG, filename: 'x.png', signed_on: new Date().toISOString().slice(0, 10),
    });
    expect(up.status).toBe(409);
    // There is no consent to collect for something settled under the old rules.
    expect(String(up.json.error.message)).toContain('on or after');
  });
});
