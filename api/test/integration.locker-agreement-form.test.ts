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
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
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

/**
 * The PDF's visible text.
 *
 * PDFKit deflates its content streams, so reading the raw bytes finds nothing —
 * and a `not.toContain` against those raw bytes PASSES for every string on
 * earth, which is how the first cut of the Aadhaar test here passed while
 * proving nothing. Inflate every stream and pull the literals out of the text
 * operators, so both the positive and the negative assertions mean something.
 */
function extractText(pdf: Buffer): string {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); }
    catch { continue; }
    // An embedded font inflates cleanly too, and its binary contains plenty of
    // parenthesised byte runs — harvesting those produced convincing garbage.
    // A CONTENT stream is the one with a BT/ET text block in it.
    if (!body.includes('BT')) continue;
    // PDFKit emits the text as HEX strings inside a TJ array —
    // [<48454c4c4f> 0] TJ — not as (literal) strings, which is why the obvious
    // paren-matching extraction reads an empty document. Handle both.
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

  it('prints the terms the customer is agreeing to', async () => {
    const a = await admin();
    const { text } = await pdfText(a, `/api/lockers/applications/${APP}/agreement/form.pdf`);
    expect(text).toContain('TERMS OF HIRING');
    expect(text).toContain('DECLARATION');
    expect(text).toContain('Signature of the hirer');
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
