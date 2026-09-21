/**
 * ops/diagnose-locker-agreement.mjs — the read-only tool that pins the exact
 * failure point for ONE agreement's signed PDF. Each way the retrieval can fail
 * must come out as a DIFFERENT verdict, and it must change nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let digio: http.Server;
let digioBase = '';
let digioState = { statusCode: 200, agreementStatus: 'completed', dlStatus: 200, dlBody: '' as Buffer | string };
const PDF = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const serviceDir = mkdtempSync(join(tmpdir(), 'diag-service-'));
const scriptDir = mkdtempSync(join(tmpdir(), 'diag-script-'));
let diagnose: (p: unknown) => Promise<{ text: string; failurePoint: string }>;

beforeAll(async () => {
  ctx = await startTestServer();
  digio = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (u.includes('/document/download')) { res.writeHead(digioState.dlStatus, { 'content-type': digioState.dlStatus === 200 ? 'application/pdf' : 'application/json' }); return res.end(digioState.dlBody); }
    res.writeHead(digioState.statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ agreement_status: digioState.agreementStatus }));
  });
  await new Promise<void>((r) => digio.listen(0, '127.0.0.1', r));
  digioBase = `http://127.0.0.1:${(digio.address() as { port: number }).port}`;
  ({ diagnose } = await import(new URL('../../ops/diagnose-locker-agreement.mjs', import.meta.url).href));
});
afterAll(async () => { await new Promise<void>((r) => digio.close(() => r())); await ctx.close(); });

let n = 0;
/** A signing row with a saved reference, plus optional Digio sessions. */
async function seedSigning(opts: { path: string | null; sessions?: Array<{ status: string; type?: string }> }) {
  const appId = `LKR-DIAG-${++n}`;
  const s = await ctx.db.query<{ id: string }>(
    `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status, signed_doc_path, signed_doc_mime, signed_at)
     VALUES ($1, 'esign', 'Signed', $2, 'application/pdf', now()) RETURNING id`, [appId, opts.path]);
  const sid = Number(s.rows[0]!.id);
  for (const [i, sess] of (opts.sessions ?? []).entries()) {
    await ctx.db.query(
      `INSERT INTO digio_signing_sessions (digio_request_id, status, document_type, locker_agreement_signing_id, signer_position)
       VALUES ($1, $2, $3, $4, $5)`, [`DID-${appId}-${i}`, sess.status, sess.type ?? 'locker_agreement', sid, i + 1]);
  }
  return { appId, sid };
}
const put = (dir: string, rel: string, body: Buffer) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), body);
};
const run = (appId: string) => diagnose({ db: ctx.db, appId, serviceDir, otherDirs: [scriptDir], digio: { base: digioBase, id: 'x', secret: 'y' } });
const REL = 'locker-agreements/abcd1234abcd1234-locker-agreement-signed-1.pdf';

describe('each way the retrieval can fail is a different verdict', () => {
  it('file is in the directory the service reads', async () => {
    const { appId } = await seedSigning({ path: REL, sessions: [{ status: 'signed' }] });
    put(serviceDir, REL, PDF('here'));
    const r = await run(appId);
    expect(r.failurePoint).toMatch(/WHERE THE SERVICE READS IT/);
    expect(r.text).toMatch(/FOUND\s+\d+ bytes, starts "%PDF-1\.4/);
  });

  it('CONFIRMS the misplaced-file cause: reference saved, file only in the script directory', async () => {
    const rel = 'locker-agreements/ffff0000ffff0000-locker-agreement-signed-2.pdf';
    const { appId } = await seedSigning({ path: rel, sessions: [{ status: 'signed' }] });
    put(scriptDir, rel, PDF('wrong place'));
    const r = await run(appId);
    expect(r.failurePoint).toMatch(/WRONG PLACE/);
    expect(r.text).toContain(`the file exists, but in ${scriptDir}`);
    expect(r.text).toContain(`The deployed download reads ONLY: ${serviceDir}`);
  });

  it('reference saved, file nowhere, Digio hands the PDF over: recoverable', async () => {
    digioState = { statusCode: 200, agreementStatus: 'completed', dlStatus: 200, dlBody: PDF('digio') };
    const { appId } = await seedSigning({ path: 'locker-agreements/0000000000000000-gone-1.pdf', sessions: [{ status: 'signed' }] });
    const r = await run(appId);
    expect(r.failurePoint).toMatch(/MISSING EVERYWHERE.*Digio hands the PDF over/);
    expect(r.text).toMatch(/Digio download: HTTP 200.*IS A PDF/);
  });

  it("reference saved, file nowhere, Digio's download answers an error: THAT call is the failure", async () => {
    digioState = { statusCode: 200, agreementStatus: 'completed', dlStatus: 404, dlBody: '{"message":"Document not found","code":"NOT_FOUND"}' };
    const { appId } = await seedSigning({ path: 'locker-agreements/0000000000000001-gone-2.pdf', sessions: [{ status: 'signed' }] });
    const r = await run(appId);
    expect(r.failurePoint).toMatch(/NEVER OBTAINED.*HTTP 404.*Document not found/);
    expect(r.text).toMatch(/Digio status\s+: HTTP 200\s+agreement_status=completed/);
  });

  it('no reference and no signed session: the signature was never recorded', async () => {
    digioState = { statusCode: 200, agreementStatus: 'completed', dlStatus: 200, dlBody: PDF('digio') };
    const { appId } = await seedSigning({ path: null, sessions: [{ status: 'requested' }] });
    const r = await run(appId);
    expect(r.failurePoint).toMatch(/NO SIGNATURE RECORDED.*Digio DOES hand over a PDF/);
  });

  it('a stored file that is not a PDF is called out', async () => {
    const rel = 'locker-agreements/1111111111111111-locker-agreement-signed-3.pdf';
    const { appId } = await seedSigning({ path: rel, sessions: [{ status: 'signed' }] });
    put(serviceDir, rel, Buffer.from('{"error":"nope"}'));
    expect((await run(appId)).failurePoint).toMatch(/NOT A PDF/);
  });

  it('an id with no signing record says so', async () => {
    expect((await run('LKR-DIAG-NOPE')).failurePoint).toMatch(/NO-RECORD/);
  });
});

describe('it is strictly read-only', () => {
  it('changes no row, writes no audit entry, saves no file', async () => {
    digioState = { statusCode: 200, agreementStatus: 'completed', dlStatus: 200, dlBody: PDF('digio') };
    const { appId } = await seedSigning({ path: 'locker-agreements/2222222222222222-gone-3.pdf', sessions: [{ status: 'requested' }, { status: 'signed' }] });
    const snap = async () => JSON.stringify({
      signings: (await ctx.db.query('SELECT * FROM locker_agreement_signings ORDER BY id')).rows,
      sessions: (await ctx.db.query('SELECT * FROM digio_signing_sessions ORDER BY id')).rows,
      audit: (await ctx.db.query('SELECT count(*) AS n FROM audit_log')).rows,
      files: [readdirSafe(join(serviceDir, 'locker-agreements')), readdirSafe(join(scriptDir, 'locker-agreements'))],
    });
    const before = await snap();
    await run(appId);
    expect(await snap()).toEqual(before);
  });

  it('never prints the Digio credentials', async () => {
    const { appId } = await seedSigning({ path: null, sessions: [{ status: 'requested' }] });
    const r = await diagnose({ db: ctx.db, appId, serviceDir, otherDirs: [], digio: { base: digioBase, id: 'SECRET-CLIENT-ID', secret: 'SECRET-CLIENT-SECRET' } });
    expect(r.text).not.toContain('SECRET-CLIENT');
    expect(r.text).not.toContain(Buffer.from('SECRET-CLIENT-ID:SECRET-CLIENT-SECRET').toString('base64'));
  });
});

function readdirSafe(d: string): string[] { try { return readdirSync(d).sort(); } catch { return []; } }
