/**
 * "Signed, the reference is saved, and the file cannot be fetched."
 *
 * In production the service is started by systemd with FILE_STORAGE_DIR set
 * (ops/dhanam-newwealth.service) — and that variable is in the UNIT, not in .env.
 * A script run from a shell (`reconcile:digio --commit`, following its own
 * documented procedure: `set -a && . ./.env`) therefore has NO FILE_STORAGE_DIR,
 * and storage.ts falls back to <cwd>/data/uploads. completeSigning then records
 * the signature, saves the reference in the database, and puts the PDF in a
 * directory the running service never reads.
 *
 * Reproduced here with the real code: a signing completed "as the script" (env
 * unset), then read "as the service" (env set to a different directory), with
 * Digio unreachable so nothing can re-download the file and mask the problem.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';
import { completeSigning } from '../src/integrations/digio/service.js';
import { saveBuffer, readStored, requireServiceStorageDir } from '../src/lib/storage.js';

let ctx: TestCtx;
let digio: http.Server;
let admin: Client;
let digioDownload: { status: number; body: Buffer | string } = { status: 200, body: '' };
const PDF = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const saved = { id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET, base: config.DIGIO_BASE, dir: process.env.FILE_STORAGE_DIR };
const serviceDir = mkdtempSync(join(tmpdir(), 'ncd-service-'));

beforeAll(async () => {
  ctx = await startTestServer();
  digio = http.createServer((req, res) => {
    if ((req.url ?? '').includes('/document/download')) { res.writeHead(digioDownload.status, { 'content-type': 'application/pdf' }); return res.end(digioDownload.body); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'requested', signers: [{ sign_url: 'about:blank#mock' }] }));
  });
  await new Promise<void>((r) => digio.listen(0, '127.0.0.1', r));
  Object.assign(config, { DIGIO_CLIENT_ID: 't', DIGIO_CLIENT_SECRET: 't', DIGIO_BASE: `http://127.0.0.1:${(digio.address() as { port: number }).port}` });
  delete process.env.FILE_STORAGE_DIR;
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
});
afterAll(async () => {
  Object.assign(config, { DIGIO_CLIENT_ID: saved.id, DIGIO_CLIENT_SECRET: saved.secret, DIGIO_BASE: saved.base });
  if (saved.dir === undefined) delete process.env.FILE_STORAGE_DIR; else process.env.FILE_STORAGE_DIR = saved.dir;
  await new Promise<void>((r) => digio.close(() => r()));
  await ctx.close();
});

describe('a file written by a shell script must still be readable by the service', () => {
  it('signed by a script (no FILE_STORAGE_DIR), fetched by the service (FILE_STORAGE_DIR set), Digio down', async () => {
    // ── the script: env unset, exactly as `set -a && . ./.env` leaves it ──
    delete process.env.FILE_STORAGE_DIR;
    digioDownload = { status: 200, body: PDF('customer-signed-by-script') };
    const c = await admin.post('/api/customers', { full_name: 'Script Signed', phone: '9771000001', pan: 'AAAPS1111A', address: '1 St' });
    const init = await admin.post('/api/lockers/applications/LKR-SL-1/agreement/esign-initiate', { customer_id: Number(c.json.id) });
    await completeSigning(ctx.db, init.json.digio_request_id, {});
    const row = (await ctx.db.query<{ signed_doc_path: string | null; status: string }>(
      "SELECT signed_doc_path, status FROM locker_agreement_signings WHERE lockerhub_application_id = 'LKR-SL-1'")).rows[0]!;
    expect(row.signed_doc_path).toBeTruthy();                 // the reference IS saved

    // ── the service: env set to its own directory; Digio cannot re-supply the file ──
    process.env.FILE_STORAGE_DIR = serviceDir;
    digioDownload = { status: 503, body: 'down' };
    const r = await admin.raw('/api/lockers/applications/LKR-SL-1/agreement/signed.pdf');
    expect(r.status).toBe(200);
    expect(r.buffer.toString()).toContain('customer-signed-by-script');
    delete process.env.FILE_STORAGE_DIR;
  });

  it('the service\'s own directory wins when both hold a file', () => {
    delete process.env.FILE_STORAGE_DIR;
    const legacy = saveBuffer('locker-agreements', 'both.pdf', PDF('legacy-copy'));
    process.env.FILE_STORAGE_DIR = serviceDir;
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(serviceDir, 'locker-agreements'), { recursive: true });
    writeFileSync(join(serviceDir, legacy.path), PDF('service-copy'));
    expect(readStored(legacy.path)!.toString()).toContain('service-copy');
    delete process.env.FILE_STORAGE_DIR;
  });

  it('is still refused for a path that escapes the storage directories', () => {
    process.env.FILE_STORAGE_DIR = serviceDir;
    expect(readStored('../../../../etc/passwd')).toBeNull();
    expect(readStored('..\\..\\..\\windows\\win.ini')).toBeNull();
    delete process.env.FILE_STORAGE_DIR;
  });

  it('a script refuses to write files without FILE_STORAGE_DIR, instead of writing where nobody reads', () => {
    delete process.env.FILE_STORAGE_DIR;
    expect(() => requireServiceStorageDir()).toThrow(/FILE_STORAGE_DIR/);
    process.env.FILE_STORAGE_DIR = serviceDir;
    expect(() => requireServiceStorageDir()).not.toThrow();
    delete process.env.FILE_STORAGE_DIR;
  });
});
