/**
 * The approvals queue carries the maker's name — so a checker reviewing a
 * customer-creation acknowledgement can see WHO created the customer, not just
 * the customer's name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('approvals queue shows who raised the request', () => {
  it('a customer-creation request carries the creator name', async () => {
    const a = await admin();
    const makerName = (await ctx.db.query<{ full_name: string }>(
      "SELECT full_name FROM users WHERE email = 'admin@dhanam.finance'")).rows[0]!.full_name;

    const cust = await a.post('/api/customers', { full_name: 'Maker Name Cust', phone: '9847100001' });
    expect(cust.status).toBe(201);

    const queue = await a.get('/api/approvals/queue');
    const req = (queue.json.rows as any[]).find(
      (r) => r.request_type === 'customer_creation' && String(r.entity_id) === String(cust.json.id));
    expect(req).toBeTruthy();
    expect(req.maker_name).toBe(makerName);   // the checker can see who created it
  });
});
