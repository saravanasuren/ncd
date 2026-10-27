/**
 * The two Outstanding figures must PARTITION this run by money-received date
 * (owner 2026-09-10: "to the last batch outstanding only add those investments
 * which landed on and before 28.8.26, investments after 28th have to come in
 * added").
 *
 * Before this they were two different tests — Last batch counted the principal
 * behind the rows in that BATCH, Added asked "did the money arrive after the
 * payout date?" — so money could satisfy neither and vanish from both columns:
 *
 *   1. money received ON the payout date. The batch was already built that
 *      afternoon, so it was not in it, and `> since` excluded it from Added.
 *      On production: four investments, ₹1.26 crore, in NEITHER column.
 *   2. anything keyed in later with a backdated money date — it can never
 *      satisfy `> since`, which is exactly what a backdated import is.
 *
 * Splitting ONE population on ONE date cannot have a gap. Both cases are
 * covered below.
 *
 * Last batch is the book AS IT STOOD then, not as it stands today — the owner
 * had ₹69,49,00,000 against our ₹69,29,00,000, and the ₹20 lakh gap was exactly
 * three investments redeemed since. outstanding_amount is read live, so a
 * redemption silently removes money that genuinely WAS in that period's book.
 * Adding back what has since been redeemed restores the historical position and
 * makes the Redeemed column do real work:
 *
 *     Last + Added − Redeemed = This
 *
 * asserted below against the live preview rather than a re-derived figure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const checker = () => as('ncd@demo.local');

const PAYOUT = '2026-08-28';
const NEXT = '2026-09-28';

/** A live investment whose money landed on `moneyDate`. */
async function invest(a: Client, name: string, phone: string, amount: number, moneyDate: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `9191${phone}`, ifsc: 'ICIC0001111' });
  const series = (await a.get('/api/series')).json.rows[0];
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount, date_money_received: moneyDate,
  });
  await approveInvestment(await checker(), create);
  return Number(create.json.id);
}

const summary = async (a: Client, date: string) =>
  (await a.get(`/api/payouts/last-interest-summary?date=${date}`)).json.summary as {
    payout_date: string; outstanding: number;
    movement: {
      added: { investments: number; customers: number; amount: number };
      this_outstanding: number; recorded_outstanding: number | null; late_entry: number;
      book: { in_run: number; cumulative: number; rolled: number; other: number };
      redeemed: { redemptions: number; customers: number; amount: number };
    };
  } | null;

/**
 * The identity the screen states (owner 2026-10-27: "make it look like the
 * previous look itself. last batch, redemption, addition, this batch"):
 *
 *   Last + Added − Redeemed = This
 *
 * It closes without bridging terms because BOTH sides are the whole book, split
 * on the money-received date: this = old money + added, last = old money +
 * redeemed. `previewDue.totals.outstanding` is NOT this figure — it is the part
 * the run earns interest on, reported separately as `book.in_run`.
 */
const bridges = (s: NonNullable<Awaited<ReturnType<typeof summary>>>) =>
  expect(s.outstanding + s.movement.added.amount - s.movement.redeemed.amount)
    .toBe(s.movement.this_outstanding);

describe('the payout comparison explains its own total', () => {
  let onBoundary = 0;

  it('sets up a paid batch, then adds money the old rule could not see', async () => {
    const a = await admin();
    // In the batch: money well before the payout date.
    await invest(a, 'Before Batch A', '9564000001', 1000000, '2026-08-01');
    await invest(a, 'Before Batch B', '9564000002', 500000, '2026-08-02');

    const batch = await a.post('/api/payouts', { payout_date: PAYOUT });
    expect(batch.status).toBe(201);
    const batchId = Number(batch.json.id ?? batch.json.batch_id);
    // Settle it, so it becomes "the last paid batch".
    await ctx.db.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [batchId]);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $2::date WHERE batch_id = $1", [batchId, PAYOUT]);

    // ON the payout date, keyed in afterwards — belongs with LAST batch under
    // the owner's rule ("on and before 28.8.26"), and used to be in neither.
    onBoundary = await invest(a, 'On The Boundary', '9564000003', 700000, PAYOUT);
    // Backdated: money BEFORE the payout date, entered now — also LAST batch.
    await invest(a, 'Backdated Entry', '9564000004', 300000, '2026-08-05');
    // Genuinely after — the only one that is Added.
    await invest(a, 'Day After', '9564000005', 900000, '2026-08-29');
  });

  it('Last batch is the book AS IT STOOD, including what was keyed in later', async () => {
    // OWNER 2026-10-27, reversing the earlier rule: "in the last batch
    // outstanding alone add - 49 lakhs as it was backdated investments" and
    // then "compute it automatically".
    //
    // The recorded snapshot is 1,500,000 — the two investments that existed
    // when the batch was cut. But the boundary entry (700,000, money ON the
    // payout date) and the backdated one (300,000, money 05-Aug) were BOTH on
    // the book by then; they merely reached the system afterwards. A figure
    // that leaves them out is not the book as it stood, it is the book as the
    // paperwork happened to look that morning.
    const s = await summary(await admin(), NEXT);
    expect(s).toBeTruthy();
    expect(s!.payout_date).toBe(PAYOUT);
    expect(s!.outstanding).toBe(2500000);
    // The snapshot itself still never moves, and the difference is named — so
    // a figure that changes can always be explained.
    expect(s!.movement.recorded_outstanding).toBe(1500000);
    expect(s!.movement.late_entry).toBe(1000000);
  });

  it('Added is ONLY money that arrived in the window', async () => {
    // Three owner rulings in sequence, now finally consistent:
    //   2026-09-10  money received on/before the payout date belongs in Last
    //               batch even when keyed in later
    //   2026-09-24  "THE OLD BATCH AMOUNT WHY IS IT CHANGING - IF THERE IS
    //               REDEMPTION OR ADDITION ?"
    //   2026-10-27  "those which was received from 29th sep to oct till date
    //               should be in the addition panal", and the last-batch figure
    //               is to absorb the backdated ones, computed automatically.
    //
    // The first and second looked irreconcilable while Last batch was a single
    // frozen number. Measuring it instead settles both: it moves ONLY when
    // money genuinely was, or ceases to be, on the book as at that date — never
    // for a redemption or a later investment.
    const s = await summary(await admin(), NEXT);
    // The genuine 29-Aug one, and nothing else.
    expect(s!.movement.added.amount).toBe(900000);
    // The boundary (700,000 ON the payout date) and the backdated one (300,000
    // on 05-Aug) are in Last batch, not here: they are not this period's new
    // business, they are book the snapshot missed.
    expect(s!.movement.late_entry).toBe(1000000);
  });

  it('bridges exactly: last + added − redeemed = this', async () => {
    // The identity the screen states. Asserted against the live preview, not a
    // re-derived figure, so the two cannot drift apart.
    const a = await admin();
    bridges((await summary(a, NEXT))!);
  });

  it('a redemption of money that WAS in the book shows as Redeemed, and Last batch still does not move', async () => {
    // The owner's ₹20 lakh, restated for a remembered figure. Redeeming an
    // investment that was in the snapshot must NOT quietly shrink the snapshot —
    // it must show up as money leaving, once.
    //
    // Redemption STATUS is deliberately not consulted: on production three
    // redemptions marked Paid still carried an outstanding balance, and four
    // marked Requested had already been counted. What has left is measured
    // against the remembered figure instead, so it is true whatever the
    // paperwork says.
    const a = await admin();
    const before = (await summary(a, NEXT))!;
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id
        WHERE c.full_name = 'Before Batch A'`)).rows[0]!.id);

    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       -- 'Paid': a real terminal status. These fixtures used 'Completed', which
       -- the app never writes and production has none of, so they were asserting
       -- against a shape that cannot occur (owner 2026-10-19 fix).
       VALUES ($2, $1, 'maturity', 1000000, 1000000, '2026-09-05', 'Paid')`,
      [app, `RED-TEST-${app}`]);

    const after = (await summary(a, NEXT))!;
    // FROZEN. This is the whole point.
    expect(after.outstanding).toBe(before.outstanding);
    // And the money that left is reported as having left.
    expect(after.movement.redeemed.amount).toBe(before.movement.redeemed.amount + 1000000);

    // The row still explains itself.
    bridges(after);
  });

  it('a Skipped row does not move an investment between the columns', async () => {
    // The split is on money date alone, so a row's payment status is irrelevant
    // to which side it lands on. Pinned because the previous rule DID depend on
    // batch membership, and this is what replaced it.
    const a = await admin();
    const before = (await summary(a, NEXT))!.movement.added.investments;
    await ctx.db.query(
      `UPDATE disbursement_schedule SET status = 'Skipped' WHERE application_id = $1`, [onBoundary]);
    const after = (await summary(a, NEXT))!.movement.added.investments;
    expect(after).toBe(before);
  });
});

/**
 * The owner's question, asked as a test (2026-09-24): "THE OLD BATCH AMOUNT WHY
 * IS IT CHANGING - IF THERE IS REDEMPTION OR ADDITION ?"
 *
 * It should not change. For anything. These are the four events that used to
 * move it, fired one after another against a single batch, asserting the same
 * remembered figure each time.
 */
describe('the old batch amount moves only when the BOOK as at that date did', () => {
  const D = '2026-11-28';
  let frozen = 0;

  it('remembers what the book was when the batch was cut', async () => {
    const a = await admin();
    await invest(a, 'Snap One', '9565000001', 1000000, '2026-11-01');
    await invest(a, 'Snap Two', '9565000002', 2000000, '2026-11-02');
    const batch = await a.post('/api/payouts', { payout_date: D });
    const id = Number(batch.json.id ?? batch.json.batch_id);
    await ctx.db.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [id]);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $2::date WHERE batch_id = $1", [id, D]);

    // Written down at creation, not derived from anything live. The absolute
    // figure depends on what else this file has already put on the book, so what
    // is asserted is that it was stored at all — and then, in every test below,
    // that it never moves. That is the property the owner asked for.
    const stored = (await ctx.db.query<{ o: string }>(
      'SELECT outstanding_at_payout AS o FROM payout_batches WHERE id = $1', [id])).rows[0]!.o;
    expect(stored).not.toBeNull();
    frozen = Number(stored);
    expect(frozen).toBeGreaterThan(0);
    // The two investments above are in it.
    expect(frozen).toBeGreaterThanOrEqual(3000000);
    // And it is what the screen reads.
    expect((await summary(a, D))!.outstanding).toBe(frozen);
  });

  it('a NEW investment does not move it', async () => {
    const a = await admin();
    const before = (await summary(a, '2026-12-28'))!.outstanding;
    await invest(a, 'After The Batch', '9565000003', 5000000, '2026-12-01');
    expect((await summary(a, '2026-12-28'))!.outstanding).toBe(before);
  });

  it('a BACKDATED investment DOES move it — and that is the point', async () => {
    // THE ONE CASE THAT REVERSED (owner 2026-10-27). Money dated inside the
    // batch's period, keyed in afterwards: it WAS on the book that day, so the
    // book as it stood that day includes it. The owner found ₹49,00,000 of
    // exactly this by eye and asked for it to be computed from then on.
    //
    // The recorded snapshot still does not move — only the measured figure
    // does, and the difference is reported as `late_entry`, so a number that
    // changes can always be accounted for.
    const a = await admin();
    const before = (await summary(a, '2026-12-28'))!;
    await invest(a, 'Backdated After', '9565000004', 700000, '2026-11-03');
    const after = (await summary(a, '2026-12-28'))!;
    expect(after.outstanding).toBe(before.outstanding + 700000);
    expect(after.movement.recorded_outstanding).toBe(frozen);
    expect(after.movement.late_entry).toBe(before.movement.late_entry + 700000);
  });

  it('a REDEMPTION does not move it', async () => {
    const a = await admin();
    const before = (await summary(a, '2026-12-28'))!.outstanding;
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id WHERE c.full_name = 'Snap Two'`)).rows[0]!.id);
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'maturity', 2000000, 2000000, '2026-12-05', 'Paid')`, [app, `RED-SNAP-${app}`]);
    // Out of old money, into Redeemed — the two move together and the sum is
    // untouched. This is the 2026-09-24 complaint, and it stays fixed.
    expect((await summary(a, '2026-12-28'))!.outstanding).toBe(before);
  });

  it('a redemption NOT YET settled does not move it either — the ₹20 lakh case', async () => {
    // Four redemptions raised on the morning of 2026-09-24 were still carrying
    // their full outstanding. The old code added their principal back while the
    // live figure still held it, counting ₹20,00,000 twice.
    const a = await admin();
    const before = (await summary(a, '2026-12-28'))!.outstanding;
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id WHERE c.full_name = 'Snap One'`)).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'premature', 1000000, 1000000, '2026-12-06', 'Requested')`, [app, `RED-PEND-${app}`]);
    // Principal deliberately still on the book, exactly as it was in production.
    const s = (await summary(a, '2026-12-28'))!;
    // Unchanged: the money has not left old-money outstanding, and an
    // unapproved redemption is not counted as having taken it.
    expect(s.outstanding).toBe(before);
    // And it is NOT reported as having left, because it has not.
    bridges(s);
  });
});

/**
 * Redeemed must be the REDEMPTIONS (owner 2026-09-25: "there was never 1 cr
 * redemption at all. why is it showong like this").
 *
 * It briefly read ₹1,71,00,000 against ₹40,00,000 of real redemptions, because
 * it was derived as "snapshot − what that book is worth now", with money keyed
 * in later subtracted back out. The 28-08 snapshot had been BACKFILLED with a
 * figure measured four weeks after the batch, so investments keyed in between
 * were already inside it — and counting them again as late arrivals pushed
 * exactly that much into Redeemed.
 *
 * The lesson is in the shape, not the arithmetic: a figure whose as-at moment
 * is unknown cannot be used to infer a second figure. So Redeemed is measured
 * and Added carries the remainder.
 */
describe('Redeemed says what was redeemed', () => {
  const D = '2027-03-28';
  let frozen = 0;

  it('a batch whose snapshot was taken LATER still reports redemptions honestly', async () => {
    const a = await admin();
    await invest(a, 'Honest One', '9566000001', 1000000, '2027-02-01');
    await invest(a, 'Honest Two', '9566000002', 1000000, '2027-02-02');
    const batch = await a.post('/api/payouts', { payout_date: '2027-02-28' });
    const id = Number(batch.json.id ?? batch.json.batch_id);
    await ctx.db.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [id]);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = '2027-02-28'::date WHERE batch_id = $1", [id]);

    // Keyed in AFTER the batch, money dated before it — the shape that was
    // being double-counted.
    await invest(a, 'Keyed Later', '9566000003', 3000000, '2027-02-10');

    // Now restate the snapshot the way the 28-08 one was backfilled: measured
    // LATE, so it already contains the investment above.
    const live = Number((await ctx.db.query(
      `SELECT COALESCE(sum(l.outstanding_amount),0) AS a FROM applications a
         JOIN application_lines l ON l.application_id = a.id
        WHERE a.date_money_received <= '2027-02-28'::date`)).rows[0]!.a);
    await ctx.db.query('UPDATE payout_batches SET outstanding_at_payout = $1 WHERE id = $2', [live, id]);
    frozen = live;

    // Redeem ONE investment, for a known amount.
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id WHERE c.full_name = 'Honest One'`)).rows[0]!.id);
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'maturity', 1000000, 1000000, '2027-03-05', 'Paid')`, [app, `RED-HON-${app}`]);

    const s = (await summary(a, D))!;
    // THE POINT: one redemption of ₹10,00,000, reported as ₹10,00,000 — not
    // inflated by the ₹30,00,000 that was keyed in late.
    expect(s.movement.redeemed.amount).toBe(1000000);
    expect(s.outstanding).toBe(frozen);
  });

  it('and the row still adds up', async () => {
    const a = await admin();
    const s = (await summary(a, D))!;
    bridges(s);
  });
});

/**
 * ADDED IS MONEY RECEIVED, NOT MONEY THIS RUN PAYS INTEREST ON
 * (owner 2026-10-27: "those which was received from 29th sep to oct till date
 * should be in the addoition panal").
 *
 * Added used to be measured only over investments IN THE INTEREST RUN, so two
 * kinds of perfectly real money were invisible in the month they arrived:
 *
 *   1. a Cumulative / at-maturity product. It pays nothing monthly, so #486
 *      correctly keeps it out of the run — but ₹44,00,000 of October money
 *      disappeared from Added with it.
 *   2. money received on or after `interest.next_batch_from_day`, which rolls
 *      to NEXT month's batch and so is not in this run either — ₹15,00,000.
 *
 * Both now count on the day the money arrived, and the part of Added this run
 * does not carry is broken out underneath the four columns, so the Outstanding
 * row still explains itself.
 */
describe('Added counts money the interest run never sees', () => {
  const P = '2027-04-28';
  const D = '2027-05-28';

  it('counts a cumulative product and money that rolled to next month', async () => {
    const a = await admin();
    // On the book before the batch, so it lands in the frozen snapshot.
    await invest(a, 'Run Before', '9567000001', 1000000, '2027-04-05');
    const batch = await a.post('/api/payouts', { payout_date: P });
    const id = Number(batch.json.id ?? batch.json.batch_id);
    await ctx.db.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [id]);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $2::date WHERE batch_id = $1", [id, P]);

    // (a) an ordinary monthly investment — in the run.
    await invest(a, 'Plain Monthly', '9567000002', 500000, '2027-05-01');
    // (b) a cumulative one — real money, but it earns nothing monthly, so the
    //     run excludes it. Set on the line directly: what matters here is the
    //     frequency previewDue filters on, not how it got there.
    const cum = await invest(a, 'Cumulative One', '9567000003', 400000, '2027-05-02');
    await ctx.db.query("UPDATE application_lines SET payout_frequency = 'Cumulative' WHERE application_id = $1", [cum]);
    // (c) money on the 26th — rolls to the NEXT batch under the cut-off rule.
    await invest(a, 'Rolled Late', '9567000004', 300000, '2027-05-26');

    const s = (await summary(a, D))!;
    expect(s.payout_date).toBe(P);
    // ALL THREE count as money received, whatever this run does with them.
    expect(s.movement.added.amount).toBe(1200000);
    expect(s.movement.added.investments).toBe(3);
    expect(s.movement.added.customers).toBe(3);
    // ...and the breakdown says WHICH of it this run pays nothing on — the
    // separate line the owner asked for (2026-10-27: "show those doublung
    // scheme in a seperate line in that panel as interest in not paid to them.
    // so we will ahve a better clarity on the figures").
    expect(s.movement.book.cumulative).toBe(400000);   // earns into maturity
    expect(s.movement.book.rolled).toBe(300000);       // paid next month
    // The parts account for the whole book, with nothing unexplained.
    const b = s.movement.book;
    expect(b.in_run + b.cumulative + b.rolled + b.other).toBe(s.movement.this_outstanding);

    // And the row still explains itself end to end.
    bridges(s);
  });

  it('does not count an investment still awaiting approval', async () => {
    // PendingApproval is money nobody has confirmed. It must not inflate the
    // month — ₹15,00,000 was sitting in that state on production on 27-10.
    const a = await admin();
    const before = (await summary(a, D))!.movement.added.amount;
    const cust = await a.post('/api/customers', { full_name: 'Not Yet Approved', phone: '9567000005' });
    const cid = Number(cust.json.id);
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '91919567000005', ifsc: 'ICIC0001111' });
    const series = (await a.get('/api/series')).json.rows[0];
    const scheme = (await a.get('/api/schemes')).json.rows[0];
    // Created, NOT approved.
    await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid,
      series_id: series.id, scheme_id: scheme.id, amount: 800000, date_money_received: '2027-05-10',
    });
    expect((await summary(a, D))!.movement.added.amount).toBe(before);
  });
});
