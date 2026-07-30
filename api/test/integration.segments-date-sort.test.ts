/**
 * Segment children carry the money-received date (the "Date" column) and default
 * to latest-first, so a series expansion shows the newest investment on top.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function book(a: Client, name: string, phone: string, date: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: date,
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return app.json.application_no as string;
}

describe('segments — children carry the date and default to latest-first', () => {
  it('exposes date_money_received and orders newest first', async () => {
    const a = await admin();
    const older = await book(a, 'Seg Date Alpha', '9834000001', '2026-06-05');
    const newer = await book(a, 'Seg Date Bravo', '9834000002', '2026-08-20');

    const seg = await a.get('/api/reports/segments/series');
    const demo = (seg.json.groups as any[]).find((g) => g.key === 'NCD DEMO');
    const kids = demo.children as any[];

    const oldRow = kids.find((c) => c.application_no === older);
    const newRow = kids.find((c) => c.application_no === newer);
    expect(oldRow.date_money_received).toBe('2026-06-05');
    expect(newRow.date_money_received).toBe('2026-08-20');

    // The newer investment appears BEFORE the older one in the default order.
    expect(kids.indexOf(newRow)).toBeLessThan(kids.indexOf(oldRow));

    // And the whole list is non-increasing by date (latest first throughout).
    const dates = kids.map((c) => c.date_money_received ?? '');
    for (let i = 1; i < dates.length; i++) expect(dates[i - 1] >= dates[i]).toBe(true);
  });
});
