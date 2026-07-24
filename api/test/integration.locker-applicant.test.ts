/**
 * The `applicant` block on A7 create, and A11 allocate (the approval step that
 * creates the tenant).
 *
 * The block exists so a locker tenancy is complete on LockerHub without anyone
 * opening their app. The thing these tests actually guard is the Aadhaar rule:
 * we hold the full 12 digits (`customers.aadhaar`, and a nominee's
 * `kyc_id_number` can be one too), LockerHub is not permitted to store one, and
 * a single wrong column would push it out of our system. Their 400 would bounce
 * the request, but the number would already have left — so the assertion is on
 * what we SEND, not on what they answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let custId: number;
let seen: Array<{ path: string; body: any }> = [];

const FULL_AADHAAR = '123456789012';

async function login(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => login('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();

  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/locker-applications' && req.method === 'POST') {
        // Mirror LockerHub: a full Aadhaar anywhere in the block is rejected.
        const a = body.applicant ?? {};
        const bad = [a?.kyc?.aadhaar_last4, a?.nominee?.aadhaar_last4]
          .some((v) => String(v ?? '').replace(/\D/g, '').length > 4);
        if (bad) return send(400, { error: 'aadhaar must be last 4 only', code: 'aadhaar_full_rejected' });
        return send(201, { success: true, application_id: 'la_1', application_no: 'APP-L-1', status: 'payment_pending' });
      }
      const al = url.pathname.match(/^\/locker-applications\/([^/]+)\/allocate$/);
      if (al && req.method === 'POST') {
        const id = al[1]!;
        if (id === 'la_unpaid') return send(409, { error: 'obligations pending', code: 'obligations_pending', missing: ['rent'] });
        if (id === 'la_done') return send(400, { already: true, tenant_id: 't_9', locker_number: 'L10-4' });
        if (id === 'la_full') return send(400, { error: 'no vacancy', code: 'no_vacancy' });
        return send(200, { success: true, tenant_id: 't_1', locker_number: 'L10-4', lease_start: '2026-07-24', lease_end: '2027-07-23' });
      }
      return send(404, { error: 'not found: ' + url.pathname });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // A customer carrying a FULL Aadhaar, plus a nominee whose KYC id is also a
  // full Aadhaar — the two places the number could escape from.
  const a = await admin();
  const c = await a.post('/api/customers', {
    full_name: 'Applicant Test', phone: '9700000001', pan: 'ABCDE1234F',
    aadhaar: FULL_AADHAAR, dob: '1985-06-02', gender: 'Male',
    address: '12 Mount Road', city: 'Coimbatore', state: 'Tamil Nadu', pincode: '641001',
    occupation: 'Business', father_name: 'Guardian Name',
  });
  custId = Number(c.json.id);
  await ctx.db.query(
    `INSERT INTO nominees (customer_id, full_name, relationship, share_pct, phone, kyc_id_type, kyc_id_number)
     VALUES ($1, 'Nominee One', 'Spouse', 100, '9700000002', 'Aadhaar', $2)`, [custId, FULL_AADHAAR]);
  await a.post(`/api/customers/${custId}/bank-accounts`, { account_number: '112611500099', ifsc: 'KVBL0001126' });
});

afterAll(async () => {
  config.LOCKERHUB_API_URL = undefined;
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

const createWith = async (customerId?: number) => {
  seen = [];
  const staff = await admin();
  const r = await staff.post('/api/lockers/applications', {
    phone: '9700000001', branch_id: 'br_1', locker_size: 'Medium',
    ...(customerId ? { customer_id: customerId } : {}),
  });
  return { r, sent: seen.find((s) => s.path === '/locker-applications')?.body };
};

describe('applicant block on locker application create', () => {
  it('NEVER sends a full Aadhaar — last four only, from both customer and nominee', async () => {
    const { r, sent } = await createWith(custId);
    expect(r.status).toBe(201);
    // The exact thing that must not happen.
    expect(JSON.stringify(sent)).not.toContain(FULL_AADHAAR);
    expect(sent.applicant.kyc.aadhaar_last4).toBe('9012');
    expect(sent.applicant.nominee.aadhaar_last4).toBe('9012');
  });

  it('carries the profile so nobody has to open LockerHub', async () => {
    const { sent } = await createWith(custId);
    const a = sent.applicant;
    expect(a.dob).toBe('1985-06-02');
    expect(a.gender).toBe('Male');
    expect(a.guardian_name).toBe('Guardian Name');
    expect(a.occupation).toBe('Business');
    expect(a.address).toMatchObject({ road_name: '12 Mount Road', city: 'Coimbatore', state: 'Tamil Nadu', pincode: '641001' });
    expect(a.nominee).toMatchObject({ name: 'Nominee One', relation: 'Spouse', phone: '9700000002' });
    expect(a.kyc.pan).toBe('ABCDE1234F');
    expect(a.bank).toMatchObject({ account_last4: '0099', ifsc: 'KVBL0001126' });
  });

  it('omits kyc.method rather than inventing a provenance we do not record', async () => {
    const { sent } = await createWith(custId);
    expect(sent.applicant.kyc.method).toBeUndefined();
  });

  it('still creates the application when no customer_id is given', async () => {
    const { r, sent } = await createWith();
    expect(r.status).toBe(201);
    expect(sent.applicant).toBeUndefined();
    expect(sent.staff).toBeTruthy(); // acting staff always injected from session
  });
});

describe('allocate — the approval step that creates the tenant', () => {
  const alloc = async (id: string, body: Record<string, unknown> = {}) =>
    (await admin()).post(`/api/lockers/applications/${id}/allocate`, body);

  it('allocates and returns the tenancy, carrying the acting staff', async () => {
    seen = [];
    const r = await alloc('la_1', { lease_months: 12 });
    expect(r.status).toBe(200);
    expect(r.json.locker_number).toBe('L10-4');
    expect(seen.find((s) => s.path.endsWith('/allocate'))?.body.staff).toMatchObject({ name: expect.any(String) });
  });

  it('passes 409 obligations_pending through WITH missing[], never silently allotting', async () => {
    const r = await alloc('la_unpaid');
    expect(r.status).toBe(409);
    expect(r.json.error.detail.missing).toEqual(['rent']);
  });

  it('treats already:true as success — a re-drive of a done allocation is not a failure', async () => {
    const r = await alloc('la_done');
    expect(r.status).toBe(200);
    expect(r.json.already).toBe(true);
    expect(r.json.locker_number).toBe('L10-4');
  });

  it('surfaces no_vacancy as their 400 rather than a generic failure', async () => {
    const r = await alloc('la_full');
    expect(r.status).toBe(400);
    expect(r.json.error.detail.code).toBe('no_vacancy');
  });
});
