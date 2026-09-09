/**
 * What the bond certificate ACTUALLY prints — read back out of a generated PDF.
 *
 * bond-legal-paragraph.test.ts pins the string builder, which is necessary but
 * not sufficient: it cannot tell you the certificate draws that string, or that
 * it draws all of it. bond.ts says as much in its own comment — inside the PDF
 * the text "is compressed and ungreppable, which would leave the one part of
 * this document that actually binds the Company as the one part no test could
 * see". This is that test.
 *
 * Two things make the text hard to read back, and both bit before this file
 * settled:
 *   · the content stream is deflated, so the bytes are not greppable; and
 *   · PDFKit writes text as HEX inside a TJ array, and a JUSTIFIED paragraph is
 *     emitted one WORD at a time with its own positioning — so the recovered
 *     text reads "ForValueReceived,Dhanam..." with no spaces at all. A naive
 *     `toContain('For Value Received')` therefore fails on a certificate that
 *     is perfectly correct, and the tempting fix — asserting the negative only
 *     — would have passed against ANY document, including an empty one.
 * Both are handled by stripping whitespace from both sides of the comparison.
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
    // A font program inflates cleanly too; the CONTENT stream is the one with a
    // BT/ET text block.
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

async function certificate(amount: number): Promise<string> {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await c.post('/api/customers', { full_name: 'Certificate Text', phone: '9552' + String(amount).slice(0, 6) });
  const app = await c.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12',
  });
  const checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await approveInvestment(checker, app);
  const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(pdfText(await bondCertificatePdf(ctx.db, Number(app.json.id))));
}

describe('the bond certificate prints the promise to pay', () => {
  let text = '';
  it('renders, and the operative paragraph is readable in the output', async () => {
    text = await certificate(2000000);
    // The POSITIVE assertions come first and deliberately cover the whole
    // paragraph. Without them the absence check below proves nothing.
    expect(text).toContain(squash('For Value Received, Dhanam Investment and Finance Private Limited'));
    expect(text).toContain(squash('promises to pay to the person(s) named herein as the holder(s), or their order'));
    expect(text).toContain(squash('Rs. 20,00,000 (Rupees Twenty Lakh Only)'));
    expect(text).toContain(squash('The principal amount shall be payable on redemption, while interest shall be paid separately'));
    expect(text).toContain(squash('under the provisions of the Income-tax Act, 1961, or any statutory modification or re-enactment thereof.'));
  });

  it('does NOT incorporate the Private Placement Offer Letter', async () => {
    // Removed at the owner's instruction 2026-09-09. Asserted on the rendered
    // certificate, not just the builder, because the certificate is the thing
    // the debenture holder is handed.
    expect(text).not.toContain(squash('Private Placement Offer Letter'));
    expect(text).not.toContain(squash('The NCD is issued subject to and with the benefit of the conditions'));
    expect(text).not.toContain(squash('persons claiming by, through, or under any of them'));
  });

  it('still carries the TDS footnote and the three directors', async () => {
    // The paragraph shortened; everything drawn AFTER it must still be there
    // and must not have been pushed off the page.
    expect(text).toContain(squash('*Will be subject to deduction of TDS on interest and applicable Government levies'));
    expect(text).toContain(squash('Avinash Gopalakrishnan'));
    expect(text).toContain(squash('Gokul Govindarajan'));
    expect(text).toContain(squash('Sankar Venkataraman'));
  });
});
