/**
 * Correcting the money-received date at approval must move the CREDIT LINE's
 * date too, not just the application's.
 *
 * Why this exists: the date lives in two places, and the payout sheet reads the
 * LINE's copy (per-tranche accrual, PR #341). Correcting only the application
 * left the line on the maker's original date, so the sheet accrued from a day
 * the money was not yet in. Found 2026-08-26 — Senthamil Selvi APP-2026-001030
 * was billed 31 days from 29-07 when her stored schedule said 28 from 01-08;
 * 7 investments over-paid and 1 under-paid, ~Rs 6,411.
 *
 * 🔒 interest-logic-locked — this pins the day counts the sheet produces.
 *
 * The second test is the CONTROL: a clubbed investment's tranches each have a
 * REAL, different date. Pushing the application's single date down onto them
 * would destroy that and under-pay the customer, so it must not happen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const lineDates = async (appId: number) =>
  ((await ctx.db.query(
    'SELECT date_money_received FROM application_lines WHERE application_id = $1 ORDER BY id', [appId])).rows as any[])
    .map((r) => String(r.date_money_received).slice(0, 10));

describe('approval-time date correction reaches the credit line', () => {
  it('single credit: the line moves with the application, and the sheet follows', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Edit OnApprove', phone: '9704100001' });
    // Maker enters the 5th; the money actually arrived on the 20th.
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    const appId = Number(create.json.id);
    expect(await lineDates(appId)).toEqual(['2026-07-05']);

    // Checker corrects it to the 20th at the moment of approval.
    const reqId = create.json.subscription_request.id;
    const ok = await (await as('ncd@demo.local')).post(`/api/approvals/${reqId}/approve`,
      { extra: { edits: { date_money_received: '2026-07-20' } } });
    expect(ok.status).toBe(200);

    const app = (await ctx.db.query(
      'SELECT date_money_received, interest_start_date FROM applications WHERE id = $1', [appId])).rows[0]! as any;
    expect(String(app.date_money_received).slice(0, 10)).toBe('2026-07-20');
    // THE FIX: the line must have moved too. Before, it stayed on 2026-07-05.
    expect(await lineDates(appId)).toEqual(['2026-07-20']);

    // And the sheet must accrue from the 20th: 20th → 28th = 8 days, +1 for the
    // first period = 9. On the stale date it was 23 + 1 = 24 — a 15-day overpay.
    const p = (await a.get('/api/payouts/preview?date=2026-07-28')).json;
    const row = (p.rows as any[]).find((r) => Number(r.application_id) === appId)!;
    expect(row).toBeDefined();
    expect(String(row.from_date).slice(0, 10)).toBe('2026-07-20');
    expect(Number(row.days)).toBe(9);
  });

  it('CONTROL: a clubbed investment keeps each tranche its own date', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Clubbed Keeps', phone: '9704100002' });
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.json.clubbed).toBe(true);
    expect(await lineDates(appId)).toEqual(['2026-07-05', '2026-07-20']);

    // An edit on approval must NOT flatten the two real credit dates into one.
    const reqId = first.json.subscription_request.id;
    const ok = await (await as('ncd@demo.local')).post(`/api/approvals/${reqId}/approve`,
      { extra: { edits: { date_money_received: '2026-07-10' } } });
    expect(ok.status).toBe(200);
    expect(await lineDates(appId)).toEqual(['2026-07-05', '2026-07-20']);
  });
});
