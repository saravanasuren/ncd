/**
 * The screens that offer bond downloads must be able to tell a subordinate
 * series apart (owner 2026-11-02).
 *
 * A subordinate series issues ONE BOND PER INVESTMENT and has no consolidated
 * certificate. Every bond affordance in the web UI pointed at the CONSOLIDATED
 * endpoint, so once that endpoint started refusing, the operator clicked a link
 * and landed on a raw JSON error — and there was no per-investment link anywhere
 * to fall back to, leaving no way at all to print a bond for the new series.
 *
 * The UI can only make that distinction if the flag is in the payload, and a
 * missing field is silent: it reads as undefined, the page quietly takes the
 * wrong branch, and nothing fails until someone clicks. Hence these tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let subSeriesId: number, plainSeriesId: number, schemeId: number;
let admin: Client;

beforeAll(async () => {
  ctx = await startTestServer();
  plainSeriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  subSeriesId = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date)
     VALUES ('SD9', 'Subordinate Debt 9', 'Open', 100000, TRUE, DATE '2026-09-30') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [subSeriesId, schemeId]);
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
});
afterAll(async () => { await ctx.close(); });

async function invest(seriesId: number, name: string, phone: string) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-09-17',
  });
  const checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await approveInvestment(checker, app);
  return { customerId: Number(cust.json.id), appId: Number(app.json.id) };
}

describe('the customer page can tell a subordinate series apart', () => {
  it('flags the investment, so the page offers a per-investment bond', async () => {
    const { customerId, appId } = await invest(subSeriesId, 'Flag Sub', '9552330001');
    const res = await admin.get(`/api/customers/${customerId}`);
    const row = (res.json.applications as Record<string, unknown>[]).find((a) => Number(a.id) === appId)!;
    expect(row, 'the investment should be on the customer payload').toBeTruthy();
    expect(row.is_subordinate).toBe(true);
    // The number must come through too, or the page cannot tell an already-issued
    // bond from one whose download would permanently mint a number.
    expect(row).toHaveProperty('bond_serial_no');
  });

  it('does not flag an ordinary series, so the consolidated link stays', async () => {
    const { customerId, appId } = await invest(plainSeriesId, 'Flag Plain', '9552330002');
    const res = await admin.get(`/api/customers/${customerId}`);
    const row = (res.json.applications as Record<string, unknown>[]).find((a) => Number(a.id) === appId)!;
    expect(row.is_subordinate).toBe(false);
  });
});

describe('the allotments drill-down can tell a subordinate series apart', () => {
  it('carries the flag on the series, and the investments to link to', async () => {
    await invest(subSeriesId, 'Drill Sub', '9552330003');
    const res = await admin.get(`/api/allotments/series/${subSeriesId}/customers`);
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
    expect(res.json.series.is_subordinate).toBe(true);
    // Each row must expose its investments, because on a subordinate series the
    // page links to each investment's own bond rather than one per customer.
    const row = (res.json.rows as Record<string, unknown>[])[0]!;
    expect(Array.isArray(row.investments)).toBe(true);
    expect((row.investments as unknown[]).length).toBeGreaterThan(0);
    expect((row.investments as Record<string, unknown>[])[0]).toHaveProperty('application_id');
  });

  it('leaves an ordinary series unflagged', async () => {
    await invest(plainSeriesId, 'Drill Plain', '9552330004');
    const res = await admin.get(`/api/allotments/series/${plainSeriesId}/customers`);
    expect(res.json.series.is_subordinate).toBe(false);
  });
});
