/**
 * The Allotments page shows how many CUSTOMERS a series has, not just how many
 * investments (owner 2026-08-21).
 *
 * The two genuinely differ: in NCD_28 eleven people hold two or three
 * investments each, so the investment count reads as a bigger customer base
 * than the series actually has. A test that used one customer per investment
 * would pass whether or not DISTINCT was there, so this one deliberately gives
 * a single customer several investments.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
const row = async (a: Client) => {
  const r = await a.get('/api/allotments/series');
  expect(r.status).toBe(200);
  return (r.json.rows as any[]).find((x) => Number(x.series_id) === seriesId)!;
};

describe('allotments — customer count', () => {
  it('counts PEOPLE, so two investments by one customer are one customer', async () => {
    const a = await admin();
    const c = await a.post('/api/customers', { full_name: 'Repeat Investor', phone: '9400005001', pan: 'RPTIN1234K' });
    const custId = Number(c.json.id);

    const before = await row(a);
    const c0 = Number(before.customer_count), i0 = Number(before.total_count);

    // Two investments, ONE customer. Activated so they count as live.
    for (const ref of ['CNT-1', 'CNT-2']) {
      const app = await a.post('/api/applications', {
        customer_id: custId, series_id: seriesId, scheme_id: schemeId, amount: 100000,
        ...requiredInvestmentFields(), collection_reference: ref,
      });
      expect(app.status).toBe(201);
      await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [app.json.id]);
    }

    const after = await row(a);
    expect(Number(after.total_count)).toBe(i0 + 2);      // two more investments
    expect(Number(after.customer_count)).toBe(c0 + 1);   // but only one more person
  });

  it('a second customer adds one to both', async () => {
    const a = await admin();
    const before = await row(a);
    const c = await a.post('/api/customers', { full_name: 'Second Investor', phone: '9400005002', pan: 'SECIN1234K' });
    const app = await a.post('/api/applications', {
      customer_id: Number(c.json.id), series_id: seriesId, scheme_id: schemeId, amount: 100000,
      ...requiredInvestmentFields(), collection_reference: 'CNT-3',
    });
    await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [app.json.id]);

    const after = await row(a);
    expect(Number(after.customer_count)).toBe(Number(before.customer_count) + 1);
    expect(Number(after.total_count)).toBe(Number(before.total_count) + 1);
  });

  it('describes the same Active rows the amount does — a non-Active investment counts in neither', async () => {
    const a = await admin();
    const before = await row(a);
    const c = await a.post('/api/customers', { full_name: 'Pending Investor', phone: '9400005003', pan: 'PNDIN1234K' });
    // Left in PendingApproval on purpose.
    const app = await a.post('/api/applications', {
      customer_id: Number(c.json.id), series_id: seriesId, scheme_id: schemeId, amount: 100000,
      ...requiredInvestmentFields(), collection_reference: 'CNT-4',
    });
    expect(app.status).toBe(201);

    const after = await row(a);
    expect(Number(after.customer_count)).toBe(Number(before.customer_count));
    expect(Number(after.total_count)).toBe(Number(before.total_count));
    expect(Number(after.total_amount)).toBe(Number(before.total_amount));
  });
});
