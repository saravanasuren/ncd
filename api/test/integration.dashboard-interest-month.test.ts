/**
 * "This month's interest (projected)" dashboard drill (interest-month) must
 * show only what's still actually owed. Found live: a fully-Redeemed
 * application's old 'Skipped' schedule row — left behind once its interest
 * stopped being owed — was still showing up on the widget, which is what made
 * its stale (pre-28th-convention) due date stand out in the first place. The
 * real bug wasn't the date, it was that the row appeared at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('dashboard "interest-month" drill excludes Skipped rows from redeemed apps', () => {
  it('only the Scheduled row for the still-Active app shows, not the Skipped one', async () => {
    const db = ctx.db;
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const today = new Date().toISOString().slice(0, 10);

    const mkAppLine = async (tag: string, appStatus: string, lineStatus: string, outstanding: number, schedStatus: string) => {
      const cust = Number((await db.query(
        "INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ($1,$2,$3,'Approved',TRUE) RETURNING id",
        [`IM${tag}`, `Interest Month ${tag}`, `93000000${tag}`])).rows[0]!.id);
      const appId = Number((await db.query(
        "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount) VALUES ($1,$2,$3,$4,1000000) RETURNING id",
        [`APP-IM-${tag}`, cust, seriesId, appStatus])).rows[0]!.id);
      const lineId = Number((await db.query(
        `INSERT INTO application_lines (application_id, coupon_rate_pct, tenure_months, amount, outstanding_amount, status)
         VALUES ($1,12,36,1000000,$2,$3) RETURNING id`, [appId, outstanding, lineStatus])).rows[0]!.id);
      await db.query(
        `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status)
         VALUES ($1,$2,$3,'Interest',10000,0,10000,$4)`, [lineId, appId, today, schedStatus]);
      return appId;
    };

    // Still active and owed — must show.
    await mkAppLine('Live', 'Active', 'Active', 1000000, 'Scheduled');
    // Fully redeemed — the schedule row is a dead artifact, not owed. Must NOT show.
    await mkAppLine('Dead', 'Redeemed', 'Redeemed', 0, 'Skipped');

    const a = await admin();
    const drill = await a.get('/api/dashboard/drill/interest-month');
    const rows = drill.json.rows as Array<{ customer: string; status: string }>;
    expect(rows.some((r) => r.customer === 'Interest Month Live')).toBe(true);
    expect(rows.some((r) => r.customer === 'Interest Month Dead')).toBe(false);
  });
});
