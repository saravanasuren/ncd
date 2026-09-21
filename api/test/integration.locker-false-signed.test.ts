/**
 * "Signed · e-Sign" on screen, "Nobody has e-signed this agreement yet" on click.
 *
 * Before 18 Sep (#450) every load of the enrolment or profile page ran
 * syncFromEsignStatus, which stamped a NATIVE agreement `Signed` whenever
 * LockerHub's own, unrelated e-Sign status read "signed" — with no Digio
 * signature recorded and no file. #450 stopped new rows being corrupted; the
 * rows already flipped stayed exactly like that: status Signed, Digio sessions
 * that were never signed, nothing to download.
 *
 * What a click on such a row must do, in order:
 *   1. ask Digio — a signature that really happened but was never recorded (the
 *      poller was blind until #451) is recorded through the normal path, and the
 *      file is served;
 *   2. ask LockerHub — the flip may have been RIGHT, because they hold a signed
 *      copy;
 *   3. only when both positively say "nothing is signed", stop claiming it is.
 * And on any doubt (either side unreachable) change nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let lockerhub: http.Server;
let digio: http.Server;
let admin: Client;

let lhEsign: Record<string, unknown> | 'down' = { found: false, status: null };
let lhPdf: { status: number; body: Buffer | string } = { status: 404, body: '{"error":"Signed agreement not found."}' };
let digioStatus: { code: number; status: string } = { code: 200, status: 'requested' };
let digioDownload: { status: number; body: Buffer | string } = { status: 200, body: '' };

const PDF = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const saved = { lh: config.LOCKERHUB_API_URL, id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET, base: config.DIGIO_BASE };

beforeAll(async () => {
  ctx = await startTestServer();
  lockerhub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/\/esign\/status$/.test(url.pathname)) return lhEsign === 'down' ? json(503, { error: 'down' }) : json(200, lhEsign);
    if (/^\/agreements\/[^/]+\/pdf$/.test(url.pathname)) {
      res.writeHead(lhPdf.status, { 'Content-Type': lhPdf.status === 200 ? 'application/pdf' : 'application/json' });
      return res.end(lhPdf.body);
    }
    return json(404, { error: 'nope' });
  });
  await new Promise<void>((r) => lockerhub.listen(0, '127.0.0.1', r));

  digio = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (u.includes('/document/download')) { res.writeHead(digioDownload.status, { 'content-type': 'application/pdf' }); return res.end(digioDownload.body); }
    // GET /v2/client/document/{id} — the status call (#451). POST .../uploadpdf creates one.
    if (req.method === 'GET' && /\/v2\/client\/document\/[^/?]+$/.test(u)) {
      res.writeHead(digioStatus.code, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ agreement_status: digioStatus.status }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'requested', signers: [{ sign_url: 'about:blank#mock' }] }));
  });
  await new Promise<void>((r) => digio.listen(0, '127.0.0.1', r));

  Object.assign(config, {
    LOCKERHUB_API_URL: `http://127.0.0.1:${(lockerhub.address() as { port: number }).port}`,
    DIGIO_CLIENT_ID: 'test', DIGIO_CLIENT_SECRET: 'test',
    DIGIO_BASE: `http://127.0.0.1:${(digio.address() as { port: number }).port}`,
  });
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
});
afterAll(async () => {
  Object.assign(config, { LOCKERHUB_API_URL: saved.lh, DIGIO_CLIENT_ID: saved.id, DIGIO_CLIENT_SECRET: saved.secret, DIGIO_BASE: saved.base });
  await new Promise<void>((r) => lockerhub.close(() => r()));
  await new Promise<void>((r) => digio.close(() => r()));
  await ctx.close();
});

const url = (appId: string) => `/api/lockers/applications/${appId}/agreement/signed.pdf`;
const one = async <T>(sql: string, p: unknown[]) => (await ctx.db.query<T & Record<string, unknown>>(sql, p)).rows[0]!;

/** The corrupted state: a real native chain started (a Digio session exists,
 *  never signed), then the row is stamped Signed the way the old sync did. */
async function falselySigned(appId: string, name: string, phone: string, pan: string) {
  digioStatus = { code: 200, status: 'requested' };
  const c = await admin.post('/api/customers', { full_name: name, phone, pan, address: '1 Test St' });
  const init = await admin.post(`/api/lockers/applications/${appId}/agreement/esign-initiate`, { customer_id: Number(c.json.id) });
  expect(init.status).toBe(200);
  await ctx.db.query(
    `UPDATE locker_agreement_signings SET status = 'Signed', signed_at = now(), esign_reference = 'legacy-unrelated' WHERE lockerhub_application_id = $1`, [appId]);
  const sid = Number((await one<{ id: string }>('SELECT id FROM locker_agreement_signings WHERE lockerhub_application_id = $1', [appId])).id);
  const sess = await one<{ status: string }>('SELECT status FROM digio_signing_sessions WHERE locker_agreement_signing_id = $1', [sid]);
  expect(sess.status).toBe('requested');   // the link went out; nobody signed
  return sid;
}
const row = (sid: number) => one<{ status: string; signed_doc_path: string | null; signed_at: string | null }>(
  'SELECT status, signed_doc_path, signed_at FROM locker_agreement_signings WHERE id = $1', [sid]);

describe('a Signed row with no signature behind it', () => {
  it('Digio has it signed but NCD never recorded it (poller was blind): records it, stores the file, serves it', async () => {
    const sid = await falselySigned('LKR-FS-DIGIO', 'Digio Had It', '9751000001', 'AAAPD1111A');
    lhEsign = { found: false, status: null };
    digioStatus = { code: 200, status: 'completed' };
    digioDownload = { status: 200, body: PDF('customer-signed-at-digio') };
    const r = await admin.raw(url('LKR-FS-DIGIO'));
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('customer-signed-at-digio');
    const after = await row(sid);
    expect(after.signed_doc_path).toBeTruthy();
    // The row now says what is TRUE: the customer signed, the authorised signatory has not.
    expect(after.status).toBe('CustomerSigned');
    const sess = await one<{ status: string }>('SELECT status FROM digio_signing_sessions WHERE locker_agreement_signing_id = $1', [sid]);
    expect(sess.status).toBe('signed');
  });

  it('LockerHub has the signed copy (the flip was right): serves it, changes nothing', async () => {
    const sid = await falselySigned('LKR-FS-LH', 'Lockerhub Had It', '9751000002', 'AAAPL2222A');
    digioStatus = { code: 200, status: 'requested' };
    lhEsign = { found: true, status: 'signed', esign_id: 'es_true' };
    lhPdf = { status: 200, body: PDF('lockerhub-signed-copy') };
    const r = await admin.raw(url('LKR-FS-LH'));
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('lockerhub-signed-copy');
    expect((await row(sid)).status).toBe('Signed');
  });

  it('neither Digio nor LockerHub has a signature: says so, and stops claiming the agreement is signed', async () => {
    const sid = await falselySigned('LKR-FS-NONE', 'Nobody Signed', '9751000003', 'AAAPN3333A');
    digioStatus = { code: 200, status: 'requested' };
    lhEsign = { found: true, status: 'pending', esign_id: 'es_pending' };
    const r = await admin.req('GET', url('LKR-FS-NONE'));
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/marked (as )?signed/i);
    expect(r.json.error.message).toMatch(/re-send|awaiting/i);
    const after = await row(sid);
    expect(after.status).toBe('AwaitingSignature');
    expect(after.signed_at).toBeNull();
    // The truth is now visible everywhere the status is read.
    const view = await admin.get(`/api/lockers/applications/LKR-FS-NONE/agreement`);
    expect(view.json.signing.is_signed).toBe(false);
  });

  it('Digio cannot be reached: changes NOTHING (an unanswered question is not "unsigned")', async () => {
    const sid = await falselySigned('LKR-FS-DIGIODOWN', 'Digio Down', '9751000004', 'AAAPD4444A');
    digioStatus = { code: 503, status: '' };
    lhEsign = { found: false, status: null };
    const r = await admin.req('GET', url('LKR-FS-DIGIODOWN'));
    expect(r.status).not.toBe(200);
    expect((await row(sid)).status).toBe('Signed');
  });

  it('LockerHub cannot be reached: changes NOTHING', async () => {
    const sid = await falselySigned('LKR-FS-LHDOWN', 'Lockerhub Down', '9751000005', 'AAAPH5555A');
    digioStatus = { code: 200, status: 'requested' };
    lhEsign = 'down';
    const r = await admin.req('GET', url('LKR-FS-LHDOWN'));
    expect(r.status).not.toBe(200);
    expect((await row(sid)).status).toBe('Signed');
    lhEsign = { found: false, status: null };
  });

  it('the bulk tool lists exactly the unbacked rows, and a dry run writes NOTHING', async () => {
    const { listFalselySigned, reconcileSignedClaim } = await import('../src/modules/lockers/agreements.js');
    const sid = await falselySigned('LKR-FS-DRY', 'Dry Run', '9751000007', 'AAAPD7777A');

    const listed = (await listFalselySigned(ctx.db)).map((r) => r.lockerhub_application_id);
    expect(listed).toContain('LKR-FS-DRY');
    // backed by a signed session, or with no Digio sessions at all: never listed
    expect(listed).not.toContain('LKR-FS-TRUE');
    await ctx.db.query(`INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status, signed_at) VALUES ('LKR-FS-LEGACYROW', 'esign', 'Signed', now())`);
    expect((await listFalselySigned(ctx.db)).map((r) => r.lockerhub_application_id)).not.toContain('LKR-FS-LEGACYROW');

    digioStatus = { code: 200, status: 'requested' };
    lhEsign = { found: false, status: null };
    const before = await ctx.db.query('SELECT count(*) AS n FROM audit_log');
    const v = await reconcileSignedClaim(ctx.db, null, 'LKR-FS-DRY', { apply: false });
    expect(v.verdict).toBe('unsupported');                       // what --commit WOULD do…
    expect((await row(sid)).status).toBe('Signed');              // …but it has not
    expect((await ctx.db.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n).toEqual(before.rows[0]!.n);
    const sess = await one<{ status: string }>('SELECT status FROM digio_signing_sessions WHERE locker_agreement_signing_id = $1', [sid]);
    expect(sess.status).toBe('requested');

    digioStatus = { code: 200, status: 'completed' };            // and a dry run that FINDS a signature still records nothing
    expect((await reconcileSignedClaim(ctx.db, null, 'LKR-FS-DRY', { apply: false })).verdict).toBe('recovered');
    expect((await one<{ status: string }>('SELECT status FROM digio_signing_sessions WHERE locker_agreement_signing_id = $1', [sid])).status).toBe('requested');
    expect((await row(sid)).signed_doc_path).toBeNull();
  });

  it('a genuinely signed agreement is never second-guessed', async () => {
    digioStatus = { code: 200, status: 'completed' };
    digioDownload = { status: 200, body: PDF('final') };
    const c = await admin.post('/api/customers', { full_name: 'Truly Signed', phone: '9751000006', pan: 'AAAPT6666A', address: '1 St' });
    const init = await admin.post(`/api/lockers/applications/LKR-FS-TRUE/agreement/esign-initiate`, { customer_id: Number(c.json.id) });
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    await completeSigning(ctx.db, init.json.digio_request_id, {});
    const ceo = await admin.post(`/api/lockers/applications/LKR-FS-TRUE/agreement/ceo-esign-initiate`, {});
    await completeSigning(ctx.db, ceo.json.digio_request_id, {});
    digioStatus = { code: 200, status: 'requested' };      // a hostile Digio answer must not matter
    const r = await admin.raw(url('LKR-FS-TRUE'));
    expect(r.status).toBe(200);
    const sid = Number((await one<{ id: string }>('SELECT id FROM locker_agreement_signings WHERE lockerhub_application_id = $1', ['LKR-FS-TRUE'])).id);
    expect((await row(sid)).status).toBe('Signed');
  });
});
