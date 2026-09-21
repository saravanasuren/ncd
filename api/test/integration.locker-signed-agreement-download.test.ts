/**
 * "↓ Signed agreement" must open the right PDF for EVERY signed locker.
 *
 * Three kinds of signed locker exist, and the link used to be chosen in the
 * browser, page by page, by guessing which id to use:
 *
 *   · NATIVE — signed on our own Digio (#421). The file is OURS; LockerHub never
 *     received it, so a link built from LockerHub's esign_id points at nothing.
 *   · LEGACY — signed on LockerHub's own e-Sign before that. NCD holds only a
 *     "Signed" row (no Digio session, no file); the PDF lives on LockerHub.
 *   · NATIVE, but the file never landed — Digio recorded the signature and the
 *     download failed (or Digio returned something that was not a PDF).
 *
 * One route now resolves all three server-side, so no page has to guess.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';
import { completeSigning } from '../src/integrations/digio/service.js';

let ctx: TestCtx;
let lockerhub: http.Server;
let digio: http.Server;
let admin: Client;

// What the two upstreams answer — each test chooses.
let lhEsign: Record<string, unknown> = { found: false, status: null };
let lhPdf: { status: number; body: Buffer | string } = { status: 404, body: '{"error":"Signed agreement not found."}' };
let digioDownload: { status: number; body: Buffer | string } = { status: 503, body: 'down' };

const PDF = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const saved = { lh: config.LOCKERHUB_API_URL, id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET, base: config.DIGIO_BASE };

beforeAll(async () => {
  ctx = await startTestServer();

  lockerhub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/branches') return json(200, { branches: [{ id: 'br_erode_2', name: 'Erode' }, { id: 'br_salem', name: 'Salem' }] });
    if (/\/esign\/status$/.test(url.pathname)) return json(200, lhEsign);
    if (/^\/agreements\/[^/]+\/pdf$/.test(url.pathname)) {
      res.writeHead(lhPdf.status, { 'Content-Type': lhPdf.status === 200 ? 'application/pdf' : 'application/json' });
      return res.end(lhPdf.body);
    }
    return json(404, { error: 'nope' });
  });
  await new Promise<void>((r) => lockerhub.listen(0, '127.0.0.1', r));

  digio = http.createServer((req, res) => {
    if ((req.url ?? '').includes('/document/download')) {
      res.writeHead(digioDownload.status, { 'content-type': 'application/pdf' });
      return res.end(digioDownload.body);
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
const dbOne = async <T>(sql: string, p: unknown[]) => (await ctx.db.query<T & Record<string, unknown>>(sql, p)).rows[0]!;

async function customer(name: string, phone: string, pan: string): Promise<number> {
  const r = await admin.post('/api/customers', { full_name: name, phone, pan, address: '1 Test St' });
  return Number(r.json.id);
}
/** A native-chain signing (a real Digio session exists), signed at Digio. */
async function nativeSigned(appId: string, name: string, phone: string, pan: string) {
  const cid = await customer(name, phone, pan);
  const init = await admin.post(`/api/lockers/applications/${appId}/agreement/esign-initiate`, { customer_id: cid });
  expect(init.status).toBe(200);
  await completeSigning(ctx.db, init.json.digio_request_id, {});
  return Number((await dbOne<{ id: string }>('SELECT id FROM locker_agreement_signings WHERE lockerhub_application_id = $1 ORDER BY id DESC LIMIT 1', [appId])).id);
}

describe('signed.pdf resolves the right source for every kind of signed locker', () => {
  it('NATIVE with the file on disk: serves OUR copy, never asks LockerHub', async () => {
    digioDownload = { status: 200, body: PDF('native-final') };
    const sid = await nativeSigned('LKR-DL-NATIVE', 'Native Hirer', '9741000001', 'AAAPN1111A');
    const stored = await dbOne<{ signed_doc_path: string }>('SELECT signed_doc_path FROM locker_agreement_signings WHERE id = $1', [sid]);
    expect(stored.signed_doc_path).toBeTruthy();
    lhEsign = { found: true, status: 'signed', esign_id: 'lh-would-be-wrong' };   // a decoy
    const r = await admin.raw(url('LKR-DL-NATIVE'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.buffer.toString()).toContain('native-final');
  });

  it('LEGACY (signed on LockerHub, NCD holds only a Signed row): serves LockerHub\'s PDF', async () => {
    const cid = await customer('Legacy Hirer', '9741000002', 'AAAPL2222A');
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, esign_reference, signed_at)
       VALUES ('LKR-DL-LEGACY', $1, 'esign', 'Signed', 'es_legacy_1', now())`, [cid]);
    lhEsign = { found: true, status: 'signed', esign_id: 'es_legacy_1' };
    lhPdf = { status: 200, body: PDF('legacy-lockerhub-copy') };
    const r = await admin.raw(url('LKR-DL-LEGACY'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^inline/);
    expect(r.buffer.toString()).toContain('legacy-lockerhub-copy');
  });

  it('LEGACY but LockerHub has no file: a plain, readable 404 — not a raw UPSTREAM error', async () => {
    const cid = await customer('Legacy Missing', '9741000003', 'AAAPL3333A');
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, signed_at)
       VALUES ('LKR-DL-LEGACY-GONE', $1, 'esign', 'Signed', now())`, [cid]);
    lhEsign = { found: true, status: 'signed', esign_id: 'es_gone' };
    lhPdf = { status: 404, body: '{"error":"Signed agreement not found."}' };
    const r = await admin.req('GET', url('LKR-DL-LEGACY-GONE'));
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_FOUND');
    expect(r.json.error.code).not.toBe('UPSTREAM');
    expect(r.json.error.message).toMatch(/no signed copy/i);
  });

  it('NATIVE, signed at Digio but the file never landed: fetches it on demand and serves it', async () => {
    digioDownload = { status: 503, body: 'down' };                 // the download fails at signing time
    const sid = await nativeSigned('LKR-DL-HEAL', 'Heal Hirer', '9741000004', 'AAAPH4444A');
    const before = await dbOne<{ signed_doc_path: string | null }>('SELECT signed_doc_path FROM locker_agreement_signings WHERE id = $1', [sid]);
    expect(before.signed_doc_path).toBeNull();

    digioDownload = { status: 200, body: PDF('healed-from-digio') }; // Digio is reachable again
    const r = await admin.raw(url('LKR-DL-HEAL'));
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('healed-from-digio');
    const after = await dbOne<{ signed_doc_path: string | null }>('SELECT signed_doc_path FROM locker_agreement_signings WHERE id = $1', [sid]);
    expect(after.signed_doc_path).toBeTruthy();                      // stored, so the next click is instant
  });

  it('a fully SIGNED agreement whose file went missing is healed WITHOUT changing its status', async () => {
    digioDownload = { status: 200, body: PDF('final-both-signed') };
    const sid = await nativeSigned('LKR-DL-SIGNED-LOST', 'Lost Hirer', '9741000007', 'AAAPS7777A');
    const ceo = await admin.post('/api/lockers/applications/LKR-DL-SIGNED-LOST/agreement/ceo-esign-initiate', {});
    expect(ceo.status).toBe(200);
    await completeSigning(ctx.db, ceo.json.digio_request_id, {});
    expect((await dbOne<{ status: string }>('SELECT status FROM locker_agreement_signings WHERE id = $1', [sid])).status).toBe('Signed');

    // The state agreements signed before the download was made reliable can be in:
    // signed at Digio, recorded as Signed, no file behind it.
    await ctx.db.query('UPDATE locker_agreement_signings SET signed_doc_path = NULL WHERE id = $1', [sid]);
    const r = await admin.raw(url('LKR-DL-SIGNED-LOST'));
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('final-both-signed');
    const after = await dbOne<{ status: string; signed_doc_path: string | null }>('SELECT status, signed_doc_path FROM locker_agreement_signings WHERE id = $1', [sid]);
    expect(after.status).toBe('Signed');
    expect(after.signed_doc_path).toBeTruthy();
  });

  it("when Digio refuses the download, the message says WHAT Digio said (the endpoint was never verified against live Digio)", async () => {
    digioDownload = { status: 200, body: PDF('first') };
    const sid = await nativeSigned('LKR-DL-WHY', 'Why Hirer', '9741000008', 'AAAPW8888A');
    await ctx.db.query('UPDATE locker_agreement_signings SET signed_doc_path = NULL WHERE id = $1', [sid]);

    digioDownload = { status: 404, body: '{"message":"Document not found","code":"NOT_FOUND"}' };
    let r = await admin.req('GET', url('LKR-DL-WHY'));
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/signature is recorded/i);
    expect(r.json.error.message).toMatch(/HTTP 404/);
    expect(r.json.error.message).toMatch(/Document not found/);

    digioDownload = { status: 200, body: '<html>login</html>' };
    r = await admin.req('GET', url('LKR-DL-WHY'));
    expect(r.json.error.message).toMatch(/not a PDF/);
  });

  it('Digio answers 200 with something that is NOT a PDF: never stored as "the signed PDF"', async () => {
    digioDownload = { status: 200, body: '{"code":"SOMETHING_WENT_WRONG","message":"try later"}' };
    const sid = await nativeSigned('LKR-DL-NOTPDF', 'Notpdf Hirer', '9741000005', 'AAAPP5555A');
    const row = await dbOne<{ signed_doc_path: string | null }>('SELECT signed_doc_path FROM locker_agreement_signings WHERE id = $1', [sid]);
    expect(row.signed_doc_path).toBeNull();
    const r = await admin.req('GET', url('LKR-DL-NOTPDF'));
    expect(r.status).not.toBe(200);
  });

  it('never signed: 404, not an empty 200', async () => {
    lhEsign = { found: false, status: null };
    const r = await admin.req('GET', url('LKR-DL-NOTHING'));
    expect(r.status).toBe(404);
  });
});

describe('who may open a signed agreement', () => {
  const as = async (email: string, password = 'Demo_1234') => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email, password });
    return c;
  };

  /** A signed locker with its file already ours, on the given LockerHub branch. */
  async function localSigned(appId: string, branchId: string | null) {
    const { saveBuffer } = await import('../src/lib/storage.js');
    const stored = saveBuffer('locker-agreements', `${appId}.pdf`, PDF(`contract-${appId}`));
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status, signed_doc_path, signed_doc_mime, signed_at)
       VALUES ($1, 'esign', 'Signed', $2, 'application/pdf', now())`, [appId, stored.path]);
    if (branchId) {
      await ctx.db.query('INSERT INTO locker_applications (lockerhub_application_id, branch_id) VALUES ($1, $2)', [appId, branchId]);
    }
  }

  let erodeStaff: Client;
  beforeAll(async () => {
    await localSigned('LKR-AZ-ERODE', 'br_erode_2');
    await localSigned('LKR-AZ-SALEM', 'br_salem');
    await localSigned('LKR-AZ-UNINDEXED', null);   // not on our index, and LockerHub does not know it either
    const erodeId = Number((await ctx.db.query("SELECT id FROM branches WHERE code = 'ERD'")).rows[0]!.id);
    const u = await admin.post('/api/users', { email: 'erode.staff@demo.local', full_name: 'Erode Staff', role: 'branch_staff', password: 'Demo_1234', branch_id: erodeId });
    expect(u.status).toBeLessThan(300);
    erodeStaff = await as('erode.staff@demo.local');
  });

  it("a branch_staff user opens their OWN branch's agreement", async () => {
    const r = await erodeStaff.raw(url('LKR-AZ-ERODE'));
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('contract-LKR-AZ-ERODE');
  });

  it("...and is refused another branch's, with no part of the document in the response", async () => {
    const r = await erodeStaff.raw(url('LKR-AZ-SALEM'));
    expect(r.status).toBe(403);
    expect(r.buffer.toString()).toMatch(/another branch/i);
    expect(r.buffer.toString()).not.toContain('contract-LKR-AZ-SALEM');
  });

  it("a restricted user is refused when the locker's branch cannot be determined (fails closed)", async () => {
    const r = await erodeStaff.raw(url('LKR-AZ-UNINDEXED'));
    expect(r.status).toBe(403);
    expect(r.buffer.toString()).toMatch(/confirm which branch/i);
  });

  it("unrestricted roles (admin, branch manager) open any branch's", async () => {
    for (const c of [admin, await as('bm@demo.local')]) {
      for (const id of ['LKR-AZ-ERODE', 'LKR-AZ-SALEM', 'LKR-AZ-UNINDEXED']) {
        expect((await c.raw(url(id))).status).toBe(200);
      }
    }
  });

  it('an agent (no lockers:enroll) is refused outright', async () => {
    const r = await (await as('agent@demo.local')).raw(url('LKR-AZ-ERODE'));
    expect(r.status).toBe(403);
    expect(r.buffer.toString()).not.toContain('contract-');
  });

  it('nobody signed in gets 401', async () => {
    const r = await new Client(ctx.base).raw(url('LKR-AZ-ERODE'));
    expect(r.status).toBe(401);
  });
});
