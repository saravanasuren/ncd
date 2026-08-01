/**
 * §A17.1 — handing our KYC to a locker application that reached LockerHub bare.
 *
 * Needed only for applications created before the enrolment screen started
 * sending `customer_id` (#198): no applicant block went with them, so they park
 * at `kyc_pending` with nothing to move them on.
 *
 * The rule everything here defends: LockerHub accepts this
 * **approved-on-arrival**. They do not re-verify. So we must never assert a
 * verification we have not done — a false claim here becomes a false record in
 * a regulated counterparty's book. The route refuses unless OUR customer says
 * Verified, and it builds the evidence server-side so the browser cannot
 * supply it.
 *
 * And the standing Aadhaar rule: last four only, never the full number. We
 * hold the full 12 digits one column away from the last-four, so this is
 * asserted on what we SEND, not on what they answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];

const FULL_AADHAAR = '123456789012';
const APP = 'la_kyc';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/kyc$/.test(url.pathname) && req.method === 'POST') {
        // Mirror LockerHub: a full Aadhaar is rejected outright.
        if (String(body.aadhaar_last4 ?? '').replace(/\D/g, '').length > 4) {
          return send(400, { error: 'aadhaar must be last 4 only' });
        }
        return send(200, { success: true, status: 'payment_pending' });
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
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

// Word names on purpose: person-name validation rejects digits, so "Kyc Push 1"
// is refused at create and every later assertion fails for the wrong reason.
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
let n = 0;
/** A customer holding a FULL Aadhaar — the value that must never leave. */
async function customer(verified: boolean, opts: { pan?: string | null } = {}) {
  const a = await admin();
  const phone = `96100000${String(++n).padStart(2, '0')}`;
  const c = await a.post('/api/customers', {
    full_name: `Kyc Push ${NAMES[n % NAMES.length]}`, phone,
    ...(opts.pan === null ? {} : { pan: opts.pan ?? `ABCDE${String(1000 + n)}F` }),
    aadhaar: FULL_AADHAAR,
  });
  expect(c.status, JSON.stringify(c.json)).toBe(201);   // fail HERE, not three asserts later
  const id = Number(c.json.id);
  if (verified) await a.post(`/api/customers/${id}/kyc/verify`);
  return id;
}
const push = async (customerId: number, appId = APP) =>
  (await admin()).post(`/api/lockers/applications/${appId}/kyc`, { customer_id: customerId });
const kycCalls = () => seen.filter((s) => /\/kyc$/.test(s.path));

describe('we never assert a verification we have not done', () => {
  it('refuses to send when our own record says Pending', async () => {
    const id = await customer(false);
    seen = [];
    const r = await push(id);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not verified/i);
    expect(kycCalls()).toHaveLength(0);        // nothing reached them
  });

  it('the message tells the operator exactly what to do about it', async () => {
    const id = await customer(false);
    const r = await push(id);
    expect(r.json.error.message).toMatch(/verify it on their profile/i);
  });

  it('sends once the customer IS verified', async () => {
    const id = await customer(true);
    seen = [];
    const r = await push(id);
    expect(r.status).toBe(200);
    expect(kycCalls()[0]!.body.verified).toBe(true);
  });

  it('refuses a verified customer with no PAN — LockerHub needs one', async () => {
    const id = await customer(true, { pan: null });
    seen = [];
    const r = await push(id);
    expect(r.status).toBe(400);
    expect(kycCalls()).toHaveLength(0);
  });
});

describe('what we send', () => {
  it('NEVER the full Aadhaar — last four only', async () => {
    const id = await customer(true);
    seen = [];
    await push(id);
    const body = kycCalls()[0]!.body;
    expect(JSON.stringify(body)).not.toContain(FULL_AADHAAR);
    expect(body.aadhaar_last4).toBe('9012');
  });

  it('carries who verified it and when, from the audit trail', async () => {
    const id = await customer(true);
    seen = [];
    await push(id);
    const body = kycCalls()[0]!.body;
    expect(body.verifier).toBe('System Administrator');
    expect(body.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('omits `method` rather than inventing a provenance we do not record', async () => {
    const id = await customer(true);
    seen = [];
    await push(id);
    expect(kycCalls()[0]!.body.method).toBeUndefined();
  });

  it('names the acting staff, as every Part A write does', async () => {
    const id = await customer(true);
    seen = [];
    await push(id);
    expect(kycCalls()[0]!.body.staff?.name).toBeTruthy();
  });
});

describe('guards', () => {
  it('a customer that does not exist is a 404, not a blank assertion', async () => {
    seen = [];
    const r = await push(99999999);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(kycCalls()).toHaveLength(0);
  });

  it('the browser cannot supply KYC fields — only a customer id is accepted', async () => {
    const id = await customer(true);
    seen = [];
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/kyc`, {
      customer_id: id, pan: 'ZZZZZ9999Z', aadhaar_last4: '4321', verified: true,
    });
    expect(r.status).toBe(200);
    // Built from our book, so the injected values are ignored entirely.
    const body = kycCalls()[0]!.body;
    expect(body.pan).not.toBe('ZZZZZ9999Z');
    expect(body.aadhaar_last4).toBe('9012');
  });
});
