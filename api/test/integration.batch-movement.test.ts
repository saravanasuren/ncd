/**
 * Added / Redeemed on the "vs last paid batch" comparison (owner 2026-08-27):
 * "get me the current month addition and redemption data in a separate column
 * in between last batch and this batch."
 *
 * Two columns, covering the movement SINCE the last paid batch — the period the
 * comparison is about.
 *
 * What these numbers are NOT: an arithmetic bridge from Last batch to This
 * batch. Measured on production the day this was written — last 60.17Cr + added
 * 7.23Cr = this 67.40Cr exactly, while 1.20Cr was redeemed in the same window.
 * The redeemed principal is missing from the sum because `outstanding` re-reads
 * each line's LIVE value, so a redemption is already gone from the Last batch
 * figure too. Subtracting it again would double-count. The last test here pins
 * that, so nobody "fixes" the column into a bridge it cannot be.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

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

/** A paid interest batch dated `on`, so it becomes "the last paid batch". */
async function paidBatchOn(on: string) {
  // A fresh database has no lines at all, so seed one to hang the paid row on.
  const a = await admin();
  const seedCust = await a.post('/api/customers', { full_name: 'Batch Seed', phone: '9704000099' });
  await a.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: seedCust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 1300000, date_money_received: '2026-06-01' });
  const line = (await ctx.db.query<{ line_id: string; application_id: string }>(
    `SELECT id AS line_id, application_id FROM application_lines ORDER BY id LIMIT 1`)).rows[0]!;
  const batch = (await ctx.db.query<{ id: string }>(
    `INSERT INTO payout_batches (batch_no, kind, payout_date, total_gross, total_tds, total_net, status)
     VALUES ($1,'interest',$2, 1000, 100, 900, 'Paid') RETURNING id`, [`NEFT-MOVE-${on}`, on])).rows[0]!;
  await ctx.db.query(
    `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, batch_id)
     VALUES ($1,$2,$3,'Interest',1000,100,900,'Paid',$4)`,
    [line.line_id, line.application_id, on, batch.id]);
  return batch.id;
}

const summary = async () => (await (await admin()).get('/api/payouts/last-interest-summary')).json.summary;

describe('Added / Redeemed since the last paid batch', () => {
  it('counts money that came IN after the batch date, and ignores what came in before it', async () => {
    const a = await admin();
    await paidBatchOn('2026-06-30');

    // Before the cut-off — must NOT be counted.
    const before = await a.post('/api/customers', { full_name: 'Before Cutoff', phone: '9704000001' });
    await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: before.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-06-15' });

    const base = await summary();
    expect(base.movement.since).toBe('2026-06-30');

    // After the cut-off — must be counted.
    const after = await a.post('/api/customers', { full_name: 'After Cutoff', phone: '9704000002' });
    await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: after.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 300000, date_money_received: '2026-07-10' });

    const now = await summary();
    expect(now.movement.added.investments).toBe(base.movement.added.investments + 1);
    expect(now.movement.added.customers).toBe(base.movement.added.customers + 1);
    expect(Number(now.movement.added.amount)).toBe(Number(base.movement.added.amount) + 300000);
  });

  it('a customer topping up counts as one customer, not two', async () => {
    // The reason the column cannot bridge the two sides: an EXISTING customer
    // adding money is money in, but not a new customer. On production 24 of the
    // 72 "added" customers were already in the previous batch.
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Top Up Twice', phone: '9704000003' });
    const base = await summary();
    for (const amt of [100000, 200000]) {
      await a.post('/api/applications', { ...requiredInvestmentFields(),
        customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
        amount: amt, date_money_received: '2026-07-11' });
    }
    const now = await summary();
    expect(now.movement.added.investments).toBe(base.movement.added.investments + 2);
    expect(now.movement.added.customers).toBe(base.movement.added.customers + 1);
    expect(Number(now.movement.added.amount)).toBe(Number(base.movement.added.amount) + 300000);
  });

  it('money that never landed — rejected or withdrawn — is not counted as added', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Never Landed', phone: '9704000004' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 900000, date_money_received: '2026-07-12' });
    const base = await summary();
    await ctx.db.query("UPDATE applications SET status = 'Withdrawn' WHERE id = $1", [app.json.id]);
    const now = await summary();
    expect(now.movement.added.investments).toBe(base.movement.added.investments - 1);
    expect(Number(now.movement.added.amount)).toBe(Number(base.movement.added.amount) - 900000);
  });

  it('a redemption raised after the batch shows in Redeemed, valued at the principal returned', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Redeemer', phone: '9704000005' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 400000, date_money_received: '2026-07-13' });
    await approveInvestment(await as('ncd@demo.local'), app);

    const base = await summary();
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, redemption_date, principal, penalty, net_payment, status)
       VALUES ($1, $2, 'premature', '2026-07-20', 400000, 0, 400000, 'Approved')`,
      [`RED-MOVE-${app.json.id}`, app.json.id]);
    // What the real redemption flow does alongside the row — without this the
    // fixture is a shape production never has, and the last test below would be
    // asserting against fiction.
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0 WHERE application_id = $1", [app.json.id]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app.json.id]);

    const now = await summary();
    expect(now.movement.redeemed.redemptions).toBe(base.movement.redeemed.redemptions + 1);
    expect(now.movement.redeemed.customers).toBe(base.movement.redeemed.customers + 1);
    expect(Number(now.movement.redeemed.amount)).toBe(Number(base.movement.redeemed.amount) + 400000);
  });

  it('Added and Redeemed are a record of the period, NOT a bridge between the two columns', async () => {
    // Pinning the property that surprised us on production, so a future change
    // does not quietly turn these into a subtraction that does not hold.
    // `outstanding` is each line's LIVE balance, so a redeemed line reads 0 on
    // BOTH sides; the redeemed principal therefore appears in the Redeemed
    // column while having already left the Last batch figure.
    const s = await summary();
    expect(s.movement.redeemed.amount).toBeGreaterThan(0);   // there IS redeemed money on record
    const redeemedStillOutstanding = Number((await ctx.db.query<{ amt: string }>(
      `SELECT COALESCE(sum(l.outstanding_amount), 0) AS amt
         FROM redemptions r JOIN application_lines l ON l.application_id = r.application_id
        WHERE r.redemption_date > $1::date`, [s.movement.since])).rows[0]!.amt);
    // ...and none of it is still sitting in anybody's outstanding.
    expect(redeemedStillOutstanding).toBe(0);
  });
});
