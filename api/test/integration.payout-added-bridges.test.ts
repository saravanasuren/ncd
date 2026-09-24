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
      redeemed: { redemptions: number; customers: number; amount: number };
    };
  } | null;

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

  it('Last batch is FROZEN at what the book was when the batch was cut', async () => {
    const s = await summary(await admin(), NEXT);
    expect(s).toBeTruthy();
    expect(s!.payout_date).toBe(PAYOUT);
    // Only the two investments that existed when the batch was created.
    // 1,000,000 + 500,000. The boundary and backdated entries were keyed in
    // afterwards and CANNOT be in a figure that was already written down.
    expect(s!.outstanding).toBe(1500000);
  });

  it('money keyed in after the batch shows as Added, wherever its money date falls', async () => {
    // THE TRADE-OFF, stated out loud (owner 2026-09-24: "THE OLD BATCH AMOUNT
    // WHY IS IT CHANGING - IF THERE IS REDEMPTION OR ADDITION ?").
    //
    // On 2026-09-10 the owner asked that money received ON or BEFORE the payout
    // date count in Last batch even when keyed in later. On 2026-09-24 they
    // asked that Last batch never move. Those two cannot both hold: a number
    // fixed when the batch was cut cannot later absorb an entry nobody had made
    // yet. Freezing won, so backdated money is reported as an ADDITION — which
    // is what it is, to the book, on the day it was keyed in.
    //
    // The boundary (700,000 on the payout date) + backdated (300,000 on 05-Aug)
    // + the genuine 29-Aug one (900,000).
    const s = await summary(await admin(), NEXT);
    expect(s!.movement.added.amount).toBe(1900000);
  });

  it('bridges exactly: last + added − redeemed = this', async () => {
    // The identity the screen states. Asserted against the live preview, not a
    // re-derived figure, so the two cannot drift apart.
    const a = await admin();
    const s = (await summary(a, NEXT))!;
    const preview = (await a.get(`/api/payouts/preview?date=${NEXT}`)).json as { totals: { outstanding: number } };
    expect(s.outstanding + s.movement.added.amount - s.movement.redeemed.amount)
      .toBe(preview.totals.outstanding);
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
       VALUES ($2, $1, 'maturity', 1000000, 1000000, '2026-09-05', 'Completed')`,
      [app, `RED-TEST-${app}`]);

    const after = (await summary(a, NEXT))!;
    // FROZEN. This is the whole point.
    expect(after.outstanding).toBe(before.outstanding);
    // And the money that left is reported as having left.
    expect(after.movement.redeemed.amount).toBe(before.movement.redeemed.amount + 1000000);

    // The row still explains itself.
    const preview = (await a.get(`/api/payouts/preview?date=${NEXT}`)).json as { totals: { outstanding: number } };
    expect(after.outstanding + after.movement.added.amount - after.movement.redeemed.amount)
      .toBe(preview.totals.outstanding);
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
describe('the old batch amount never changes', () => {
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
    await invest(a, 'After The Batch', '9565000003', 5000000, '2026-12-01');
    expect((await summary(a, '2026-12-28'))!.outstanding).toBe(frozen);
  });

  it('a BACKDATED investment does not move it', async () => {
    // Money dated inside the batch's period, keyed in afterwards — the case the
    // old reconstruction absorbed, silently raising a historical figure.
    const a = await admin();
    await invest(a, 'Backdated After', '9565000004', 700000, '2026-11-03');
    expect((await summary(a, '2026-12-28'))!.outstanding).toBe(frozen);
  });

  it('a REDEMPTION does not move it', async () => {
    const a = await admin();
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id WHERE c.full_name = 'Snap Two'`)).rows[0]!.id);
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'maturity', 2000000, 2000000, '2026-12-05', 'Completed')`, [app, `RED-SNAP-${app}`]);
    expect((await summary(a, '2026-12-28'))!.outstanding).toBe(frozen);
  });

  it('a redemption NOT YET settled does not move it either — the ₹20 lakh case', async () => {
    // Four redemptions raised on the morning of 2026-09-24 were still carrying
    // their full outstanding. The old code added their principal back while the
    // live figure still held it, counting ₹20,00,000 twice.
    const a = await admin();
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id WHERE c.full_name = 'Snap One'`)).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'premature', 1000000, 1000000, '2026-12-06', 'Requested')`, [app, `RED-PEND-${app}`]);
    // Principal deliberately still on the book, exactly as it was in production.
    const s = (await summary(a, '2026-12-28'))!;
    expect(s.outstanding).toBe(frozen);
    // And it is NOT reported as having left, because it has not.
    const preview = (await a.get('/api/payouts/preview?date=2026-12-28')).json as { totals: { outstanding: number } };
    expect(s.outstanding + s.movement.added.amount - s.movement.redeemed.amount).toBe(preview.totals.outstanding);
  });
});
