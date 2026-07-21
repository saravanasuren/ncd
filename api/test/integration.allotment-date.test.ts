/**
 * Allotment date is editable (and backdatable) at approval time (owner
 * 2026-07-21). The approver's date overrides the maker's; an invalid date is
 * rejected and leaves the apps un-allotted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Fresh series with one Active, not-yet-allotted app. */
async function seedSeries(code: string, phone: string) {
  const db = ctx.db;
  const seriesId = Number((await db.query("INSERT INTO series (code, name, status) VALUES ($1,$2,'Closing') RETURNING id", [code, `${code} Test`])).rows[0]!.id);
  const cust = Number((await db.query("INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ($1,'Allot Cust',$2,'Approved',TRUE) RETURNING id", [`C${code}`, phone])).rows[0]!.id);
  const appId = Number((await db.query("INSERT INTO applications (application_no, customer_id, series_id, status, total_amount) VALUES ($1,$2,$3,'Active',500000) RETURNING id", [`APP-${code}`, cust, seriesId])).rows[0]!.id);
  return { seriesId, appId };
}

describe('allotment date override at approval', () => {
  it('the approver can backdate the allotment date (override wins over the maker)', async () => {
    const { seriesId, appId } = await seedSeries('NCD-ALLOTA', '9733300001');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    expect(batch.status).toBe(201);
    // Approve with a DIFFERENT, earlier date.
    const appr = await (await admin()).post(`/api/approvals/${batch.json.request.id}/approve`, { extra: { allotment_date: '2026-07-17' } });
    expect(appr.status).toBe(200);
    const app = (await ctx.db.query('SELECT allotment_date FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.allotment_date).toBe('2026-07-17');   // the override, not the maker's 2026-07-20
  });

  it('an invalid override date is rejected and the apps stay un-allotted', async () => {
    const { seriesId, appId } = await seedSeries('NCD-ALLOTB', '9733300002');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    const appr = await (await admin()).post(`/api/approvals/${batch.json.request.id}/approve`, { extra: { allotment_date: 'not-a-date' } });
    expect(appr.status).toBe(400);
    const app = (await ctx.db.query('SELECT allotment_date FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.allotment_date).toBeNull();   // rolled back — not allotted
  });
});
