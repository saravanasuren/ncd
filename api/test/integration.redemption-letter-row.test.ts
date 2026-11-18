/**
 * The bridge between a redemption in the book and the letter renderer.
 *
 * The renderer itself (layout, wording, the three addressee eras) arrived with
 * the bulk-letter feature and is covered by unit.redemption-letter.test.ts.
 * Nothing here re-tests that. What IS tested here is the half that only exists
 * for a redemption raised in the system: that the right facts come out of the
 * database and reach the row — above all the BANK BLOCK, which is a payment
 * instruction and must name the same account the NEFT sheet will pay.
 *
 * Fixture names are deliberately neutral word-only names: the letter prints
 * the holder and the series, and assertions below search the rendered text, so
 * a customer called "Bank Holder" would satisfy a search without the letter
 * being right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
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
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

async function redemptionFor(holder: string, phone: string, amount: number, bank?: { acct: string; ifsc: string; name: string }) {
  const cust = await admin.post('/api/customers', { full_name: holder, phone });
  expect(cust.status, JSON.stringify(cust.json)).toBe(201);
  const cid = Number(cust.json.id);
  if (bank) {
    await admin.post(`/api/customers/${cid}/bank-accounts`, {
      account_number: bank.acct, ifsc: bank.ifsc, bank_name: bank.name, holder_name: holder,
    });
  }
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-10-05',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  await approveInvestment(checker, app);
  const r = await checker.post('/api/redemptions/premature', { application_id: Number(app.json.id), reason: 'Needs it early' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { cid, rid: Number(r.json.redemption_id) };
}

const rowFor = async (rid: number) => {
  const { redemptionLetterRow } = await import('../src/modules/redemptions/letter.js');
  return redemptionLetterRow(ctx.db, rid);
};
const pdfFor = async (rid: number) => {
  const { redemptionLetterPdf } = await import('../src/modules/redemptions/letter.js');
  return squash(extractText(await redemptionLetterPdf(ctx.db, rid)));
};

describe('a redemption fills its own request letter', () => {
  it('carries the holder, the series, the amount and the debenture count', async () => {
    const { rid } = await redemptionFor('Letter Alpha', '9750000001', 400000);
    const row = await rowFor(rid);
    expect(row.holder_name).toBe('Letter Alpha');
    expect(row.amount).toBe(400000);
    // Rs 4,00,000 at a face value of Rs 1,00,000 is four debentures.
    expect(row.debentures).toBe('4');
    expect(row.series).toBeTruthy();

    const t = await pdfFor(rid);
    expect(t).toContain('LetterAlpha');
    expect(t).toContain('4,00,000');
  });

  it('names the ACTIVE bank account — the one the NEFT sheet will pay', async () => {
    const { cid, rid } = await redemptionFor('Letter Beta', '9750000002', 600000,
      { acct: '975000000201', ifsc: 'ICIC0000202', name: 'ICICI Bank' });
    // A second account that is NOT active must not win.
    await admin.post(`/api/customers/${cid}/bank-accounts`, {
      account_number: '975000000299', ifsc: 'SBIN0000202', bank_name: 'State Bank', holder_name: 'Letter Beta',
    });
    const row = await rowFor(rid);
    expect(row.bank_name).toBe('ICICI Bank');
    expect(row.account_no).toBe('975000000201');
    expect(row.ifsc).toBe('ICIC0000202');

    const t = await pdfFor(rid);
    expect(t).toContain('975000000201');
    expect(t).not.toContain('975000000299');
  });

  it('leaves the bank block blank rather than failing when no account is on file', async () => {
    const { rid } = await redemptionFor('Letter Gamma', '9750000003', 100000);
    const row = await rowFor(rid);
    expect(row.bank_name).toBe('');
    expect(row.account_no).toBe('');
    // Still a letter, with the labels present to fill in by hand.
    const t = await pdfFor(rid);
    expect(t).toContain('BankName');
    expect(t).toContain('IFSCCode');
  });

  it('asks for the part being withdrawn on a partial redemption', async () => {
    const cust = await admin.post('/api/customers', { full_name: 'Letter Delta', phone: '9750000004' });
    const cid = Number(cust.json.id);
    const app = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
      amount: 900000, date_money_received: '2026-10-05',
    });
    await approveInvestment(checker, app);
    const r = await checker.post('/api/redemptions/premature', {
      application_id: Number(app.json.id), reason: 'Partial need', amount: 300000,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = await rowFor(Number(r.json.redemption_id));
    expect(row.amount).toBe(300000);
    expect(row.debentures).toBe('3');
  });

  it('is dated today, so it addresses the company as it is now', async () => {
    const { rid } = await redemptionFor('Letter Epsilon', '9750000005', 100000);
    const row = await rowFor(rid);
    expect(row.letter_date).toBe(new Date().toISOString().slice(0, 10));
    // Today is past both era boundaries, so a letter raised in the system
    // addresses the current Dhanam block — which is what the owner asked for
    // ("just use dhanam for all the upcoming redemption requests") without a
    // second rule here to maintain.
    const t = await pdfFor(rid);
    expect(t).toContain('TheBoardofDirectors,');
    expect(t).toContain('DhanamInvestmentandFinance');
    expect(t).not.toContain('KiaraMicrocreditPrivateLimited');
  });
});
