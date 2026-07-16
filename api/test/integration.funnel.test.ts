/**
 * Phase 3 integration — lead → customer → hand-off → approvals (PGlite HTTP).
 * Verifies the Phase 3 "done" criteria + the no-self-approve rule (docs/11, docs/03).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234'): Promise<Client> {
  const c = new Client(ctx.base);
  const r = await c.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('lead → customer → hand-off to NCD Manager queue', () => {
  let customerId: number;

  it('branch staff creates a lead, then converts it to a customer', async () => {
    const staff = await as('staff@demo.local');
    const lead = await staff.post('/api/leads', { full_name: 'Synthetic Investor', phone: '9000000001', district: 'Erode', source: 'Walk-IN' });
    expect(lead.status).toBe(201);
    const conv = await staff.post(`/api/leads/${lead.json.id}/convert`, { confirmed_amount: 500000, confirmed_series_id: 1 });
    expect(conv.status).toBe(201);
    customerId = conv.json.customerId;
    expect(customerId).toBeGreaterThan(0);
  });

  it('staff adds a bank account — penny-drop stub verifies and it becomes active', async () => {
    const staff = await as('staff@demo.local');
    const bank = await staff.post(`/api/customers/${customerId}/bank-accounts`, { account_number: '12345678901', ifsc: 'HDFC0001234' });
    expect(bank.status).toBe(201);
    expect(bank.json.pennyDrop.status).toBe('Verified');
    const detail = await staff.get(`/api/customers/${customerId}`);
    expect(detail.json.bankAccounts[0].is_active).toBe(true);
  });

  it('a bad account fails penny-drop and does not become active', async () => {
    const staff = await as('staff@demo.local');
    const bank = await staff.post(`/api/customers/${customerId}/bank-accounts`, { account_number: '00001111', ifsc: 'HDFC0001234' });
    expect(bank.json.pennyDrop.status).toBe('Failed');
  });

  it('staff submits the customer → it appears in the NCD Manager queue', async () => {
    const staff = await as('staff@demo.local');
    const submit = await staff.post(`/api/customers/${customerId}/submit-for-approval`);
    expect(submit.status).toBe(201);

    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/approvals/queue');
    expect(queue.status).toBe(200);
    const item = queue.json.rows.find((r: any) => r.entity_id === String(customerId) && r.request_type === 'customer_creation');
    expect(item).toBeTruthy();
    expect(item.canAct).toBe(true);
  });

  it('NCD Manager approves → customer becomes Approved + active', async () => {
    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/approvals/queue');
    const item = queue.json.rows.find((r: any) => r.entity_id === String(customerId));
    const appr = await ncd.post(`/api/approvals/${item.id}/approve`);
    expect(appr.status).toBe(200);
    expect(appr.json.request.status).toBe('Approved');

    const a = await admin();
    const detail = await a.get(`/api/customers/${customerId}`);
    expect(detail.json.customer.creation_status).toBe('Approved');
    expect(detail.json.customer.is_active).toBe(true);
  });
});

describe('scope rules', () => {
  it('an agent cannot see a branch-staff-enrolled customer', async () => {
    const staff = await as('staff@demo.local');
    const lead = await staff.post('/api/leads', { full_name: 'Staff Only Cust', phone: '9000000002' });
    const conv = await staff.post(`/api/leads/${lead.json.id}/convert`, { confirmed_amount: 100000, confirmed_series_id: 1 });
    const cid = conv.json.customerId;

    const agent = await as('agent@demo.local');
    const detail = await agent.get(`/api/customers/${cid}`);
    expect(detail.status).toBe(404); // out of the agent's scope

    const admin2 = await admin();
    expect((await admin2.get(`/api/customers/${cid}`)).status).toBe(200); // admin sees all
  });

  it('CXO cannot create leads or customers (read-only role)', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.post('/api/leads', { full_name: 'x' })).status).toBe(403);
    expect((await cxo.post('/api/customers', { full_name: 'x' })).status).toBe(403);
  });
});

describe('no-self-approve rule (docs/03 rule zero)', () => {
  it('the NCD Manager who submits cannot approve their own submission', async () => {
    // NCD Manager both creates AND submits a customer, then tries to self-approve.
    const ncd = await as('ncd@demo.local');
    const created = await ncd.post('/api/customers', { full_name: 'NCD Self Test', phone: '9000000003' });
    expect(created.status).toBe(201);
    const submit = await ncd.post(`/api/customers/${created.json.id}/submit-for-approval`);
    expect(submit.status).toBe(201);
    const reqId = submit.json.request.id;

    // Same NCD Manager tries to approve → forbidden.
    const selfApprove = await ncd.post(`/api/approvals/${reqId}/approve`);
    expect(selfApprove.status).toBe(403);

    // A different checker (Admin) can approve.
    const a = await admin();
    const ok = await a.post(`/api/approvals/${reqId}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.json.request.status).toBe('Approved');
  });

  it('a branch staff (no checker permission) cannot approve', async () => {
    const ncd = await as('ncd@demo.local');
    const created = await ncd.post('/api/customers', { full_name: 'Perm Test', phone: '9000000004' });
    const submit = await ncd.post(`/api/customers/${created.json.id}/submit-for-approval`);
    const staff = await as('staff@demo.local');
    const r = await staff.post(`/api/approvals/${submit.json.request.id}/approve`);
    expect(r.status).toBe(403);
  });
});
