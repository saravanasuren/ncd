/**
 * "New investments" (owner 2026-07-26): the tile and its drill-down show the
 * 30 MOST RECENT investments, whole book — not a date-window sum like every
 * other flow tile. Seeds 35 to actually exercise the cap and the ordering,
 * since every other fixture in the suite has far fewer than 30.
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

describe('dashboard "New investments" caps at the 30 most recent, whole book', () => {
  it('older investments beyond 30 are excluded from both the tile total and the drill', async () => {
    const db = ctx.db;
    const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);

    // 35 investments, one per day, oldest first (2026-01-01) to newest (2026-02-04).
    for (let i = 0; i < 35; i++) {
      const day = String(i + 1).padStart(2, '0');
      const date = i < 31 ? `2026-01-${day}` : `2026-02-${String(i - 30).padStart(2, '0')}`;
      const cust = Number((await db.query(
        "INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ($1,$2,$3,'Approved',TRUE) RETURNING id",
        [`NI${String(i).padStart(3, '0')}`, `New Investment Cap ${i}`, `92${String(i).padStart(8, '0')}`])).rows[0]!.id);
      await db.query(
        `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
         VALUES ($1,$2,$3,'Active',100000,$4)`, [`APP-NICAP-${i}`, cust, seriesId, date]);
    }

    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    expect(Number(ov.json.flow.money_in)).toBe(3000000); // exactly 30 × ₹1,00,000
    expect(ov.json.flow.new_investments).toBe(30);

    const drill = await a.get('/api/dashboard/drill/new-investments');
    expect(drill.json.kind).toBe('rows');
    const rows = drill.json.rows as Array<{ customer_code: string; date_money_received: string }>;
    expect(rows.length).toBe(30);
    // The 5 oldest (i = 0..4, Jan 1–5) must NOT appear — only the 30 most recent.
    const codes = rows.map((r) => r.customer_code);
    for (let i = 0; i < 5; i++) expect(codes).not.toContain(`NI${String(i).padStart(3, '0')}`);
    // The single most recent one (i = 34, Feb 4) must be first (DESC order).
    expect(codes).toContain('NI034');
    expect(rows[0]!.customer_code).toBe('NI034');
  });
});
