/**
 * Customer 360 detail: a redeemed investment shows Outstanding 0, not its
 * original amount (review 2026-07-21 — the COALESCE fallback used to leak the
 * subscribed amount into Outstanding for exited apps).
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

describe('customer detail — outstanding by status', () => {
  it('a redeemed app reads Outstanding 0; an active app reads its live amount', async () => {
    const db = ctx.db;
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const cust = Number((await db.query(
      "INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ('COUT1','Outstanding Cust','9755500001','Approved',TRUE) RETURNING id")).rows[0]!.id);
    await db.query("INSERT INTO applications (application_no, customer_id, series_id, status, total_amount) VALUES ('APP-OUT-A',$1,$2,'Active',500000)", [cust, seriesId]);
    await db.query("INSERT INTO applications (application_no, customer_id, series_id, status, total_amount) VALUES ('APP-OUT-R',$1,$2,'Redeemed',300000)", [cust, seriesId]);

    const detail = await (await admin()).get(`/api/customers/${cust}`);
    expect(detail.status).toBe(200);
    const apps: any[] = detail.json.applications;
    const active = apps.find((a) => a.application_no === 'APP-OUT-A');
    const redeemed = apps.find((a) => a.application_no === 'APP-OUT-R');
    // Invested (amount) is the original figure for both…
    expect(Number(active.amount)).toBe(500000);
    expect(Number(redeemed.amount)).toBe(300000);
    // …but Outstanding is the live figure: full for active, 0 once redeemed.
    expect(Number(active.outstanding)).toBe(500000);
    expect(Number(redeemed.outstanding)).toBe(0);
  });
});
