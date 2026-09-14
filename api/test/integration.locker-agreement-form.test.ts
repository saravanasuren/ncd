/**
 * The printed locker agreement is PRE-FILLED (owner 2026-09-03: "it should not
 * be a blank application form, everything should be pre filled. only the
 * signing we have 2 ways").
 *
 * The customer is handed a finished document and writes one thing on it: their
 * signature. So these read the generated PDF's text and assert the particulars
 * are actually ON it — a form that renders without error but prints an empty
 * name field would pass a smoke test and fail the requirement completely.
 *
 * Also pinned: the Aadhaar is NOT printed. It is not needed to hire a locker,
 * and a full number on a page photocopied at a branch counter is the exact
 * disclosure the Aadhaar Act §29 exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { extractText } from './helpers/pdf-text.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
const APP = 'LKR-FORM-1';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br_erode', name: 'Erode' }] });
      if (/\/esign\/status$/.test(url.pathname)) return send(200, { found: false, status: null });
      const reqApp = decodeURIComponent(url.pathname.split('/')[2] ?? '');
      if (/^\/locker-applications\/[^/]+$/.test(url.pathname)) return send(200, {
        // Only the worked example carries the phone that matches an NCD
        // customer; the others are deliberately unknown to us.
        application_id: reqApp, phone: reqApp === APP ? '9532000001' : '9999000000',
        locker_size: 'M', branch_id: 'br_erode',
        allotment: { locker_number: 'B-07', allotted_on: '2026-08-01' },
        lease_start: '2026-08-01', lease_expires_on: '2027-07-31',
        legs: { rent: { amount: 23600 }, deposit: { amount: 300000 } },
      });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  config.LOCKERHUB_API_URL = '';
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');


async function pdfText(c: Client, path: string): Promise<{ status: number; text: string; raw: Buffer }> {
  const res = await fetch(`${ctx.base}${path}`, { headers: { cookie: c.cookieHeader(), 'X-Requested-With': 'dhanam' } });
  const raw = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return { status: res.status, text: raw.length ? extractText(raw) : '', raw };
}

let customerId = 0;

describe('the printed agreement carries everything we already know', () => {
  it('sets up a customer with a full profile and a nominee', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', {
      full_name: 'Kalaiselvi R', phone: '9532000001', pan: 'AZKPK4411D',
      dob: '1972-06-11', email: 'kalai@example.com',
      address: '22 Perundurai Road', city: 'Erode', state: 'Tamil Nadu', pincode: '638011',
    });
    customerId = Number(r.json.id);
    expect(customerId).toBeGreaterThan(0);
    await a.put(`/api/customers/${customerId}/nominees`, {
      nominees: [{ full_name: 'Murugan R', relationship: 'Spouse', phone: '9532000002' }],
    });
    await a.post(`/api/lockers/applications/${APP}/agreement/method`, { method: 'physical', customer_id: customerId });
  });

  it('prints the hirer, not a blank form', async () => {
    const a = await admin();
    const { status, text, raw } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(status).toBe(200);
    expect(raw.subarray(0, 5).toString()).toBe('%PDF-');
    expect(text).toContain('Kalaiselvi R');
    expect(text).toContain('AZKPK4411D');
    expect(text).toContain('9532000001');
    expect(text).toContain('22 Perundurai Road');
  });

  it('prints the locker as LockerHub holds it', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(text).toContain('B-07');
    expect(text).toContain('Erode');          // branch resolved from branch_id
    expect(text).toContain(APP);
  });

  it('prints the nominee already on file', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(text).toContain('Murugan R');
    expect(text).toContain('Spouse');
  });

  /**
   * pdf-parse loses the spaces between words in a JUSTIFIED paragraph — PDFKit
   * positions each word itself, so the extractor has no space glyph to find.
   * The rendered page is correct (checked visually); only the extraction is
   * lossy. Compare with punctuation and spacing stripped from BOTH sides, so an
   * assertion tests the words rather than the extractor's rendering of them.
   */
  const squash = (t: string) => t.replace(/[^A-Za-z0-9]/g, '');
  const has = (text: string, needle: string) => squash(text).includes(squash(needle));

  // The owner's document (AGREEMENT 04-SEP.pdf) replaced the ten house-written
  // clauses on 2026-09-08. These assert the SHAPE of that document — both
  // annexures, the operative clause headings and the signature blocks — rather
  // than sampling prose, because the failure worth catching is a whole section
  // silently dropping out of the print, not a reworded sentence.
  it('prints both annexures of the agreement', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    for (const n of ['ANNEXURE I', 'SCHEDULE', 'ANNEXURE II', 'SAFE DEPOSIT LOCKER AGREEMENT']) {
      expect(has(text, n), n).toBe(true);
    }
  });

  it('prints every numbered section of the terms', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    for (const head of [
      '1. LOCKER LICENCE',
      '2. CUSTOMER\u2019S UNDERTAKINGS AND OBLIGATIONS',
      '3. THE COMPANY\u2019S RIGHTS',
      '3.2 Termination of License',
      '3.3 Breaking open of the Locker',
      '3.4 Delay in Payment',
      '3.5 Event of shifting of branch',
      '5. LAW AND JURISDICTION',
    ]) {
      expect(has(text, head), head).toBe(true);
    }
    // Clause 4 (Security Deposit) is struck (owner 2026-09-14: "remove the
    // deposit one completely"). The headings either side of the gap are asserted
    // above, so this is a real absence and not an unreadable page.
    //
    // Case-INSENSITIVE: the struck heading was title-case ("4. Security
    // Deposit"), so an upper-case needle through has() would pass against a
    // document that still carried the clause.
    expect(squash(text).toLowerCase()).not.toContain(squash('security deposit'));
    // The last clause of the longest section: proof the terms are not truncated
    // part-way through a page break.
    expect(has(text, 'Auction Notice')).toBe(true);
  });

  it('prints the schedule fields the branch has to fill or check', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    for (const n of [
      'LOCKER RENT PER ANNUM', 'PERIOD OF LICENCE', 'LOCKER OPERATION MANDATES',
      'Key Number',              // issued at the counter
      'Hirer 2',                 // a joint hiring stays possible on paper
      'VERNACULAR UNDERTAKING', 'Signature of Customers',
    ]) {
      expect(has(text, n), n).toBe(true);
    }
  });

  it('the vernacular undertaking carries the English wording in full', async () => {
    // Tamil and Hindi need a Unicode font this repo does not have, so English
    // is the only limb printed. If it ever goes missing the customer signs a
    // declaration with nothing to declare.
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(has(text, 'read and understood all the above terms and conditions')).toBe(true);
    expect(has(text, 'unconditionally accept them')).toBe(true);
  });

  it('never prints the Aadhaar', async () => {
    const a = await admin();
    await ctx.db.query('UPDATE customers SET aadhaar = $1 WHERE id = $2', ['123456789012', customerId]);
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    // A positive assertion FIRST. Without it this test passes whenever the
    // extraction breaks — which it silently did twice while this was written.
    expect(text).toContain('Kalaiselvi R');
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('Aadhaar');
  });
});

describe('generating the form moves the signing on', () => {
  it('marks it awaiting a signature, and records when it was printed', async () => {
    const r = (await ctx.db.query<Record<string, unknown>>(
      'SELECT status, form_generated_at FROM locker_agreement_signings WHERE lockerhub_application_id = $1', [APP])).rows[0]!;
    expect(r.status).toBe('AwaitingSignature');
    // "Printed on the 3rd, still not back on the 20th" has to be answerable.
    expect(r.form_generated_at).not.toBeNull();
  });
});

describe('what it refuses to print', () => {
  it('refuses when the agreement is set to e-Sign', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-FORM-2/agreement/method', { method: 'esign' });
    const { status } = await pdfText(a, '/api/lockers/applications/LKR-FORM-2/agreement/form.pdf');
    expect(status).toBe(400);
  });

  it('refuses when no signing has been started at all', async () => {
    const a = await admin();
    const { status } = await pdfText(a, '/api/lockers/applications/LKR-FORM-NONE/agreement/form.pdf');
    expect(status).toBe(400);
  });

  it('refuses rather than print an agreement with no hirer on it', async () => {
    // No customer_id on the row and no NCD customer on that phone: the most
    // important field on the page would be blank.
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-FORM-3/agreement/method', { method: 'physical' });
    const { status } = await pdfText(a, '/api/lockers/applications/LKR-FORM-3/agreement/form.pdf');
    expect(status).toBe(400);
  });

  it('refuses once the agreement is already signed', async () => {
    const a = await admin();
    await ctx.db.query(
      `UPDATE locker_agreement_signings SET status = 'Signed', signed_at = now()
        WHERE lockerhub_application_id = $1`, [APP]);
    const { status } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(status).toBe(409);
  });
});
