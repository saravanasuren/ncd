/**
 * Locker enrolment looks the customer up by PAN (contract B11 is PAN-first).
 * LockerHub itself is phone-keyed, so we resolve from NCD's own book and hand
 * their phone to LockerHub — a LockerHub hiccup must never block the match.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

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

describe('locker deposit links — pick an NCD to back the deposit', () => {
  it('lists the customer\'s live investments with how much of each is free to pledge', async () => {
    const a = new Client(ctx.base);
    await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Pledge Cust', phone: '9540000002', pan: 'PLDGE1234Z' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12' });
    const ncd = new Client(ctx.base); await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    await approveInvestment(ncd, app); // → Active, so it can back a deposit

    const staff = await as('staff@demo.local');
    const r = await staff.get(`/api/lockers/deposit-links/candidates?customer_id=${cust.json.id}`);
    expect(r.status).toBe(200);
    const c = (r.json.candidates as any[]).find((x) => x.id === app.json.id);
    expect(c).toBeTruthy();
    expect(Number(c.outstanding)).toBe(500000);
    expect(Number(c.linked)).toBe(0);
    expect(Number(c.free)).toBe(500000); // nothing pledged yet
  });

  it('requires a customer_id', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.get('/api/lockers/deposit-links/candidates')).status).toBe(400);
  });

  it('needs lockers:enroll', async () => {
    const agent = await as('agent@demo.local');
    expect((await agent.get('/api/lockers/deposit-links/candidates?customer_id=1')).status).toBe(403);
  });
});
