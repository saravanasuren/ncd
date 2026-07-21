/**
 * Enrolment autofills (owner spec 2026-07-21): pincode is captured + stored on
 * the customer; penny-drop verify is available during enrolment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('enrolment autofills', () => {
  it('pincode is stored on the customer and returned in the detail', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Pin Cust', phone: '9811100011', pincode: '641002', city: 'Coimbatore', state: 'Tamil Nadu' });
    expect(cust.status).toBe(201);
    const detail = await a.get(`/api/customers/${cust.json.id}`);
    expect(detail.json.customer.pincode).toBe('641002');
    expect(detail.json.customer.city).toBe('Coimbatore');
  });

  it('penny-drop verify returns a verdict (stub provider)', async () => {
    const a = await admin();
    const r = await a.post('/api/lookups/penny-drop', { account_number: '50100123456789', ifsc: 'HDFC0000001', name: 'Pin Cust' });
    expect(r.status).toBe(200);
    expect(['Verified', 'Failed']).toContain(r.json.status);
    expect(r.json).toHaveProperty('name_on_record');
  });
});
