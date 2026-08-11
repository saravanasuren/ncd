/**
 * Withdrawn ₹30L crossings (auto-flagged in error and pulled back) must NEVER
 * appear on the TDS Crossings list, under any filter (owner 2026-08-10). A
 * genuine later crossing raises a fresh event, so only mistakes are hidden.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

async function makeEvent(customerId: number, status: string) {
  await ctx.db.query(
    `INSERT INTO tds_threshold_events (customer_id, outstanding_at_crossing, interest_paid_untaxed, tds_rate_pct, tds_to_recover, status, source)
     VALUES ($1, 3000000, 50000, 10, 5000, $2, 'scan')`, [customerId, status]);
}

describe('TDS Crossings list hides Withdrawn events', () => {
  it('a Withdrawn event never shows; a real pending one still does', async () => {
    const a = await admin();
    const c1 = await a.post('/api/customers', { full_name: 'Withdrawn Cust', phone: '9811100001' });
    const c2 = await a.post('/api/customers', { full_name: 'Pending Cust', phone: '9811100002' });
    await makeEvent(Number(c1.json.id), 'Withdrawn');
    await makeEvent(Number(c2.json.id), 'PendingApproval');

    // "All" (no filter): the withdrawn one is absent, the pending one present.
    const all = await a.get('/api/tds/events');
    const ids = (all.json.rows as Array<{ customer_id: number; status: string }>);
    expect(ids.some((r) => r.customer_id === Number(c2.json.id))).toBe(true);
    expect(ids.some((r) => r.customer_id === Number(c1.json.id))).toBe(false);
    expect(ids.some((r) => r.status === 'Withdrawn')).toBe(false);

    // Even asking for Withdrawn explicitly returns nothing from this list.
    const w = await a.get('/api/tds/events?status=Withdrawn');
    expect((w.json.rows as unknown[]).length).toBe(0);
  });
});
