/**
 * The Allotments page shows WHEN a series was allotted (owner 2026-08-28: "I'm
 * not seeing the allotment date of that series. bring in a column for that").
 *
 * The page listed the status but never the date, so "Allotted" told you it had
 * happened and nothing about when.
 *
 * Source matters: the date is read from the investments, where allotment_date is
 * actually stamped — NOT from allotment_batches, which also holds Cancelled
 * attempts. On production NCD_28 carries four cancelled batches (two of them on
 * dates it was never allotted on) beside the one approved batch; reading the
 * batch table would have shown a date for an allotment that never happened.
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

async function activeInvestment(a: Client, name: string, phone: string) {
  const c = await a.post('/api/customers', { full_name: name, phone });
  expect(c.status).toBe(201);
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: c.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
  });
  expect(app.status).toBe(201);
  await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [app.json.id]);
  return Number(app.json.id);
}

describe('allotments — the allotted-on date', () => {
  it('is blank while the series is still open', async () => {
    const a = await admin();
    await activeInvestment(a, 'Not Yet Allotted', '9400009001');
    expect((await row(a)).allotment_date).toBeNull();
  });

  it('shows the date once the investments are stamped', async () => {
    const a = await admin();
    const appId = await activeInvestment(a, 'Allotted Investor', '9400009002');
    await ctx.db.query("UPDATE applications SET allotment_date = '2026-08-20' WHERE id = $1", [appId]);
    expect(String((await row(a)).allotment_date).slice(0, 10)).toBe('2026-08-20');
  });

  it('ignores a CANCELLED allotment batch — that allotment never happened', async () => {
    // The trap this guards: allotment_batches keeps cancelled attempts, so
    // sourcing the column from there would date a series by an allotment that
    // was abandoned. Production has exactly this shape.
    const a = await admin();
    await ctx.db.query(
      `INSERT INTO allotment_batches (series_id, allotment_date, status, created_by_user_id)
       VALUES ($1, '2026-01-01', 'Cancelled', 1)`, [seriesId]);
    // Still the date the investments actually carry, not the cancelled one.
    expect(String((await row(a)).allotment_date).slice(0, 10)).toBe('2026-08-20');
  });

  it('a series with no investments at all reports no date rather than failing', async () => {
    const a = await admin();
    const empty = (await ctx.db.query<{ id: string }>(
      `INSERT INTO series (code, name, status) VALUES ('NCD EMPTY', 'NCD Empty', 'Open') RETURNING id`)).rows[0]!;
    const r = await a.get('/api/allotments/series');
    const found = (r.json.rows as any[]).find((x) => Number(x.series_id) === Number(empty.id));
    expect(found).toBeDefined();
    expect(found.allotment_date).toBeNull();
  });
});
