/**
 * TWO REDEMPTIONS ON ONE INVESTMENT ON ONE DAY (owner 2026-11-26: "tts baskar
 * redemption im not seeing in the summary sheet?").
 *
 * The payout rows are keyed `(line_id, due_date, due_type)`, so a second
 * redemption on the same date lands on the SAME two rows as the first. Two
 * things then went wrong at once:
 *
 *   1. the second one took the FULL-redemption branch, whose sweep Skipped
 *      every Scheduled row on the application — including the Premature and
 *      BrokenInterest rows the FIRST redemption had written minutes earlier;
 *   2. its own inserts hit `ON CONFLICT DO NOTHING`, because the slot was
 *      already taken, so nothing replaced them.
 *
 * Both rows ended Skipped, the line left the book, and the broken interest
 * became unpayable by any sheet — no future batch ever looks at a line that is
 * no longer outstanding. On production that was Baskaran TTS, APP-2026-000368:
 * ₹6,246 recorded across the two redemptions, ₹3,123 on the single surviving
 * row, and that row Skipped. He was the only case in the book.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields, redeemPrematurely } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A live ₹10,00,000 investment. */
async function invested(name: string, phone: string): Promise<number> {
  const a = await superAdmin();
  const ncd = await as('ncd@demo.local');
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, schemeId,
    scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-12' });
  expect(app.status).toBe(201);
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  return Number(app.json.id);
}

/** Redeem `amount` of it, approved end to end, on `date`. */
async function redeem(appId: number, amount: number, date: string, reason: string) {
  const ncd = await as('ncd@demo.local');
  const init = await redeemPrematurely(ncd, { application_id: appId, reason, amount, redemption_date: date });
  expect(init.status).toBe(201);
  const reqId = init.json.request?.id ?? init.json.approval_request_id;
  if (reqId) await (await as('cxo@demo.local')).post(`/api/approvals/${reqId}/approve`);
  return init;
}

/** What the Premature row should come to: principal less penalty, both halves. */
const expectedPrincipalNet = async (appId: number) =>
  Number((await ctx.db.query(
    `SELECT COALESCE(sum(principal - penalty), 0) AS n FROM redemptions
      WHERE application_id = $1 AND status IN ('Approved','Paid')`, [appId])).rows[0]!.n);

const payoutRows = async (appId: number, date: string) =>
  (await ctx.db.query(
    `SELECT due_type, status, gross_amount, tds_amount, net_amount
       FROM disbursement_schedule
      WHERE application_id = $1 AND due_date = $2::date AND due_type IN ('Premature','BrokenInterest')
      ORDER BY due_type`, [appId, date])).rows as Array<Record<string, string>>;

describe('two redemptions on the same investment on the same day', () => {
  const DATE = '2026-11-17';

  it('keeps ONE payable row per type, carrying BOTH halves', async () => {
    const appId = await invested('Same Day Redeemer', '9713000001');
    await redeem(appId, 500000, DATE, 'Bring into current series');
    const afterFirst = await payoutRows(appId, DATE);
    expect(afterFirst).toHaveLength(2);
    const firstBroken = Number(afterFirst.find((r) => r.due_type === 'BrokenInterest')!.gross_amount);
    expect(firstBroken).toBeGreaterThan(0);

    // The second half, same day. This is the call that used to destroy the
    // first one's rows and then decline to write its own.
    await redeem(appId, 500000, DATE, 'Bring into current series');

    const rows = await payoutRows(appId, DATE);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // STILL PAYABLE. Skipped here is the bug: the line is off the book, so
      // nothing downstream will ever look at it again.
      expect(r.status).toBe('Scheduled');
    }
    const broken = rows.find((r) => r.due_type === 'BrokenInterest')!;
    const premature = rows.find((r) => r.due_type === 'Premature')!;
    // Both halves, not one: the second redemption's interest is not dropped.
    expect(Number(broken.gross_amount)).toBe(firstBroken * 2);
    expect(Number(broken.net_amount)).toBe(Number(broken.gross_amount) - Number(broken.tds_amount));
    // Principal less penalty, for BOTH halves — the second one is not lost.
    expect(Number(premature.net_amount)).toBe(await expectedPrincipalNet(appId));
  });

  it('the broken interest reaches the next summary sheet', async () => {
    // The whole point of leaving it Scheduled — the owner looked for this
    // customer on the sheet and could not find him.
    const appId = await invested('Same Day On Sheet', '9713000002');
    await redeem(appId, 500000, DATE, 'Reinvest');
    await redeem(appId, 500000, DATE, 'Reinvest');

    const a = await superAdmin();
    const preview = await a.get('/api/payouts/preview?date=2026-11-28');
    expect(preview.status).toBe(200);
    const mine = (preview.json.rows as Array<Record<string, unknown>>)
      .filter((r) => Number(r.application_id) === appId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((r) => Number(r.gross_amount) > 0)).toBe(true);
  });

  it('an EARLIER partial redemption keeps its unpaid slice when the rest is redeemed', async () => {
    // The same loss, spread over two dates: a partial on the 10th leaves a
    // broken-interest slice waiting for the batch, and the full redemption on
    // the 17th used to sweep it away on its way past. Nothing re-arms that row
    // — it is at a different date — so only the sweep guard saves it.
    const appId = await invested('Partial Then Full', '9713000004');
    await redeem(appId, 400000, '2026-11-10', 'Part now');
    const early = await payoutRows(appId, '2026-11-10');
    expect(early).toHaveLength(2);
    const earlyBroken = Number(early.find((r) => r.due_type === 'BrokenInterest')!.gross_amount);

    await redeem(appId, 600000, DATE, 'The rest');

    const still = await payoutRows(appId, '2026-11-10');
    expect(still.every((r) => r.status === 'Scheduled')).toBe(true);
    expect(Number(still.find((r) => r.due_type === 'BrokenInterest')!.gross_amount)).toBe(earlyBroken);
    // ...and the later redemption's own rows are payable too.
    expect((await payoutRows(appId, DATE)).every((r) => r.status === 'Scheduled')).toBe(true);
  });

  it('the at-maturity projection is still swept away', async () => {
    // The control for the guard above: it must not keep rows the redemption
    // genuinely cancels. A line's ORIGINAL BrokenInterest row sits at maturity,
    // years out, and redeeming early must still take it off the books.
    const appId = await invested('Projection Swept', '9713000005');
    await redeem(appId, 1000000, DATE, 'All of it');
    const future = (await ctx.db.query(
      `SELECT count(*)::int n FROM disbursement_schedule
        WHERE application_id = $1 AND due_date > $2::date AND status = 'Scheduled'`,
      [appId, DATE])).rows[0] as { n: number };
    expect(future.n).toBe(0);
  });

  it('a single redemption is completely unchanged', async () => {
    // The control. Nothing about the ordinary one-redemption path moves.
    const appId = await invested('One Redemption Only', '9713000003');
    await redeem(appId, 1000000, DATE, 'Maturity plans');
    const rows = await payoutRows(appId, DATE);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'Scheduled')).toBe(true);
    expect(Number(rows.find((r) => r.due_type === 'Premature')!.net_amount)).toBe(await expectedPrincipalNet(appId));
  });
});
