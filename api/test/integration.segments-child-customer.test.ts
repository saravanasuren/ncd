/**
 * Segment children must carry customer_id — the Segments page makes each
 * customer clickable to open their profile, and without the id the click has
 * nothing to fetch. Also guards that the id actually resolves to that customer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

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

describe('segments — customer rows are clickable through to a profile', () => {
  it('each child carries customer_id, and it fetches that customer', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const cust = await a.post('/api/customers', { full_name: 'Clickable Investor', phone: '9833000001' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-12',
    });
    await approveInvestment(ncd, app);

    const seg = await a.get('/api/reports/segments/series');
    const demo = (seg.json.groups as any[]).find((g) => g.key === 'NCD DEMO');
    const child = (demo.children as any[]).find((c) => c.application_no === app.json.application_no);
    expect(child).toBeTruthy();
    expect(child.customer_id).toBe(cust.json.id);   // what the click needs

    // …and that id resolves to the same person the row displayed.
    const profile = await a.get(`/api/customers/${child.customer_id}`);
    expect(profile.status).toBe(200);
    expect(profile.json.customer.full_name).toBe('Clickable Investor');
    expect(profile.json.customer.full_name).toBe(child.customer);
    expect((profile.json.applications as any[]).some((x) => x.application_no === app.json.application_no)).toBe(true);
  });
});
