/**
 * Money received on or after the 25th is paid in the NEXT month's interest
 * batch (owner 2026-10-26). The setting is `interest.next_batch_from_day`,
 * default 25.
 *
 * What is pinned here, through the real payout preview:
 *   • an investment from the 25th onwards is left out of that month's batch;
 *   • the next month's batch pays it from the day the money arrived — nothing
 *     is lost, only moved;
 *   • money before the 25th is paid that month exactly as before;
 *   • an investment booked BEFORE the rule (its stored schedule already holds
 *     a payout that month) keeps it — the owner chose "new investments only".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

const AMOUNT = 100000;   // ₹1L
const RATE = 12;         // demo scheme coupon
const perDay = (AMOUNT * RATE) / 100 / 365;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function liveInvestment(phone: string, moneyReceived: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: uniqueName('Late Month', phone), phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `7770${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount: AMOUNT, date_money_received: moneyReceived, collection_method: 'NEFT/RTGS', collection_reference: `UTR-${phone}`,
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
}

const rowFor = async (appId: number, date: string) =>
  ((await (await admin()).get(`/api/payouts/preview?date=${date}`)).json.rows as any[])
    .find((r) => Number(r.application_id) === appId);

const firstScheduledDue = async (appId: number) =>
  String((await ctx.db.query(
    `SELECT to_char(min(due_date), 'YYYY-MM-DD') AS d FROM disbursement_schedule
      WHERE application_id = $1 AND due_type IN ('Interest','BrokenInterest')`, [appId])).rows[0]!.d);

describe('money received from the 25th waits for next month\'s batch', () => {
  it('the setting is there, defaulting to 25', async () => {
    const r = await (await admin()).get('/api/settings');
    const s = (r.json.groups.Interest as any[]).find((x) => x.key === 'interest.next_batch_from_day');
    expect(s.value).toBe(25);
  });

  it('received 26 Oct: not in the 28 Oct batch, paid 34 days in the 28 Nov batch', async () => {
    const appId = await liveInvestment('9730000001', '2026-10-26');
    expect(await rowFor(appId, '2026-10-28')).toBeUndefined();
    const nov = await rowFor(appId, '2026-11-28');
    expect(nov.from_date).toBe('2026-10-26');
    expect(Number(nov.days)).toBe(34);           // 26 Oct … 28 Nov, the 26th counts
    expect(Number(nov.gross_amount)).toBe(Math.round(perDay * 34));
    // The stored schedule says the same thing.
    expect(await firstScheduledDue(appId)).toBe('2026-11-28');
  });

  it('received ON the 25th moves too', async () => {
    const appId = await liveInvestment('9730000002', '2026-10-25');
    expect(await rowFor(appId, '2026-10-28')).toBeUndefined();
    expect(Number((await rowFor(appId, '2026-11-28')).days)).toBe(35);
  });

  it('received 24 Oct is paid on 28 Oct as before', async () => {
    const appId = await liveInvestment('9730000003', '2026-10-24');
    const oct = await rowFor(appId, '2026-10-28');
    expect(Number(oct.days)).toBe(5);
    expect(await firstScheduledDue(appId)).toBe('2026-10-28');
  });

  it('booked before the rule: keeps the 28 Oct payment its schedule already holds', async () => {
    const a = await admin();
    expect((await a.put('/api/settings/interest.next_batch_from_day', { value: 0 })).status).toBe(200);
    let appId: number;
    try {
      appId = await liveInvestment('9730000004', '2026-10-26');
    } finally {
      await a.put('/api/settings/interest.next_batch_from_day', { value: 25 });
    }
    expect(await firstScheduledDue(appId)).toBe('2026-10-28');
    const oct = await rowFor(appId, '2026-10-28');
    expect(oct, 'an investment booked before the rule is still paid this month').toBeTruthy();
    expect(Number(oct.days)).toBe(3);
  });
});
