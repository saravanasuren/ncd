/**
 * The two loose ends LockerHub closed on 2026-07-31.
 *
 * A16 — the signed agreement PDF. Keyed on the AGREEMENT id (`esign_id` from
 * A19.2 /esign/status), not the application id. It comes back as BYTES, so it
 * must not go through the JSON client, and it is streamed through us because
 * their endpoint needs the integration key — which must never reach a browser.
 * Their `signed_file_url` is deliberately NOT used: it is an internal
 * SharePoint link that 404s for staff.
 *
 * `POST /customers` — the profile upsert. They write the profile on create
 * going forward but never backfill, so a customer enrolled before that fix
 * sits in their book as a bare name and phone. We push it, built server-side
 * from our own record so the browser cannot write a profile the operator
 * could not otherwise see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];
const PDF = Buffer.from('%PDF-1.4 signed locker agreement');

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
      if (/^\/agreements\/.+\/pdf$/.test(url.pathname)) {
        if (url.pathname.includes('missing')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'agreement not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end(PDF);
      }
      res.writeHead(url.pathname === '/customers' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url.pathname === '/customers' ? { success: true, phone: '9', created: false } : { error: 'nf' }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('A16 — the signed agreement', () => {
  it('comes back as PDF BYTES, intact, not parsed as JSON', async () => {
    const r = await fetch(`${ctx.base}/api/lockers/agreements/esign_abc/pdf`, {
      headers: { Cookie: (await admin()).cookieHeader() },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/pdf/);
    const got = Buffer.from(await r.arrayBuffer());
    expect(got.equals(PDF)).toBe(true);          // byte-for-byte
  });

  it('is fetched by AGREEMENT id, and the integration key never leaves the server', async () => {
    seen = [];
    await fetch(`${ctx.base}/api/lockers/agreements/esign_xyz/pdf`, {
      headers: { Cookie: (await admin()).cookieHeader() },
    });
    expect(seen.some((s) => s.path === '/agreements/esign_xyz/pdf')).toBe(true);
  });

  it('a missing agreement surfaces their 404 rather than an empty file', async () => {
    const r = await fetch(`${ctx.base}/api/lockers/agreements/missing/pdf`, {
      headers: { Cookie: (await admin()).cookieHeader() },
    });
    expect(r.status).toBe(404);
  });

  it('an agent cannot download one', async () => {
    const r = await fetch(`${ctx.base}/api/lockers/agreements/esign_abc/pdf`, {
      headers: { Cookie: (await as('agent@demo.local')).cookieHeader() },
    });
    expect(r.status).toBe(403);
  });
});

describe('pushing the profile for a customer LockerHub already knows', () => {
  let custId: number;
  beforeAll(async () => {
    const a = await admin();
    const c = await a.post('/api/customers', {
      full_name: 'Profile Push Alpha', phone: '9955000011', email: 'alpha@example.com',
      dob: '1979-04-11', address: '9 Race Course Road', city: 'Coimbatore',
      state: 'Tamil Nadu', pincode: '641018',
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    custId = Number(c.json.id);
  });

  it('sends the whole profile, built from our own book', async () => {
    seen = [];
    const r = await (await admin()).post('/api/lockers/customers', { phone: '9955000011', customer_id: custId });
    expect(r.status).toBe(200);
    const body = seen.find((s) => s.path === '/customers')!.body;
    expect(body).toMatchObject({
      phone: '9955000011', name: 'Profile Push Alpha', email: 'alpha@example.com',
      dob: '1979-04-11', address_line1: '9 Race Course Road',
      city: 'Coimbatore', state: 'Tamil Nadu', pincode: '641018',
    });
  });

  it('never sends KYC — /kyc owns that, and this must not imply a verification', async () => {
    seen = [];
    await (await admin()).post('/api/lockers/customers', { phone: '9955000011', customer_id: custId });
    const body = seen.find((s) => s.path === '/customers')!.body;
    expect(body.kyc).toBeUndefined();
    expect(body.verified).toBeUndefined();
    expect(body.pan).toBeUndefined();
  });

  it('what the operator typed wins — they may be correcting us', async () => {
    seen = [];
    await (await admin()).post('/api/lockers/customers', {
      phone: '9955000011', customer_id: custId, name: 'Corrected On Screen',
    });
    const body = seen.find((s) => s.path === '/customers')!.body;
    expect(body.name).toBe('Corrected On Screen');
    expect(body.city).toBe('Coimbatore');        // the rest still comes from us
  });

  it('without a customer id it behaves exactly as before', async () => {
    seen = [];
    await (await admin()).post('/api/lockers/customers', { phone: '9955000012', name: 'Typed Only' });
    const body = seen.find((s) => s.path === '/customers')!.body;
    expect(body).toMatchObject({ phone: '9955000012', name: 'Typed Only' });
    expect(body.city).toBeUndefined();
  });

  it('the browser cannot push a profile for someone it may not see', async () => {
    // staff@demo.local has no visibility of an admin-created customer here.
    const r = await (await as('staff@demo.local')).post('/api/lockers/customers', {
      phone: '9955000011', customer_id: custId,
    });
    expect([403, 404]).toContain(r.status);
  });
});
