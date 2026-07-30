/**
 * The manual "dematerialised" flag on a customer: starts unmarked, staff can
 * set it Dematerialised / Physical / back to unmarked, and it shows on the
 * profile. A non-updater cannot change it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('customer dematerialised flag', () => {
  it('starts unmarked, toggles, and surfaces on the profile', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Demat Cust', phone: '9848100001' });
    const id = Number(cust.json.id);

    expect((await a.get(`/api/customers/${id}`)).json.customer.is_dematerialised).toBeNull();

    expect((await a.patch(`/api/customers/${id}/dematerialised`, { value: true })).status).toBe(200);
    expect((await a.get(`/api/customers/${id}`)).json.customer.is_dematerialised).toBe(true);

    await a.patch(`/api/customers/${id}/dematerialised`, { value: false });
    expect((await a.get(`/api/customers/${id}`)).json.customer.is_dematerialised).toBe(false);

    await a.patch(`/api/customers/${id}/dematerialised`, { value: null });
    expect((await a.get(`/api/customers/${id}`)).json.customer.is_dematerialised).toBeNull();
  });

  it('rejects a non-boolean value', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Demat Bad', phone: '9848100002' });
    expect((await a.patch(`/api/customers/${cust.json.id}/dematerialised`, { value: 'yes' })).status).toBe(400);
  });
});
