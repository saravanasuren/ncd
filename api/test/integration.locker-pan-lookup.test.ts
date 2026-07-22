/**
 * Locker enrolment looks the customer up by PAN (contract B11 is PAN-first).
 * LockerHub itself is phone-keyed, so we resolve from NCD's own book and hand
 * their phone to LockerHub — a LockerHub hiccup must never block the match.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let pan: string;

beforeAll(async () => {
  ctx = await startTestServer();
  pan = 'LCKRP1234Z';
  const a = new Client(ctx.base);
  await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  await a.post('/api/customers', { full_name: 'Locker PAN Cust', phone: '9540000001', email: 'lp@ex.com', pan });
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}

describe('locker enrolment — PAN lookup', () => {
  it('resolves the NCD customer (and their phone) from a PAN', async () => {
    const staff = await as('staff@demo.local'); // holds lockers:enroll
    const r = await staff.get(`/api/lockers/customers/by-pan/${pan}`);
    expect(r.status).toBe(200);
    expect(r.json.found_in_ncd).toBe(true);
    expect(r.json.customer.full_name).toBe('Locker PAN Cust');
    expect(r.json.customer.phone).toBe('9540000001'); // carried into the LockerHub flow
    expect(r.json.customer.customer_code).toBeTruthy();
    // LockerHub isn't configured under test — that must degrade, not throw.
    expect(r.json).toHaveProperty('locker');
  });

  it('is case-insensitive on the PAN', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.get(`/api/lockers/customers/by-pan/${pan.toLowerCase()}`);
    expect(r.json.found_in_ncd).toBe(true);
  });

  it('reports a clean miss for an unknown PAN', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.get('/api/lockers/customers/by-pan/ZZZZZ9999Z');
    expect(r.status).toBe(200);
    expect(r.json.found_in_ncd).toBe(false);
    expect(r.json.customer).toBeNull();
  });

  it('needs lockers:enroll', async () => {
    const agent = await as('agent@demo.local'); // no lockers:enroll
    expect((await agent.get(`/api/lockers/customers/by-pan/${pan}`)).status).toBe(403);
  });
});
