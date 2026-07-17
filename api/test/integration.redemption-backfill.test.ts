/**
 * Maturity-redemption backfill (migration 013). Legacy maturity redemptions were
 * only ever recorded as application.status='Redeemed' — no `redemptions` row —
 * so they never showed in the Redemptions section. The backfill creates one log
 * entry per redeemed application that lacks a redemption, from the data present
 * (principal = the investment amount). Idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
const BACKFILL_SQL = readFileSync(fileURLToPath(new URL('../src/db/migrations/013_redemption_backfill.sql', import.meta.url)), 'utf8');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

/** A redeemed investment with NO redemption row (the legacy maturity case). */
async function redeemedApp(code: string, name: string, appNo: string, amount: number): Promise<number> {
  const cust = await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (customer_code, full_name, is_active) VALUES ($1,$2,TRUE) RETURNING id`, [code, name]);
  const cid = Number(cust.rows[0]!.id);
  const app = await ctx.db.query<{ id: string }>(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, maturity_date, redemption_date, date_money_received)
     VALUES ($1,$2,$3,'Redeemed',$4,'2026-01-01','2026-01-05','2023-01-01') RETURNING id`,
    [appNo, cid, seriesId, amount]);
  return Number(app.rows[0]!.id);
}

describe('redemption backfill (migration 013)', () => {
  it('logs a maturity redemption for a redeemed app that had none', async () => {
    const a = await admin();
    const appId = await redeemedApp('RDM-1', 'Redeemed Investor', 'APP-RDM-1', 200000);

    // Before: the redeemed investment has no redemption entry.
    const before = await a.get('/api/redemptions');
    expect((before.json.rows as Array<{ application_no: string }>).some((r) => r.application_no === 'APP-RDM-1')).toBe(false);

    await ctx.db.query(BACKFILL_SQL);

    const after = await a.get('/api/redemptions');
    const entry = (after.json.rows as Array<Record<string, unknown>>).find((r) => r.application_no === 'APP-RDM-1');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('maturity');                 // redeemed at/after maturity
    expect(Number(entry!.net_payment)).toBe(200000);      // principal
    expect(entry!.customer_name).toBe('Redeemed Investor');
    expect(entry!.redemption_no).toBe(`RED-MAT-${appId}`);
  });

  it('is idempotent — re-running creates no duplicate', async () => {
    await redeemedApp('RDM-2', 'Second Redeemed', 'APP-RDM-2', 300000);
    await ctx.db.query(BACKFILL_SQL);
    await ctx.db.query(BACKFILL_SQL); // twice
    const n = Number((await ctx.db.query(
      "SELECT count(*)::int AS n FROM redemptions r JOIN applications a ON a.id = r.application_id WHERE a.application_no = 'APP-RDM-2'")).rows[0]!.n);
    expect(n).toBe(1);
  });
});
