/**
 * Locker cheque register (NCD side only). Lockers are online-only on LockerHub
 * (§A10 retired offline record-payment), so a cheque can never settle a leg
 * there — these tests pin that the register records and clears the instrument
 * WITHOUT ever claiming the locker is settled, and that clearing is a separate
 * permission from taking the cheque.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

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
});
