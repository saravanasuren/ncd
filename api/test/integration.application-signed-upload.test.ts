/**
 * A manual signature on an investment application form (owner 2026-09-03:
 * "check NCD, currently i only see esigning no manual signature upload
 * provisions i get to see, fix it if needed").
 *
 * It was needed. The screen offered "Send for eSign" and "Mark eSigned", and
 * the second stamped `esigned_at` and nothing else — no document, no method,
 * and the word "eSigned" recorded for a form that in practice was signed on
 * paper. A claim we could not evidence and never checked.
 *
 * The form itself was never the gap: it is already pre-filled and already
 * carries signature boxes, because it is the document Digio signs. What was
 * missing was anywhere to put the signed copy, and any record of which way it
 * was signed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const pdfOf = (pages = 3) =>
  Buffer.from(`%PDF-1.4\n${'1 0 obj\n<< /Type /Page >>\nendobj\n'.repeat(pages)}trailer\n%%EOF\n`).toString('base64');

/** An investment to hang a signature on. */
async function enrol(a: Client, name: string, phone: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `8888${phone}`, ifsc: 'ICIC0001111' });
  const series = (await a.get('/api/series')).json.rows?.[0];
  const scheme = (await a.get('/api/schemes')).json.rows?.[0];
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount: 100000, date_money_received: '2026-08-10',
  });
  return Number(app.json.id);
}

const appRow = async (id: number) =>
  (await ctx.db.query<Record<string, unknown>>('SELECT * FROM applications WHERE id = $1', [id])).rows[0]!;

let appId = 0;

describe('the signed application form can be uploaded', () => {
  it('starts with no signature and no method', async () => {
    const a = await admin();
    appId = await enrol(a, 'Signed Form Cust', '9533000001');
    const r = await appRow(appId);
    expect(r.esigned_at).toBeNull();
    expect(r.signing_method).toBeNull();
  });

  it('stores the scan and records it as PHYSICALLY signed', async () => {
    const a = await admin();
    const r = await a.post(`/api/applications/${appId}/signed-upload`, {
      data_base64: pdfOf(3), filename: 'signed-form.pdf', signed_on: '2026-08-28',
    });
    expect(r.status).toBe(201);

    const row = await appRow(appId);
    expect(row.signing_method).toBe('physical');
    expect(row.esigned_at).not.toBeNull();
    // The date on the PAPER, not the day it was scanned.
    expect(row.signed_on).toBe('2026-08-28');
    expect(row.signed_doc_mime).toBe('application/pdf');
    expect(Number(row.signed_doc_pages)).toBe(3);
    expect(row.signed_doc_uploaded_by_user_id).not.toBeNull();
  });

  it('serves the stored scan back', async () => {
    const a = await admin();
    const res = await fetch(`${ctx.base}/api/applications/${appId}/signed-application.pdf`,
      { headers: { cookie: a.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('answers 404 for an investment with no signed form on file', async () => {
    const a = await admin();
    const other = await enrol(a, 'No Scan Cust', '9533000002');
    const res = await fetch(`${ctx.base}/api/applications/${other}/signed-application.pdf`,
      { headers: { cookie: a.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(res.status).toBe(404);
  });
});

// The "records the method it is given" / "defaults to esign" tests that stood
// here are GONE with markESigned() itself (removed 2026-08-29, #376): there is
// no longer any way for a person to assert a signature. 'esign' is now written
// only by the Digio completion path, and 'physical' only by an upload carrying
// a real document — which is what the rest of this file covers.

describe('branch staff can do all three, because they are the ones in the room', () => {
  // Owner 2026-09-04: "get all these access to branch staff login also — esign
  // access and manual sign upload option". Branch staff enrol the investment and
  // sit with the customer, so they are who gets the form signed.
  it('a branch staff member can print, upload, and read back the signed form', async () => {
    // Enrolled BY the staff member, which is the real flow — they sit with the
    // customer. An investment they cannot see 404s on the print, and should:
    // that is scope working, not a missing permission.
    const staff = await as('staff@demo.local');
    const id = await enrol(staff, 'Branch Staff Signed', '9533000008');

    const form = await fetch(`${ctx.base}/api/reports/application-form/${id}.pdf`,
      { headers: { cookie: staff.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(form.status).toBe(200);

    const up = await staff.post(`/api/applications/${id}/signed-upload`, {
      data_base64: pdfOf(2), filename: 'branch-signed.pdf', signed_on: '2026-08-28',
    });
    expect(up.status).toBe(201);
    const row = await appRow(id);
    expect(row.signing_method).toBe('physical');
    expect(row.signed_doc_uploaded_by_user_id).not.toBeNull();

    const back = await fetch(`${ctx.base}/api/applications/${id}/signed-application.pdf`,
      { headers: { cookie: staff.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(back.status).toBe(200);
  });

  it('and still cannot reach an investment outside their scope', async () => {
    const a = await admin();
    const other = await enrol(a, 'Someone Elses', '9533000009');
    const staff = await as('staff@demo.local');
    const form = await fetch(`${ctx.base}/api/reports/application-form/${other}.pdf`,
      { headers: { cookie: staff.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(form.status).toBe(404);
  });
});

describe('what the upload refuses', () => {
  it('a signing date in the future', async () => {
    const a = await admin();
    const id = await enrol(a, 'Future Cust', '9533000005');
    const r = await a.post(`/api/applications/${id}/signed-upload`, { data_base64: pdfOf(), signed_on: '2099-01-01' });
    expect(r.status).toBe(400);
    // ...and nothing is recorded, so a refused upload leaves no half-signed row.
    expect((await appRow(id)).signing_method).toBeNull();
  });

  it('a file that is not a document', async () => {
    const a = await admin();
    const id = await enrol(a, 'Junk Cust', '9533000006');
    const r = await a.post(`/api/applications/${id}/signed-upload`, {
      data_base64: Buffer.from('not a document').toString('base64'), signed_on: '2026-08-28',
    });
    expect(r.status).toBe(400);
  });

  it('accepts a scan well over the old 5 MB cap', async () => {
    // A multi-page form scanned at a branch routinely exceeds it, and both the
    // upload cap and the body-parser limit would have refused this.
    const a = await admin();
    const id = await enrol(a, 'Big Scan Cust', '9533000007');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n'), Buffer.alloc(7 * 1024 * 1024, 0x20)]);
    const r = await a.post(`/api/applications/${id}/signed-upload`, {
      data_base64: big.toString('base64'), signed_on: '2026-08-28',
    });
    expect(r.status).toBe(201);
  });
});
