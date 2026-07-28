/**
 * Someone who invests and is paid on the SAME day is owed that one day
 * (owner-approved 2026-07-28).
 *
 * previewDue skipped any line where `payoutDate <= paidThrough`. For a
 * brand-new line paidThrough IS interest_start_date — the day the money
 * arrived — so an investment made on the payout date was skipped entirely and
 * its first day silently rolled into the next batch. Owner rule 2026-07-25 is
 * that interest starts ON the day of investment, so that day belongs in the
 * same-day batch.
 *
 * The `==` case still has to skip an ALREADY-PAID line, where the watermark is
 * a due_date paid through end of that day — counting it again double-pays.
 * That guard is the dangerous half of this change, so it is pinned here too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

const AMOUNT = 100000;   // ₹1L
const RATE = 12;         // demo scheme coupon
const START = '2026-07-28';
const oneDay = (AMOUNT * RATE) / 100 / 365;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A live investment whose interest starts on `START`. */
async function liveInvestment(phone: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: uniqueName('Same Day', phone), phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `6660${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount: AMOUNT, date_money_received: START, collection_method: 'NEFT/RTGS', collection_reference: `UTR-${phone}`,
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
}

const rowFor = async (c: Client, appId: number, date: string) =>
  ((await c.get(`/api/payouts/preview?date=${date}`)).json.rows as any[]).find((r) => Number(r.application_id) === appId);

describe('an investment paid on the day it was made', () => {
  it('earns exactly one day in that same-day batch', async () => {
    const appId = await liveInvestment('9720000001');
    const row = await rowFor(await admin(), appId, START);
    expect(row, 'should now appear in the same-day preview').toBeTruthy();
    expect(Number(row.days)).toBe(1);
    expect(Number(row.gross_amount)).toBeCloseTo(oneDay, 2);
  });

  it('and two days by the next day — the day of investment still counts', async () => {
    const appId = await liveInvestment('9720000002');
    const row = await rowFor(await admin(), appId, '2026-07-29');
    expect(Number(row.days)).toBe(2);
  });

  it('paying that first day does NOT cost the customer anything overall', async () => {
    // 1 day now + the rest later must equal what the single later batch paid.
    const appId = await liveInvestment('9720000003');
    const a = await admin();
    const sameDay = Number((await rowFor(a, appId, START)).gross_amount);

    const b = await a.post('/api/payouts', { payout_date: START });
    expect(b.status).toBe(201);
    await (await as('ncd@demo.local')).post(`/api/approvals/${b.json.request.id}/approve`);

    const later = Number((await rowFor(a, appId, '2026-08-28')).gross_amount);
    // 28 Jul→28 Aug inclusive = 32 days, however it is split across batches.
    expect(sameDay + later).toBeCloseTo(oneDay * 32, 1);
  });
});

describe('the double-pay guard still holds', () => {
  it('a settled line accrues NOTHING when billed again for its own paid date', async () => {
    const appId = await liveInvestment('9720000004');
    const a = await admin();

    const b = await a.post('/api/payouts', { payout_date: '2026-08-28' });
    expect(b.status).toBe(201);
    await (await as('ncd@demo.local')).post(`/api/approvals/${b.json.request.id}/approve`);

    // Same date again: the watermark is now a real paid due_date, so re-billing
    // it would double-pay. Must be skipped.
    expect(await rowFor(a, appId, '2026-08-28')).toBeUndefined();
  });

  it('after settling, the next period starts fresh — no day billed twice', async () => {
    const appId = await liveInvestment('9720000005');
    const a = await admin();
    const b = await a.post('/api/payouts', { payout_date: '2026-08-28' });
    await (await as('ncd@demo.local')).post(`/api/approvals/${b.json.request.id}/approve`);

    const next = await rowFor(a, appId, '2026-09-28');
    expect(next.from_date).toBe('2026-08-28');       // watermark moved
    expect(Number(next.days)).toBe(31);              // 29 Aug…28 Sep, no +1 second time
  });
});
