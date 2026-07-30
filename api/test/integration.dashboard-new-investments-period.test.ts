/**
 * "New investments" tile (owner change 2026-07-30): it now HONOURS the selected
 * date window — Today → today's additions, This month → this month's — instead
 * of the earlier fixed "last 30 recent, whole book" reading. The tile total, its
 * count and its drill list all come from the same window-aware rows, and the
 * drill rows carry customer_id so each name clicks through to the profile.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
  const db = ctx.db;
  const seriesId = Number((await db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  // 3 investments in Jan 2026, 2 in Feb 2026 — ₹1,00,000 each.
  const mk = async (i: number, date: string) => {
    const cust = Number((await db.query(
      "INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ($1,$2,$3,'Approved',TRUE) RETURNING id",
      [`NIP${String(i).padStart(3, '0')}`, `New Inv Period ${String.fromCharCode(65 + i)}`, `93${String(i).padStart(8, '0')}`])).rows[0]!.id);
    await db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
       VALUES ($1,$2,$3,'Active',100000,$4)`, [`APP-NIP-${i}`, cust, seriesId, date]);
  };
  await mk(0, '2026-01-05'); await mk(1, '2026-01-12'); await mk(2, '2026-01-20');
  await mk(3, '2026-02-08'); await mk(4, '2026-02-15');
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('dashboard "New investments" honours the date window', () => {
  it('a February window shows only February additions', async () => {
    const ov = await (await admin()).get('/api/dashboard/overview?from=2026-02-01&to=2026-02-28');
    expect(ov.json.flow.new_investments).toBe(2);
    expect(Number(ov.json.flow.money_in)).toBe(200000);
  });

  it('a January window shows only January additions', async () => {
    const ov = await (await admin()).get('/api/dashboard/overview?from=2026-01-01&to=2026-01-31');
    expect(ov.json.flow.new_investments).toBe(3);
    expect(Number(ov.json.flow.money_in)).toBe(300000);
  });

  it('an empty window shows zero (it no longer falls back to "recent")', async () => {
    const ov = await (await admin()).get('/api/dashboard/overview?from=2020-01-01&to=2020-01-31');
    expect(ov.json.flow.new_investments).toBe(0);
    expect(Number(ov.json.flow.money_in)).toBe(0);
  });

  it('the drill lists the window rows (no 30-cap) and carries customer_id for the name link', async () => {
    const dl = await (await admin()).get('/api/dashboard/drill/new-investments?from=2026-01-01&to=2026-02-28');
    expect(dl.json.kind).toBe('rows');
    const rows = dl.json.rows as Array<{ customer_id: number; date_money_received: string }>;
    expect(rows.length).toBe(5);                       // all five, none capped away
    expect(rows.every((r) => typeof r.customer_id === 'number')).toBe(true); // name → profile
    // Newest first.
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.date_money_received >= rows[i]!.date_money_received).toBe(true);
  });
});
