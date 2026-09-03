/**
 * How a locker agreement was signed (owner 2026-09-03: "only the signing we
 * have 2 ways — one is eSign what we have and another is manual signature").
 *
 * NCD stored NOTHING about the locker agreement before this. LockerHub builds
 * it, uploads it to Digio, owns the status and keeps the signed PDF; our routes
 * were pure passthrough, so there was nowhere a paper signature could live.
 *
 * PR 1 is the record layer. What these pin:
 *
 *  - the e-Sign flow behaves EXACTLY as it did, and now leaves a row saying it
 *    was an e-Sign, so no locker can report a bare "signed" that hides the method
 *  - the physical path can be chosen and is remembered
 *  - a locker cannot be signed both ways, and an e-Sign status arriving from
 *    LockerHub never overwrites a physical signing
 *  - bookkeeping can never break the signing itself
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;

/** What the mock LockerHub reports for /esign/status, per application. */
const esignState = new Map<string, Record<string, unknown>>();
let initiateFails = false;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const appId = decodeURIComponent(url.pathname.split('/')[2] ?? '');

      if (/\/esign\/initiate$/.test(url.pathname) && req.method === 'POST') {
        if (initiateFails) return send(409, { error: 'not_allotted' });
        esignState.set(appId, { found: true, status: 'sent', esign_id: `ES-${appId}` });
        return send(200, { esign_id: `ES-${appId}`, auth_url: 'https://digio.example/sign/abc' });
      }
      if (/\/esign\/status$/.test(url.pathname)) {
        return send(200, esignState.get(appId) ?? { found: false, status: null });
      }
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

const agreement = async (a: Client, appId: string) =>
  (await a.get(`/api/lockers/applications/${appId}/agreement`)).json;
const rowFor = async (appId: string) =>
  (await ctx.db.query<Record<string, unknown>>(
    'SELECT * FROM locker_agreement_signings WHERE lockerhub_application_id = $1 ORDER BY id DESC', [appId])).rows;

describe('the e-Sign flow is unchanged, and now records itself', () => {
  it('starting an e-Sign still returns the signing link', async () => {
    const a = await admin();
    const r = await a.post('/api/lockers/applications/LKR-1001/esign/initiate', {});
    expect(r.status).toBe(200);
    expect(r.json.auth_url).toBe('https://digio.example/sign/abc');
  });

  it('...and leaves a row saying it was an e-Sign', async () => {
    const rows = await rowFor('LKR-1001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe('esign');
    expect(rows[0]!.status).toBe('AwaitingSignature');
    expect(rows[0]!.esign_reference).toBe('ES-LKR-1001');
  });

  it('a signature reported by LockerHub stamps our row through the status read', async () => {
    const a = await admin();
    esignState.set('LKR-1001', { found: true, status: 'signed', esign_id: 'ES-LKR-1001' });
    await a.get('/api/lockers/applications/LKR-1001/esign');

    const { signing } = await agreement(a, 'LKR-1001');
    expect(signing.status).toBe('Signed');
    expect(signing.is_signed).toBe(true);
    // The method is always named — never a bare "signed".
    expect(signing.label).toBe('e-Signed');
  });

  it('a failed initiate leaves no row claiming a signing was sent', async () => {
    const a = await admin();
    initiateFails = true;
    const r = await a.post('/api/lockers/applications/LKR-1009/esign/initiate', {});
    initiateFails = false;
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await rowFor('LKR-1009')).toHaveLength(0);
  });
});

describe('choosing to sign on paper', () => {
  it('records the physical method against the locker', async () => {
    const a = await admin();
    const r = await a.post('/api/lockers/applications/LKR-2001/agreement/method', { method: 'physical' });
    expect(r.status).toBe(200);
    expect(r.json.method).toBe('physical');
    expect(r.json.status).toBe('Draft');
    expect(r.json.is_signed).toBe(false);
  });

  it('reads back on the agreement route', async () => {
    const a = await admin();
    const { signing } = await agreement(a, 'LKR-2001');
    expect(signing.method).toBe('physical');
    expect(signing.label).toBe('Physical signing started');
  });

  it('choosing the same method twice is not an error', async () => {
    const a = await admin();
    const r = await a.post('/api/lockers/applications/LKR-2001/agreement/method', { method: 'physical' });
    expect(r.status).toBe(200);
    expect(await rowFor('LKR-2001')).toHaveLength(1);   // no duplicate row
  });

  it('can still be switched back to e-Sign while nothing is committed', async () => {
    const a = await admin();
    const r = await a.post('/api/lockers/applications/LKR-2001/agreement/method', { method: 'esign' });
    expect(r.status).toBe(200);
    expect(r.json.method).toBe('esign');
    expect(await rowFor('LKR-2001')).toHaveLength(1);
  });

  it('refuses a method it does not know', async () => {
    const a = await admin();
    expect((await a.post('/api/lockers/applications/LKR-2002/agreement/method', { method: 'carrier-pigeon' })).status).toBe(400);
  });
});

describe('the two methods cannot collide', () => {
  it('a physical signing is not overwritten by a LockerHub e-Sign status', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-3001/agreement/method', { method: 'physical' });
    // LockerHub reporting a signature must NOT flip a paper signing to e-Signed:
    // for a physical one their status stays esign_pending forever, and letting it
    // through would undo a checker's decision.
    esignState.set('LKR-3001', { found: true, status: 'signed', esign_id: 'ES-LKR-3001' });
    await a.get('/api/lockers/applications/LKR-3001/esign');

    const { signing } = await agreement(a, 'LKR-3001');
    expect(signing.method).toBe('physical');
    expect(signing.status).toBe('Draft');
  });

  it('the method cannot be changed once the agreement is signed', async () => {
    const a = await admin();
    await a.post('/api/lockers/applications/LKR-3002/agreement/method', { method: 'esign' });
    await ctx.db.query(
      `UPDATE locker_agreement_signings SET status = 'Signed', signed_at = now()
        WHERE lockerhub_application_id = $1`, ['LKR-3002']);
    const r = await a.post('/api/lockers/applications/LKR-3002/agreement/method', { method: 'physical' });
    expect(r.status).toBe(409);
  });

  it('only one live signing can exist per locker', async () => {
    // The partial unique index is the real guard — prove it, rather than
    // trusting the service to be the only writer.
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status)
       VALUES ($1, 'esign', 'AwaitingSignature')`, ['LKR-4001']);
    await expect(ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status)
       VALUES ($1, 'physical', 'Draft')`, ['LKR-4001'])).rejects.toThrow();
  });

  it('a cancelled attempt frees the locker for another one', async () => {
    await ctx.db.query(
      `UPDATE locker_agreement_signings SET status = 'Cancelled' WHERE lockerhub_application_id = $1`, ['LKR-4001']);
    const a = await admin();
    const r = await a.post('/api/lockers/applications/LKR-4001/agreement/method', { method: 'physical' });
    expect(r.status).toBe(200);
    expect(r.json.method).toBe('physical');
  });
});

describe('a locker nobody has started signing', () => {
  it('answers null rather than inventing a record', async () => {
    const a = await admin();
    const { signing, history } = await agreement(a, 'LKR-9999');
    expect(signing).toBeNull();
    expect(history).toEqual([]);
  });

  it('records an e-Sign that LockerHub already reports signed but we never saw', async () => {
    // Signed before this table existed, or started outside NCD. Recording it is
    // better than showing a locker with no agreement at all.
    const a = await admin();
    esignState.set('LKR-5001', { found: true, status: 'completed', esign_id: 'ES-OLD' });
    await a.get('/api/lockers/applications/LKR-5001/esign');
    const { signing } = await agreement(a, 'LKR-5001');
    expect(signing.method).toBe('esign');
    expect(signing.status).toBe('Signed');
    expect(signing.esign_reference).toBe('ES-OLD');
  });
});
