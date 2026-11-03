/**
 * Maturity runs from the SERIES close date, interest from the money date.
 *
 * Owner 2026-11-03: "the series close date is the allotment date. the redemption
 * date / maturity date should be calculated from series close date + tenure."
 *
 * The engine already worked this way — lib/interest.ts computes
 * `maturityDate = addMonths(seriesDeemedDate, tenure)` and materialize.ts falls
 * back to the money-received date only when the series has no deemed date. These
 * series had none, so every investment matured on its own money date.
 *
 * The first test is the load-bearing one: it proves that setting the series date
 * fixes every FUTURE investment on its own, with no change to the interest
 * engine. If that holds, migration 108 plus a one-off realign of the existing
 * schedules is the whole job.
 *
 * The second half matters just as much: interest must NOT move. Shifting it to
 * the close date would take back interest already paid to roughly 120 customers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let datedSeries: number, undatedSeries: number, schemeId: number;
let admin: Client, checker: Client;

const CLOSE = '2026-09-30';

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await ctx.db.query('UPDATE schemes SET tenure_months = 60 WHERE id = $1', [schemeId]);

  datedSeries = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('SD3', 'Subordinate Debt 3', 'Open', 100000, TRUE, DATE '${CLOSE}', DATE '${CLOSE}') RETURNING id`)).rows[0]!.id);
  // The same series as it was BEFORE migration 108 — no anchor at all.
  undatedSeries = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date)
     VALUES ('SD4', 'Subordinate Debt 4', 'Open', 100000, TRUE, DATE '2026-10-31') RETURNING id`)).rows[0]!.id);
  for (const s of [datedSeries, undatedSeries]) {
    await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [s, schemeId]);
  }

  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

async function invest(seriesId: number, name: string, phone: string, received: string) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: received,
  });
  await approveInvestment(checker, app);
  return Number(app.json.id);
}

const maturityOf = async (appId: number) => String((await ctx.db.query<{ d: string }>(
  'SELECT maturity_date AS d FROM application_lines WHERE application_id = $1', [appId])).rows[0]!.d).slice(0, 10);

const scheduleOf = async (appId: number) => (await ctx.db.query<Record<string, unknown>>(
  `SELECT due_date, due_type FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date`, [appId])).rows;

describe('a new investment matures on its series close date', () => {
  it('two investments paid on different days mature on the SAME day', async () => {
    // The whole point of consolidating: one bond per customer per series can
    // only state one redemption date if the series agrees on one.
    const early = await invest(datedSeries, 'Close Early', '9552220001', '2026-09-01');
    const late = await invest(datedSeries, 'Close Late', '9552220002', '2026-09-30');

    expect(await maturityOf(early)).toBe('2031-09-30');
    expect(await maturityOf(late)).toBe('2031-09-30');
    // Not the old behaviour, which would have been each one's own money date.
    expect(await maturityOf(early)).not.toBe('2031-09-01');
  });

  it('still earns interest from the day the money arrived, not the close date', async () => {
    // Moving interest to the close date would take back interest already paid to
    // roughly 120 customers. The early payer must have an interest row BEFORE
    // the late payer's money ever landed.
    const early = await invest(datedSeries, 'Interest Early', '9552220003', '2026-09-01');
    const rows = await scheduleOf(early);
    const interest = rows.filter((r) => r.due_type === 'Interest' || r.due_type === 'BrokenInterest');
    expect(interest.length).toBeGreaterThan(0);
    const first = String(interest[0]!.due_date).slice(0, 10);
    expect(first < '2026-10-28', `first interest row ${first} should fall in the month the money arrived`).toBe(true);
  });

  it('returns the principal on the series date, once', async () => {
    const appId = await invest(datedSeries, 'Principal Once', '9552220004', '2026-09-12');
    const redemptions = (await scheduleOf(appId)).filter((r) => r.due_type === 'Redemption');
    expect(redemptions.length).toBe(1);
    expect(String(redemptions[0]!.due_date).slice(0, 10)).toBe('2031-09-30');
  });

  it('falls back to the money date when the series has NO close date — the bug', async () => {
    // Exactly what every one of these investments did before migration 108, and
    // why they all matured on different days.
    const appId = await invest(undatedSeries, 'No Anchor', '9552220005', '2026-10-07');
    expect(await maturityOf(appId)).toBe('2031-10-07');
  });
});
