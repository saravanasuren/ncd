/**
 * Added / Redeemed on the "vs last paid batch" comparison (owner 2026-08-27):
 * "get me the current month addition and redemption data in a separate column
 * in between last batch and this batch."
 *
 * ─── THE COLUMNS NOW BRIDGE. Reversed 2026-09-10, on the owner's data ────────
 *
 * This file used to pin the OPPOSITE — a test called "NOT a bridge between the
 * two columns", written because a redemption reads 0 in `outstanding` on both
 * sides, so subtracting it again double-counted.
 *
 * The owner found the flaw in that reasoning by checking the screen against
 * their own book, twice. First: money received ON the payout date, and money
 * keyed in later with a backdated date, appeared in NEITHER Last batch nor
 * Added — ₹1.31 crore missing from both. Then: our corrected Last batch was
 * still ₹20 lakh under theirs, because three investments redeemed since had
 * silently fallen out of a figure read LIVE, even though they genuinely were
 * in that period's book.
 *
 * Fixing the second makes the first reasoning obsolete. Last batch is now the
 * book AS IT STOOD then — live outstanding plus what has since been redeemed —
 * so the redeemed principal IS on the last-batch side, and subtracting it once
 * is correct rather than double-counting:
 *
 *     Last + Added − Redeemed = This
 *
 * Verified on production: 69,49,00,000 + 2,90,00,000 − 20,00,000 =
 * 72,19,00,000, residual zero. The last test here pins the identity, where it
 * used to pin its absence.
 *
 * ─── WHAT THE COLUMNS MEASURE ───────────────────────────────────────────────
 *
 * The BOOK, not raw application rows. An investment reaches these figures once
 * it is Active and accruing — which is why every fixture below approves its
 * investments, where the old date-only query counted them from creation. That
 * is deliberate: "This batch" has always counted the book, and a comparison
 * whose two sides count different populations is the bug being fixed.
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

    // Before the cut-off — belongs to LAST batch, must NOT be in Added.
    const before = await a.post('/api/customers', { full_name: 'Before Cutoff', phone: '9704000001' });
    const beforeApp = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: before.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-06-15' });
    await approveInvestment(await as('ncd@demo.local'), beforeApp);

    const base = await summary();
    expect(base.movement.since).toBe('2026-06-30');

    // After the cut-off — must be counted.
    const after = await a.post('/api/customers', { full_name: 'After Cutoff', phone: '9704000002' });
    const afterApp = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: after.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 300000, date_money_received: '2026-07-10' });
    await approveInvestment(await as('ncd@demo.local'), afterApp);

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
      const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
        customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
        amount: amt, date_money_received: '2026-07-11' });
      await approveInvestment(await as('ncd@demo.local'), app);
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
    await approveInvestment(await as('ncd@demo.local'), app);
    const base = await summary();
    await ctx.db.query("UPDATE applications SET status = 'Withdrawn' WHERE id = $1", [app.json.id]);
    const now = await summary();
    expect(now.movement.added.investments).toBe(base.movement.added.investments - 1);
    expect(Number(now.movement.added.amount)).toBe(Number(base.movement.added.amount) - 900000);
  });

  it('a redemption raised after the batch shows in Redeemed, valued at the principal returned', async () => {
    const a = await admin();
    // Money that landed BEFORE the batch date, so it was part of that period's
    // book — which is what Redeemed now means: what has LEFT the last batch.
    // An investment that arrives and is redeemed inside the same period was
    // never in the last batch and is not reported here; it nets to zero across
    // the row, so the bridge still holds.
    const cust = await a.post('/api/customers', { full_name: 'Redeemer', phone: '9704000005' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 400000, date_money_received: '2026-06-20' });
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

  it('counts interest settled OUTSIDE the batch for that same date', async () => {
    /**
     * Owner 2026-09-10: "the payments were given in backend — changing the
     * outstanding alone will not make sense, we need to change the interest
     * also accordingly."
     *
     * An investment keyed in after the batch was built still earned that
     * period's interest and was paid it by hand. Its principal already counts
     * on the last-batch side, so ignoring its interest described half a
     * customer. On production this was five investments and ₹5,292.
     */
    const a = await admin();
    const s0 = await summary();
    const cust = await a.post('/api/customers', { full_name: 'Paid In Backend', phone: '9704000007' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 800000, date_money_received: '2026-06-20' });
    await approveInvestment(await as('ncd@demo.local'), app);
    // Settled by hand for the batch's own date, with NO batch_id — exactly the
    // shape a backend payment leaves behind.
    await ctx.db.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type,
          gross_amount, tds_amount, net_amount, status, paid_at)
       SELECT l.id, l.application_id, $2::date, 'Interest', 1000, 100, 900, 'Paid', $2::date
         FROM application_lines l WHERE l.application_id = $1`,
      [app.json.id, s0.movement.since]);

    const s1 = await summary();
    expect(Number(s1.gross)).toBe(Number(s0.gross) + 1000);
    expect(Number(s1.tds)).toBe(Number(s0.tds) + 100);
    expect(Number(s1.net)).toBe(Number(s0.net) + 900);
    expect(s1.investments).toBe(s0.investments + 1);
  });

  it('does NOT drop what the batch paid under a different due date', async () => {
    /**
     * The trap in the obvious implementation. Switching the aggregate from
     * `batch_id = X` to `due_date = payout_date` picks up the backend payments
     * — and silently loses the redemption slices the batch also settled, whose
     * own due_date is their redemption date, not the payout date. Measured on
     * production before changing it: ₹41,234 of real interest would have
     * vanished from the figure.
     *
     * So the rule is a UNION, and this pins it.
     */
    const a = await admin();
    const s0 = await summary();
    const batchId = (await ctx.db.query<{ id: string }>(
      `SELECT id FROM payout_batches WHERE status = 'Paid' AND kind = 'interest'
        ORDER BY payout_date DESC, id DESC LIMIT 1`)).rows[0]!.id;
    const cust = await a.post('/api/customers', { full_name: 'Slice In Batch', phone: '9704000008' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 600000, date_money_received: '2026-06-21' });
    await approveInvestment(await as('ncd@demo.local'), app);
    // In the batch, but due on a DIFFERENT date — a redemption slice's shape.
    await ctx.db.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type,
          gross_amount, tds_amount, net_amount, status, paid_at, batch_id, principal_basis)
       SELECT l.id, l.application_id, ($2::date + 3), 'BrokenInterest', 500, 0, 500, 'Paid', $2::date, $3, 600000
         FROM application_lines l WHERE l.application_id = $1`,
      [app.json.id, s0.movement.since, batchId]);

    const s1 = await summary();
    // Still counted, because it is in the batch — a date-only rule would miss it.
    expect(Number(s1.gross)).toBe(Number(s0.gross) + 500);
    // ...and a redemption slice never inflates the customer/investment counts.
    expect(s1.investments).toBe(s0.investments);
  });

  // The redeemed add-back itself is asserted before/after in
  // integration.payout-added-bridges ("Last batch keeps money that has since
  // been REDEEMED") — measuring the change rather than re-deriving the
  // population here, which is what a first attempt at it got wrong.
  it('Last + Added − Redeemed = This batch, exactly', async () => {
    // The identity the screen now states, asserted against the LIVE preview
    // rather than a re-derived figure, so the two cannot drift apart.
    //
    // This replaces a test that pinned the opposite. It was not wrong about the
    // old data — it was right that the columns did not bridge — but the reason
    // was a defect, not a law: Last batch was reading each line's balance TODAY
    // and so had already lost money that was genuinely in that period's book.
    const a = await admin();
    const s = await summary();
    const preview = (await a.get('/api/payouts/preview?date=' + new Date().toISOString().slice(0, 10))).json;
    expect(Number(s.movement.redeemed.amount)).toBeGreaterThan(0);   // the row is doing real work
    expect(Number(s.outstanding) + Number(s.movement.added.amount) - Number(s.movement.redeemed.amount))
      .toBe(Number(preview.totals.outstanding));
  });

});
