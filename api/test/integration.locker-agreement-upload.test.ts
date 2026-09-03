/**
 * The signed locker agreement comes back on paper (owner 2026-09-03).
 *
 * The upload does NOT mark the agreement signed. Digio's signature is
 * cryptographic evidence that a named person signed; a scan is evidence that
 * somebody uploaded a file. The second claim is what a checker is for, so the
 * upload raises an approval and the agreement stays unsigned until then.
 *
 * Also pinned here: the body-parser limit. /api/lockers sat on the 2 MB default,
 * so a base64 scan over ~1.5 MB was refused before the upload validator ever
 * saw it — a blocker found while writing this, not after shipping it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
const APP = 'LKR-UP-1';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br_erode', name: 'Erode' }] });
      if (/\/esign\/status$/.test(url.pathname)) return send(200, { found: false, status: null });
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
/** A DISTINCT checker — a maker cannot approve their own request. */
const checker = () => as('ncd@demo.local');

/** A minimal but genuine multi-page PDF: the sniffer reads the magic bytes and
 *  the page counter reads /Type /Page, so both see something real. */
const pdfOf = (pages = 2) =>
  Buffer.from(`%PDF-1.4\n${'1 0 obj\n<< /Type /Page >>\nendobj\n'.repeat(pages)}trailer\n%%EOF\n`).toString('base64');

const rowOf = async (appId = APP) =>
  (await ctx.db.query<Record<string, unknown>>(
    'SELECT * FROM locker_agreement_signings WHERE lockerhub_application_id = $1 ORDER BY id DESC', [appId])).rows[0]!;

const upload = (a: Client, body: Record<string, unknown>, appId = APP) =>
  a.post(`/api/lockers/applications/${appId}/agreement/signed-upload`, body);

describe('uploading the signed scan', () => {
  it('needs the physical method chosen first', async () => {
    const a = await admin();
    const r = await upload(a, { data_base64: pdfOf(), signed_on: '2026-09-01' });
    expect(r.status).toBe(400);
  });

  it('refuses a scan on an agreement set to e-Sign', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-UP-ES/agreement/method', { method: 'esign' });
    const r = await upload(a, { data_base64: pdfOf(), signed_on: '2026-09-01' }, 'LKR-UP-ES');
    expect(r.status).toBe(400);
  });

  it('stores the scan and sends it to a checker, WITHOUT marking it signed', async () => {
    const a = await admin();
    await a.post(`/api/lockers/applications/${APP}/agreement/method`, { method: 'physical' });
    const r = await upload(a, {
      data_base64: pdfOf(4), filename: 'agreement-scan.pdf',
      signed_on: '2026-09-01', signed_at_branch: 'Erode', witness_name: 'Anitha K',
    });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
    expect(r.json.is_signed).toBe(false);
    expect(r.json.label).toBe('Scan awaiting approval');

    const row = await rowOf();
    expect(row.signed_doc_path).toBeTruthy();
    expect(row.signed_doc_mime).toBe('application/pdf');
    expect(row.signed_on).toBe('2026-09-01');
    expect(row.signed_at_branch).toBe('Erode');
    expect(row.witness_name).toBe('Anitha K');
    // Page 1 of a four-page agreement is the commonest scanning mistake, so the
    // count has to reach the checker's card.
    expect(Number(row.signed_doc_pages)).toBe(4);
  });

  it('serves the stored scan back — this IS the agreement on file', async () => {
    const a = await admin();
    const res = await fetch(`${ctx.base}/api/lockers/applications/${APP}/agreement/signed.pdf`,
      { headers: { cookie: a.cookieHeader(), 'X-Requested-With': 'dhanam' } });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a second scan while one is already waiting', async () => {
    const a = await admin();
    const r = await upload(a, { data_base64: pdfOf(), signed_on: '2026-09-01' });
    expect(r.status).toBe(409);
  });

  it('the method cannot be switched out from under a scan awaiting approval', async () => {
    const a = await admin();
    expect((await a.post(`/api/lockers/applications/${APP}/agreement/method`, { method: 'esign' })).status).toBe(409);
  });
});

describe('the checker decides, not the uploader', () => {
  it('the card carries what is needed to judge it — including the document', async () => {
    const a = await admin();
    const reqId = Number((await rowOf()).approval_request_id);
    const card = (await (await checker()).get(`/api/approvals/${reqId}`)).json;
    const facts = JSON.stringify(card.detail.facts);
    expect(facts).toContain('2026-09-01');
    expect(facts).toContain('Erode');
    expect(facts).toContain('Anitha K');
    expect(facts).toContain('4');                                     // pages
    // Approving a document you cannot open is not an approval.
    expect(facts).toContain(`/api/lockers/applications/${APP}/agreement/signed.pdf`);
  });

  it('approving marks it physically signed', async () => {
    const reqId = Number((await rowOf()).approval_request_id);
    expect((await (await checker()).post(`/api/approvals/${reqId}/approve`, { note: 'checked' })).status).toBe(200);

    const a = await admin();
    const { signing } = (await a.get(`/api/lockers/applications/${APP}/agreement`)).json;
    expect(signing.status).toBe('Signed');
    expect(signing.is_signed).toBe(true);
    // Never a bare "signed" — the method is always named.
    expect(signing.label).toBe('Physically signed');
    expect(signing.signed_on).toBe('2026-09-01');
    // PR 4 pushes this to LockerHub; until they ship the endpoint it stays
    // honestly unsynced rather than claiming otherwise.
    expect(signing.lockerhub_synced).toBe(false);
  });

  it('a maker cannot approve their own upload', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-UP-2/agreement/method', { method: 'physical' });
    await upload(a, { data_base64: pdfOf(), signed_on: '2026-09-01' }, 'LKR-UP-2');
    const reqId = Number((await rowOf('LKR-UP-2')).approval_request_id);
    expect((await a.post(`/api/approvals/${reqId}/approve`, { note: 'me' })).status).toBe(403);
  });

  it('a rejected scan reopens for a better one, rather than killing the agreement', async () => {
    // The customer DID sign; the upload was wrong — a missing page, the wrong
    // document, an illegible scan. Starting the whole agreement again would be
    // the wrong remedy.
    const reqId = Number((await rowOf('LKR-UP-2')).approval_request_id);
    expect((await (await checker()).post(`/api/approvals/${reqId}/reject`, { reason: 'page 3 missing' })).status).toBe(200);

    const row = await rowOf('LKR-UP-2');
    expect(row.status).toBe('AwaitingSignature');
    expect(row.signed_doc_path).toBeNull();

    // ...and a corrected scan can go straight back up.
    const a = await admin();
    const again = await upload(a, { data_base64: pdfOf(4), signed_on: '2026-09-01' }, 'LKR-UP-2');
    expect(again.status).toBe(201);
    expect(again.json.status).toBe('PendingApproval');
  });
});

describe('what the upload refuses', () => {
  it('a signing date in the future — it is read off the paper, so that is a typo', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-UP-3/agreement/method', { method: 'physical' });
    const r = await upload(a, { data_base64: pdfOf(), signed_on: '2099-01-01' }, 'LKR-UP-3');
    expect(r.status).toBe(400);
  });

  it('a file that is not a document at all', async () => {
    const a = await admin();
    const r = await upload(a, { data_base64: Buffer.from('just some text').toString('base64'), signed_on: '2026-09-01' }, 'LKR-UP-3');
    expect(r.status).toBe(400);
  });

  it('a scan larger than 5 MB is ACCEPTED — the old cap refused good scans', async () => {
    // A multi-page agreement scanned at 300 dpi routinely lands at 8-15 MB.
    // Both the 5 MB upload cap and the 2 MB body-parser limit on /api/lockers
    // would have rejected this before anyone saw it.
    const a = await admin();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n'), Buffer.alloc(7 * 1024 * 1024, 0x20)]);
    const r = await upload(a, { data_base64: big.toString('base64'), signed_on: '2026-09-01' }, 'LKR-UP-3');
    expect(r.status).toBe(201);
  });
});

describe('abandoning a signing', () => {
  it('cancels it and frees the locker for another attempt', async () => {
    const a = await admin();
    const del = await fetch(`${ctx.base}/api/lockers/applications/LKR-UP-3/agreement`, {
      method: 'DELETE',
      headers: { cookie: a.cookieHeader(), 'X-Requested-With': 'dhanam', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'wrong customer' }),
    });
    expect(del.status).toBe(200);
    expect((await rowOf('LKR-UP-3')).status).toBe('Cancelled');

    const r = await a.post('/api/lockers/applications/LKR-UP-3/agreement/method', { method: 'physical' });
    expect(r.status).toBe(200);
  });

  it('will not cancel an agreement that is already signed', async () => {
    const a = await admin();
    const del = await fetch(`${ctx.base}/api/lockers/applications/${APP}/agreement`, {
      method: 'DELETE',
      headers: { cookie: a.cookieHeader(), 'X-Requested-With': 'dhanam', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(del.status).toBeGreaterThanOrEqual(400);
  });
});
