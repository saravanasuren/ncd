/**
 * Every credit line must carry its OWN money-received date.
 *
 * The payout sheet resolves a period start as
 *   COALESCE(<paid watermark>, line.date_money_received, app.interest_start_date)
 * so a line left NULL silently falls through to the application's
 * interest_start_date. That is invisible until interest_start_date is wrong,
 * and then the accrual is wrong with nothing on screen to show it.
 *
 * Mythili D APP-2026-001083 (2026-08-26) was exactly this: the LockerHub/app
 * payment path created her line with no date, her money date was corrected to
 * 16-08 on approval but interest_start_date stayed 15-08, and she accrued a day
 * early — Rs 3,490 instead of Rs 3,241.
 *
 * 🔒 interest-logic-locked: stamping the line changes no figure on any path
 * here (the value is the same one the fallback already resolved to); it removes
 * the implicit dependency, which is what lets the payout health check treat a
 * dateless line as a fault rather than as normal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

function appPayment(overrides: Record<string, unknown>) {
  return fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
    method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ series_id: seriesId, scheme_id: schemeId, amount: 200000, provider: 'easebuzz', provider_ref: 'EZB', verified: true, ...overrides }),
  }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
}

describe('an app/LockerHub investment stamps its line with the money date', () => {
  it('the line carries paid_at, not NULL', async () => {
    const r = await appPayment({
      customer_phone: '9400002001', customer_name: 'Line Date A',
      lockerhub_intent_no: 'LHB-LD-1', paid_at: '2026-07-05',
    });
    expect(r.status).toBe(200);

    const app = (await ctx.db.query(
      "SELECT id, date_money_received, interest_start_date FROM applications WHERE lockerhub_intent_no = 'LHB-LD-1'")).rows[0]! as any;
    expect(String(app.date_money_received).slice(0, 10)).toBe('2026-07-05');

    const line = (await ctx.db.query(
      'SELECT date_money_received FROM application_lines WHERE application_id = $1', [app.id])).rows[0]! as any;
    // THE FIX: this was NULL, so the accrual leaned on interest_start_date.
    expect(line.date_money_received).not.toBeNull();
    expect(String(line.date_money_received).slice(0, 10)).toBe('2026-07-05');
  });

  it('the sheet accrues from the line date even if interest_start_date drifts', async () => {
    const r = await appPayment({
      customer_phone: '9400002002', customer_name: 'Line Date B',
      lockerhub_intent_no: 'LHB-LD-2', paid_at: '2026-07-20',
    });
    expect(r.status).toBe(200);
    const app = (await ctx.db.query(
      "SELECT id FROM applications WHERE lockerhub_intent_no = 'LHB-LD-2'")).rows[0]! as any;

    // Force the exact drift Mythili had: interest_start_date left on an older
    // day than the money actually arrived. With the line stamped, the accrual
    // must ignore it; before the fix it followed it and started early.
    await ctx.db.query("UPDATE applications SET interest_start_date = '2026-07-01' WHERE id = $1", [app.id]);

    const { Client } = await import('./helpers/server.js');
    const a = new Client(ctx.base);
    await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const p = (await a.get('/api/payouts/preview?date=2026-07-28')).json;
    const row = (p.rows as any[]).find((x) => Number(x.application_id) === Number(app.id))!;
    expect(row).toBeDefined();
    expect(String(row.from_date).slice(0, 10)).toBe('2026-07-20');   // not 2026-07-01
    expect(Number(row.days)).toBe(9);                                 // 20th→28th = 8, +1 first period
  });
});
