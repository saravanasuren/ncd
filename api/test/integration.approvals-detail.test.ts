/**
 * The Approvals queue must say WHAT each request is about — an investment
 * approval that only reads "Application · REQ-2026-000005" is unusable, and the
 * detail panel dumping the raw request record (entity_id, chain, metadata JSON)
 * is worse. Every request carries a resolved subject + amount, and the detail
 * endpoint returns readable facts about the underlying entity.
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

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('approvals queue — readable subject + detail', () => {
  it('an investment approval names the customer, application and amount', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Queue Subject Cust', phone: '9844000001' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000, date_money_received: '2026-07-11',
    });
    const reqId = Number(app.json.subscription_request.id);

    // Queue row carries the subject + amount up front.
    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/approvals/queue');
    const row = (queue.json.rows as any[]).find((r) => r.id === reqId);
    expect(row).toBeTruthy();
    expect(row.subject).toContain('Queue Subject Cust');
    expect(row.subject).toContain(String(app.json.application_no));
    expect(Number(row.amount)).toBe(200000);

    // Detail returns readable facts, not the raw record.
    const det = await ncd.get(`/api/approvals/${reqId}`);
    expect(det.status).toBe(200);
    const facts: Array<{ label: string; value: string }> = det.json.detail.facts;
    const labels = facts.map((f) => f.label);
    expect(labels).toContain('Customer');
    expect(labels).toContain('Application');
    expect(labels).toContain('Series');
    expect(facts.find((f) => f.label === 'Customer')!.value).toContain('Queue Subject Cust');
    expect(facts.find((f) => f.label === 'Series')!.value).toBe('NCD DEMO');
    expect(facts.find((f) => f.label === 'Money received')!.value).toBe('2026-07-11');
    // No internals leaking into the readable view.
    expect(labels).not.toContain('entity_id');
    expect(labels).not.toContain('chain');
  });
});
