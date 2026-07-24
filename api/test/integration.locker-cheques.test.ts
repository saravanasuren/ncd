/**
 * Locker cheque register (NCD side only). Lockers are online-only on LockerHub
 * (§A10 retired offline record-payment), so a cheque can never settle a leg
 * there — these tests pin that the register records and clears the instrument
 * WITHOUT ever claiming the locker is settled, and that clearing is a separate
 * permission from taking the cheque.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let custId: number;
const APP = 'APP-2026-01028'; // a LockerHub application id

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const c = await a.post('/api/customers', { full_name: 'Cheque Cust', phone: '9530000001' });
  custId = c.json.id;
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const record = (c: Client, leg: string, chequeNo: string, appId = APP) =>
  c.post('/api/lockers/cheques', {
    lockerhub_application_id: appId, customer_id: custId, leg, amount: 7080,
    cheque_no: chequeNo, bank_name: 'HDFC', received_on: '2026-07-22',
  });

describe('locker cheque register', () => {
  it('branch staff can take a cheque; the response never claims the locker is settled', async () => {
    const staff = await as('staff@demo.local');
    const r = await record(staff, 'rent', 'CHQ-001');
    expect(r.status).toBe(201);
    expect(r.json.cheque.status).toBe('Pending');
    expect(r.json.cheque.leg).toBe('rent');
    expect(Number(r.json.cheque.amount)).toBe(7080);
    expect(r.json.note).toMatch(/NOT settled on LockerHub/i);
    expect(r.json.note).toMatch(/will not allot/i);
    // Safety: staff must be sent to LockerHub Tenants, never to the payment
    // link — that is a live payment page and would collect a SECOND time for
    // money we already hold (LockerHub confirmed 2026-07-22).
    expect(r.json.note).toMatch(/Tenants/i);
    expect(r.json.note).toMatch(/second real payment/i);
  });

  it('refuses a second pending cheque for the same leg', async () => {
    const staff = await as('staff@demo.local');
    const r = await record(staff, 'rent', 'CHQ-002');
    expect(r.status).toBe(409);
  });

  it('taking a cheque and confirming it cleared are DIFFERENT permissions', async () => {
    const staff = await as('staff@demo.local'); // lockers:enroll, no confirm-collection
    const list = await staff.get(`/api/lockers/cheques?application_id=${APP}`);
    const id = list.json.rows[0].id;
    expect((await staff.post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-07-24' })).status).toBe(403);
  });

  it('a collection-confirming user clears it — and it still says the locker is not settled', async () => {
    const a = await admin();
    const list = await a.get(`/api/lockers/cheques?application_id=${APP}`);
    const id = list.json.rows.find((x: any) => x.leg === 'rent').id;
    const r = await a.post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-07-24', reference: 'BANKREF1' });
    expect(r.status).toBe(200);
    expect(r.json.cheque.status).toBe('Cleared');
    expect(r.json.cheque.cleared_on).toBe('2026-07-24');
    expect(r.json.cheque.reference).toBe('BANKREF1');
    expect(r.json.note).toMatch(/NOT settled on LockerHub/i);
    // Clearing twice is refused.
    expect((await a.post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-07-25' })).status).toBe(409);
  });

  it('a bounced cheque frees the leg so a replacement can be taken', async () => {
    const a = await admin();
    const staff = await as('staff@demo.local');
    const other = 'APP-2026-01099';
    expect((await record(staff, 'deposit', 'CHQ-010', other)).status).toBe(201);

    const list = await a.get(`/api/lockers/cheques?application_id=${other}`);
    const id = list.json.rows[0].id;
    expect((await a.post(`/api/lockers/cheques/${id}/bounce`, { reason: 'returned unpaid' })).status).toBe(200);
    // Leg is free again.
    expect((await record(staff, 'deposit', 'CHQ-011', other)).status).toBe(201);
  });

  it('the register lists what is still awaiting clearance', async () => {
    const a = await admin();
    const r = await a.get('/api/lockers/cheques?status=Pending');
    expect(r.status).toBe(200);
    expect((r.json.rows as any[]).every((x) => x.status === 'Pending')).toBe(true);
    expect(r.json.rows.length).toBeGreaterThanOrEqual(1);
    expect(r.json.rows[0].customer_name).toBeTruthy(); // joined for the ops list
  });

  // A cheque can be taken for an applicant who exists only in LockerHub — no
  // NCD customer_id to join against. Before migration 042 that row showed a
  // blank name forever; now it carries what was on screen when the cheque was
  // recorded.
  it('an applicant with no NCD customer_id still shows a name — the snapshot taken at record time', async () => {
    const staff = await as('staff@demo.local');
    const appId = 'APP-2026-01200';
    const r = await staff.post('/api/lockers/cheques', {
      lockerhub_application_id: appId, leg: 'rent', amount: 6000,
      cheque_no: 'CHQ-020', bank_name: 'Ujjivan', received_on: '2026-07-24',
      applicant_name: 'Locker Only Applicant', applicant_phone: '9820000001',
    });
    expect(r.status).toBe(201);
    expect(r.json.cheque.customer_id).toBeNull();

    const list = await staff.get(`/api/lockers/cheques?application_id=${appId}`);
    expect(list.json.rows[0].customer_name).toBe('Locker Only Applicant');
  });

  // A row from before the snapshot existed (customer_id AND applicant_name both
  // null) resolves itself once against LockerHub and then never asks again.
  describe('a legacy blank-name row self-heals from LockerHub, once', () => {
    let mock: Server;
    let hits = 0;
    const LEGACY_APP = 'APP-2026-01300';

    beforeAll(async () => {
      mock = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === `/locker-applications/${LEGACY_APP}`) {
          hits++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ name: 'Resolved From LockerHub', phone: '9830000002' }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
      await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
      const addr = mock.address();
      config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      // Insert directly — this is the pre-042 shape: no customer_id, no snapshot.
      await ctx.db.query(
        `INSERT INTO locker_cheques (lockerhub_application_id, leg, amount, cheque_no, received_on, status)
         VALUES ($1, 'deposit', 5000, 'CHQ-030', '2026-07-01', 'Pending')`, [LEGACY_APP]);
    });
    afterAll(async () => {
      config.LOCKERHUB_API_URL = undefined;
      await new Promise<void>((r) => mock.close(() => r()));
    });

    it('resolves the name from LockerHub and caches it on the row', async () => {
      const a = await admin();
      const first = await a.get(`/api/lockers/cheques?application_id=${LEGACY_APP}`);
      expect(first.json.rows[0].customer_name).toBe('Resolved From LockerHub');
      expect(hits).toBe(1);

      const second = await a.get(`/api/lockers/cheques?application_id=${LEGACY_APP}`);
      expect(second.json.rows[0].customer_name).toBe('Resolved From LockerHub');
      expect(hits).toBe(1); // cached — no second call
    });
  });
});
