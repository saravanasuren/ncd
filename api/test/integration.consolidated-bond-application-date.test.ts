/**
 * The consolidated Subordinate Debt Certificate's Date of Application.
 *
 * Owner 2026-11-02: "application date should come - and that will the
 * investment start date". The per-investment certificate already printed it;
 * the CONSOLIDATED one did not, which is the certificate in the owner's hand.
 *
 * The start date is `date_money_received` — when the money landed and the term
 * begins — not the allotment date, which is a later, separate event.
 *
 * A consolidated certificate covers a whole holding, so when that holding was
 * built over several dates there is no single date to print. Three rows then say
 * "As per breakup below" — and before this, NO breakup was ever drawn, on any
 * certificate, so the holder was referred to a table that was not on the page.
 * These tests cover both shapes, and in the multi-date case they check the
 * breakup is really there AND that the signature band survived being pushed
 * down, because this document has lost its signatures off the page before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // Make the demo series one of the three subordinate ones, so the consolidated
  // certificate takes the Subordinate Debt Certificate form.
  await ctx.db.query("UPDATE series SET code = 'NCD_29' WHERE id = $1", [seriesId]);
});
afterAll(async () => { await ctx.close(); });

/** Visible text of a PDFKit document, hex TJ arrays and literal strings alike. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); } catch { continue; }
    if (!body.includes('BT')) continue;
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = t[1]!.replace(/\s+/g, '');
      if (hex.length % 2) continue;
      out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const t of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      out.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    }
  }
  return out.join('');
}
const squash = (s: string) => s.replace(/\s+/g, '');
// Filled-in VALUES print in capitals on the subordinate form while labels keep
// their case, so value assertions compare case-insensitively.
const caps = (s: string) => squash(s).toUpperCase();

/** A customer holding `dates.length` investments, and their consolidated text. */
async function holding(name: string, phone: string, dates: string[]): Promise<{ text: string; pages: number }> {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await c.post('/api/customers', { full_name: name, phone });
  const checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  for (const d of dates) {
    const app = await c.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id,
      series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: d,
    });
    await approveInvestment(checker, app);
  }
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  const buf = await consolidatedBondCertificatePdf(ctx.db, Number(cust.json.id), seriesId);
  return { text: squash(pdfText(buf)), pages: (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length };
}

describe('the consolidated certificate prints the investment start date', () => {
  it('shows the date itself when the whole holding started on one day', async () => {
    const { text } = await holding('Consolidated One Date', '9552880001', ['2026-07-12']);
    expect(text).toContain(squash('Date of Application'));
    expect(text).toContain(squash('12-07-2026'));
    // Nothing punts, so no breakup is drawn and the certificate is as it was.
    expect(text.toUpperCase()).not.toContain(caps('As per breakup below'));
    expect(text).not.toContain(squash('Breakup of the investments'));
  });

  it('is the money-received date, not the allotment date', async () => {
    // The two differ: these investments are approved today but the money landed
    // in July. Printing the allotment date here would start the term on the
    // wrong day and disagree with the per-investment certificate.
    const { text } = await holding('Consolidated Not Allotment', '9552880002', ['2026-07-12']);
    const today = new Date();
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    expect(text).toContain(squash('12-07-2026'));
    expect(text).not.toContain(squash(`${dd}-${mm}-${today.getUTCFullYear()}`));
  });

  it('punts to a breakup that is actually drawn when the holding spans dates', async () => {
    const { text, pages } = await holding('Consolidated Many Dates', '9552880003',
      ['2026-07-12', '2026-08-20', '2026-09-05']);
    expect(text).toContain(squash('Date of Application'));
    expect(text.toUpperCase()).toContain(caps('As per breakup below'));
    // The table the row points at, with every tranche's own start date in it.
    expect(text).toContain(squash('Breakup of the investments this certificate comprises'));
    expect(text).toContain(squash('12-07-2026'));
    expect(text).toContain(squash('20-08-2026'));
    expect(text).toContain(squash('05-09-2026'));
    // The total still reads as one bond of the whole holding.
    expect(text.toUpperCase()).toContain(caps('Rs. 15,00,000'));
    // ...and the signature band was not pushed off the page by the new table.
    expect(text).toContain(squash('Avinash Gopalakrishnan'));
    expect(text).toContain(squash('Gokul Govindarajan'));
    expect(text).toContain(squash('Sankar Venkataraman'));
    expect(text).toContain(squash('*Will be subject to deduction of TDS'));
    expect(pages).toBeLessThanOrEqual(2);
  });

  it('keeps the Debenture Certificate of the earlier series untouched', async () => {
    // The breakup and the Date of Application row are gated on the subordinate
    // form. A non-subordinate series must come out exactly as before.
    await ctx.db.query("UPDATE series SET code = 'NCD_28' WHERE id = $1", [seriesId]);
    try {
      const { text } = await holding('Consolidated Old Series', '9552880004', ['2026-07-12', '2026-08-20']);
      expect(text).toContain(squash('Debenture Certificate'));
      expect(text).toContain(squash('Date of Allotment'));
      expect(text).not.toContain(squash('Date of Application'));
      expect(text).not.toContain(squash('Breakup of the investments'));
    } finally {
      await ctx.db.query("UPDATE series SET code = 'NCD_29' WHERE id = $1", [seriesId]);
    }
  });
});
