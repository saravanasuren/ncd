/**
 * The Active-series tile shows only the latest open series on its face, but its
 * drill lists ALL open series together (owner 2026-08-29 — NCD Bonds and any
 * other still-open series too). Backend proof: the `series` drill honours a
 * multi-id `series` filter and returns one group per series in it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesA: number, seriesB: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesA = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // A SECOND still-open series, sharing the demo scheme.
  seriesB = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, deemed_date, opened_at)
     VALUES ('NCD DEMO 2','Demo Series 2','Open','2026-07-01', now()) RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [seriesB, schemeId]);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const ncd = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' }); return c; };

async function activeApp(a: Client, checker: Client, name: string, phone: string, seriesId: number, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `33${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10' });
  await approveInvestment(checker, app);
  return app.json.id as number;
}

describe('active-series tile drill spans all open series', () => {
  it('the series drill returns a group for EACH open series in the filter', async () => {
    const a = await admin(); const checker = await ncd();
    await activeApp(a, checker, 'Open A Investor', '9700000101', seriesA, 400000);
    await activeApp(a, checker, 'Open B Investor', '9700000102', seriesB, 500000);

    const dl = await a.get(`/api/dashboard/drill/series?series=${seriesA},${seriesB}`);
    expect(dl.status).toBe(200);
    const keys = (dl.json.groups as any[]).map((g) => g.key);
    expect(keys).toContain('NCD DEMO');
    expect(keys).toContain('NCD DEMO 2');
  });

  it('narrows to a single series when only one id is passed', async () => {
    const a = await admin();
    const dl = await a.get(`/api/dashboard/drill/series?series=${seriesA}`);
    expect(dl.status).toBe(200);
    const keys = (dl.json.groups as any[]).map((g) => g.key);
    expect(keys).toContain('NCD DEMO');
    expect(keys).not.toContain('NCD DEMO 2');
  });

  it('the overview still names a single active series while both are Open', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    expect(ov.status).toBe(200);
    expect(ov.json.active_series).toBeTruthy();               // one series on the tile face
    const openCodes = (ov.json.series as any[]).filter((s) => s.status === 'Open').map((s) => s.code);
    expect(openCodes).toContain('NCD DEMO');                  // …but both are open in the register
    expect(openCodes).toContain('NCD DEMO 2');
  });
});
