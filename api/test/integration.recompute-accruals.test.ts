/**
 * recompute-accruals: an app whose referrer is filled in AFTER activation (a
 * Direct-backfill) has no referrer accrual; re-running accrueForApplication
 * creates the missing one and is idempotent (no duplicate on a second run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';
import { accrueForApplication } from '../src/modules/incentives/accrual.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('recompute accruals for a late referrer', () => {
  it('creates the missing referrer accrual, idempotently', async () => {
    const a = await admin();
    // Enrol + approve (go live) WITHOUT a referrer (a "Direct" app).
    const cust = await a.post('/api/customers', { full_name: 'Late Ref Cust', phone: '9733300021' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '5551110022', ifsc: 'ICIC0001111' });
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 300000, date_money_received: '2026-07-10' });
    const appId = Number(app.json.id);
    const ncd = new Client(ctx.base); await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    await approveInvestment(ncd, app);

    const refCount = async () => Number((await ctx.db.query(
      "SELECT count(*)::int n FROM incentive_accruals WHERE application_id=$1 AND matrix_cell='referrer'", [appId])).rows[0].n);

    // No referrer at activation → no referrer accrual.
    expect(await refCount()).toBe(0);

    // Direct-backfill: set the referrer to a real agent AFTER the fact.
    await ctx.db.query("UPDATE applications SET referred_by_text='Field Agent X' WHERE id=$1", [appId]);
    await ctx.db.query("UPDATE customers SET referred_by_text='Field Agent X' WHERE id=$1", [cust.json.id]);

    // Recompute → referrer accrual now exists.
    await ctx.db.withTx((tx) => accrueForApplication(tx, appId));
    expect(await refCount()).toBe(1);

    // Idempotent: a second run does not duplicate.
    await ctx.db.withTx((tx) => accrueForApplication(tx, appId));
    expect(await refCount()).toBe(1);
  });
});
