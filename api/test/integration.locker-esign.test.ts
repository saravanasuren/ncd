/**
 * §A19 locker-agreement e-Sign.
 *
 * NCD had none of this before 2026-07-29 — neither starting a signing nor
 * fetching the result. LockerHub added it themselves.
 *
 * Two things are worth pinning. Starting a signing genuinely CONTACTS the
 * customer: Digio emails and texts them a link. So it must be a deliberate
 * POST and never a side effect of reading the status, or opening the enrolment
 * screen would message people. And `{ found: false }` is a normal answer
 * meaning "nobody has started one" — treating it as an error would put a red
 * failure on every freshly allotted locker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; method: string; body: any }> = [];
/** Drives the mock: what /esign/status answers next. */
let state: 'none' | 'pending' | 'signed' = 'none';
/** Set to refuse an initiate the way they do before allotment. */
let notAllotted = false;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, method: req.method ?? '', body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/esign\/initiate$/.test(url.pathname) && req.method === 'POST') {
        if (notAllotted) return send(409, { error: 'Locker not allotted yet', code: 'not_allotted' });
        state = 'pending';
        return send(200, { success: true, found: true, status: 'pending', auth_url: 'https://digio.test/sign/abc' });
      }
      if (/\/esign\/status$/.test(url.pathname) && req.method === 'GET') {
        if (state === 'none') return send(200, { found: false, status: null });
        if (state === 'pending') return send(200, { found: true, status: 'pending', auth_url: 'https://digio.test/sign/abc' });
        return send(200, { found: true, status: 'signed', document_url: 'https://lockerhub.test/agreement.pdf' });
      }
      return send(404, { error: 'not found: ' + url.pathname });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const staff = () => as('staff@demo.local');
const APP = 'la_esign';
const initiates = () => seen.filter((s) => /esign\/initiate$/.test(s.path));

describe('reading the status never messages anybody', () => {
  it('"nothing started" is a normal answer, not an error', async () => {
    state = 'none'; seen = [];
    const r = await (await staff()).get(`/api/lockers/applications/${APP}/esign`);
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(false);
    expect(r.json.status).toBeNull();
    // The read must not have started one — that would email the customer.
    expect(initiates()).toHaveLength(0);
  });

  it('polling repeatedly still starts nothing', async () => {
    state = 'none'; seen = [];
    const c = await staff();
    await c.get(`/api/lockers/applications/${APP}/esign`);
    await c.get(`/api/lockers/applications/${APP}/esign`);
    await c.get(`/api/lockers/applications/${APP}/esign`);
    expect(initiates()).toHaveLength(0);
  });
});

describe('starting a signing', () => {
  it('returns the signing link and carries the acting staff', async () => {
    state = 'none'; seen = [];
    const r = await (await staff()).post(`/api/lockers/applications/${APP}/esign/initiate`, {});
    expect(r.status).toBe(200);
    expect(r.json.auth_url).toBe('https://digio.test/sign/abc');
    // Their audit log must show the real person, as on every Part A write.
    expect(initiates()[0]!.body.staff?.name).toBeTruthy();
  });

  it('the status then reports it as awaiting signature', async () => {
    state = 'none';
    const c = await staff();
    await c.post(`/api/lockers/applications/${APP}/esign/initiate`, {});
    const r = await c.get(`/api/lockers/applications/${APP}/esign`);
    expect(r.json).toMatchObject({ found: true, status: 'pending' });
  });

  it('once signed, the status carries the document', async () => {
    state = 'signed';
    const r = await (await staff()).get(`/api/lockers/applications/${APP}/esign`);
    expect(r.json.status).toBe('signed');
    expect(r.json.document_url).toBeTruthy();
  });

  it('before allotment their 409 is surfaced, not swallowed', async () => {
    notAllotted = true;
    try {
      const r = await (await staff()).post(`/api/lockers/applications/${APP}/esign/initiate`, {});
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.json)).toMatch(/not.?allot/i);
    } finally { notAllotted = false; }
  });
});

describe('who may use it', () => {
  it('an agent cannot start a signing — lockers:enroll is staff only', async () => {
    const agent = await as('agent@demo.local');
    const r = await agent.post(`/api/lockers/applications/${APP}/esign/initiate`, {});
    expect(r.status).toBe(403);
  });
});
