/**
 * The last two hops of a locker agreement, and what happens when they go wrong.
 *
 * Both are about the same thing: an agreement must never CLAIM more signatures
 * than the file on disk actually carries, and must never end up somewhere no
 * screen can move it on from.
 *
 *   · AwaitingCEO was a trap. Sending the signatory's link moved the row out of
 *     the only queue that lists it, initiateCeoEsign refused every status but
 *     CustomerSigned, and the live-status index blocks starting a fresh
 *     signing. A signatory who never opened the link stranded the locker.
 *   · The hirer-to-hirer hop checks a watermark — whose signatures the stored
 *     file carries — before letting the next person sign. The CEO hop did not,
 *     so a joint agreement whose LAST hirer's download failed (the row still
 *     moves to CustomerSigned) could be counter-signed one holder short.
 *   · And the counter-sign itself marked the agreement Signed even when the
 *     fully-signed copy could not be downloaded, leaving the customer-signed
 *     file behind a label reading "e-Signed".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

/**
 * A LIVE Digio that is having a bad day.
 *
 * The distinction matters: with no Digio configured at all nothing is ever
 * downloaded, for any document — that is stub mode, and completing there is
 * correct. The defect is the CONFIGURED case, where a download that fails is an
 * outage and the file genuinely is missing. So these tests stand up a real
 * endpoint and choose what it returns.
 */
let downloadWorks = false;
async function withDigio<T>(fn: () => Promise<T>): Promise<T> {
  const pdf = Buffer.from('%PDF-1.4 fully signed\n%%EOF\n');
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').includes('/document/download')) {
      if (!downloadWorks) { res.writeHead(503); res.end('upstream down'); return; }
      res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'requested', signers: [{ sign_url: 'about:blank#mock' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const { config } = await import('../src/config.js');
  const saved = { id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET, base: config.DIGIO_BASE };
  Object.assign(config, { DIGIO_CLIENT_ID: 'test', DIGIO_CLIENT_SECRET: 'test', DIGIO_BASE: `http://127.0.0.1:${port}` });
  try {
    return await fn();
  } finally {
    Object.assign(config, { DIGIO_CLIENT_ID: saved.id, DIGIO_CLIENT_SECRET: saved.secret, DIGIO_BASE: saved.base });
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const SOLO = 'LKR-CEO-SOLO';
const JOINT = 'LKR-CEO-JOINT';
const actor = { id: 1 } as never;
const mod = () => import('../src/modules/lockers/agreements.js');
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

async function seed(appId: string, name: string, phone: string): Promise<number> {
  const a = await admin();
  const customerId = Number((await a.post('/api/customers', { full_name: name, phone })).json.id);
  await ctx.db.query(
    `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone, locker_size, status)
     VALUES ($1, $2, $3, $4, 'Large', 'approved')`, [appId, customerId, name, phone]);
  const { chooseMethod } = await mod();
  const s = await chooseMethod(ctx.db, actor, { lockerhub_application_id: appId, method: 'esign', customer_id: customerId });
  return s.id;
}

/** What the chain leaves behind: a real file, and a watermark naming whose
 *  signatures it carries. Split so a test can store a file and deliberately
 *  leave the watermark behind, which is exactly what a failed download does. */
async function storeCustomerSigned(signingId: number, position: number | null) {
  const { saveBuffer } = await import('../src/lib/storage.js');
  const stored = saveBuffer('locker-agreements', `ceo-test-${signingId}.pdf`,
    Buffer.from('%PDF-1.4 customer signed\n%%EOF\n'));
  await ctx.db.query(
    `UPDATE locker_agreement_signings
        SET status = 'CustomerSigned', signed_doc_path = $2, signed_doc_mime = 'application/pdf',
            signed_doc_filename = 'signed.pdf', signed_doc_position = $3, signed_at = now()
      WHERE id = $1`, [signingId, stored.path, position]);
}

describe('the authorised-signatory hop', () => {
  it('names AwaitingCEO instead of calling it "e-Sign started"', async () => {
    const { signingLabel } = await mod();
    expect(signingLabel('esign', 'AwaitingCEO')).toMatch(/signatory/i);
    expect(signingLabel('esign', 'AwaitingCEO')).not.toMatch(/started/i);
  });

  it('keeps a sent agreement in the queue, and lets the link be re-sent', async () => {
    const signingId = await seed(SOLO, 'Ceo Solo', '9715000001');
    await storeCustomerSigned(signingId, 1);
    const { initiateCeoEsign, listAwaitingCeo } = await mod();

    await initiateCeoEsign(ctx.db, actor, SOLO);
    const status = async () => (await ctx.db.query<{ status: string }>(
      'SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!.status;
    expect(await status()).toBe('AwaitingCEO');

    // The trap: before this fix the row vanished from the only screen that acts.
    const queued = (await listAwaitingCeo(ctx.db)).find((r) => r.application_id === SOLO);
    expect(queued).toBeTruthy();
    expect(queued!.status).toBe('AwaitingCEO');
    expect(queued!.final_copy_pending).toBe(false);   // nobody has signed yet

    // Re-sending is the way back, and it supersedes the dead link.
    const first = (await ctx.db.query<{ digio_request_id: string }>(
      `SELECT digio_request_id FROM digio_signing_sessions
        WHERE locker_agreement_signing_id = $1 AND document_type = 'locker_agreement_ceo'
        ORDER BY id DESC LIMIT 1`, [signingId])).rows[0]!.digio_request_id;
    await initiateCeoEsign(ctx.db, actor, SOLO);
    const old = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM digio_signing_sessions WHERE digio_request_id = $1', [first])).rows[0]!.status;
    expect(old).toBe('cancelled');
  });

  it('refuses to counter-sign a joint copy that is one hirer short', async () => {
    const signingId = await seed(JOINT, 'Ceo Joint', '9715000002');
    const { setHirers } = await import('../src/modules/lockers/hirers.js');
    await setHirers(ctx.db, actor, JOINT, [
      { position: 2, full_name: 'Joint Second', phone: '9715000003', pan: 'AAAPJ1111A', dob: '1980-01-01', address: '2 St' },
    ], '9715000002');
    // Hirer 2 signed, their download failed: the row still moved to
    // CustomerSigned, but the file on disk is hirer 1's copy.
    await storeCustomerSigned(signingId, 1);

    const { initiateCeoEsign } = await mod();
    await expect(initiateCeoEsign(ctx.db, actor, JOINT)).rejects.toThrow(/1 of 2 hirers/);

    // Once the copy carries both, it goes through.
    await ctx.db.query('UPDATE locker_agreement_signings SET signed_doc_position = 2 WHERE id = $1', [signingId]);
    const r = await initiateCeoEsign(ctx.db, actor, JOINT);
    expect(r.digio_request_id).toBeTruthy();
  });

  it('does not call an agreement Signed when the counter-signed copy never arrived', async () => {
    const signingId = (await ctx.db.query<{ id: string }>(
      'SELECT id FROM locker_agreement_signings WHERE lockerhub_application_id = $1', [SOLO])).rows[0]!.id;
    const req = (await ctx.db.query<{ digio_request_id: string }>(
      `SELECT digio_request_id FROM digio_signing_sessions
        WHERE locker_agreement_signing_id = $1 AND document_type = 'locker_agreement_ceo' AND status = 'requested'
        ORDER BY id DESC LIMIT 1`, [signingId])).rows[0]!.digio_request_id;

    downloadWorks = false;
    await withDigio(async () => {
      const { completeSigning } = await import('../src/integrations/digio/service.js');
      await completeSigning(ctx.db, req, {});
    });

    const row = (await ctx.db.query<{ status: string; signed_doc_path: string }>(
      'SELECT status, signed_doc_path FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(row.status).toBe('AwaitingCEO');          // NOT 'Signed'
    // The file on disk is still only the customer's copy, which is exactly why
    // calling it Signed was wrong.
    const { readStored } = await import('../src/lib/storage.js');
    expect(readStored(row.signed_doc_path)!.toString()).toContain('customer signed');

    // And the queue says so, asking for the file rather than another link.
    const { listAwaitingCeo } = await mod();
    const queued = (await listAwaitingCeo(ctx.db)).find((r) => r.application_id === SOLO);
    expect(queued!.final_copy_pending).toBe(true);
  });

  it('completes the agreement once the signed copy is fetched', async () => {
    // Digio reachable again. Without this route the session is already
    // 'signed', so completeSigning treats every later webhook as a duplicate
    // and the file would never be chased again.
    downloadWorks = true;
    await withDigio(async () => {
      const { fetchSignedCopy, getSignedDocument } = await mod();
      const r = await fetchSignedCopy(ctx.db, actor, SOLO);
      expect(r.status).toBe('Signed');
      const doc = await getSignedDocument(ctx.db, SOLO);
      expect(doc!.buffer.toString()).toContain('fully signed');
    });
  });
});
