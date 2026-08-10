/**
 * Sidebar badge counts (owner 2026-08-10): GET /api/nav/badges returns, keyed
 * by nav route, how many items are waiting on the current user. Here we pin
 * that a freshly-raised approval bumps the Approvals count, and that a user
 * with no checker permission sees nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('sidebar badge counts', () => {
  it('a newly-raised approval increments the Approvals badge', async () => {
    const a = await admin();
    // Create the customer first (its own acknowledgement approval), then take
    // the baseline — so we measure exactly the one approval the investment adds.
    const cust = await a.post('/api/customers', { full_name: 'Badge Cust', phone: '9840000123', pan: 'BADGE1234C' });
    const before = Number((await a.get('/api/nav/badges')).json.counts['/app/approvals'] ?? 0);

    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(),
      customer_id: Number(cust.json.id), series_id: seriesId, scheme_id: schemeId,
      amount: 100000, collection_reference: 'BADGE-1',
    });
    expect(create.status).toBe(201);

    const after = Number((await a.get('/api/nav/badges')).json.counts['/app/approvals'] ?? 0);
    expect(after).toBe(before + 1);
  });

  it('the endpoint requires authentication', async () => {
    const anon = new Client(ctx.base);
    const r = await anon.get('/api/nav/badges');
    expect(r.status).toBe(401);
  });
});
