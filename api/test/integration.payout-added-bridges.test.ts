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

  it('Added is only what landed AFTER the payout date', async () => {
    const s = await summary(await admin(), NEXT);
    expect(s).toBeTruthy();
    expect(s!.payout_date).toBe(PAYOUT);
    // Just the 29-Aug one. The boundary and backdated investments belong to
    // Last batch, which is the correction the owner asked for.
    expect(s!.movement.added.investments).toBe(1);
    expect(s!.movement.added.amount).toBe(900000);
    expect(s!.movement.added.customers).toBe(1);
  });

  it('money ON the payout date counts in Last batch, not Added', async () => {
    // The ₹1.26 crore that used to be in neither column. Both the boundary
    // (700000) and the backdated (300000) sit in Last batch's outstanding,
    // alongside the two originals (1000000 + 500000).
    const s = await summary(await admin(), NEXT);
    expect(s!.outstanding).toBe(2500000);
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

  it('Last batch keeps money that has since been REDEEMED', async () => {
    // The owner's ₹20 lakh. An investment redeemed after the batch falls to
    // zero outstanding, so reading it live drops money that genuinely was in
    // that period's book. It must still be counted on the last-batch side, and
    // subtracted once as Redeemed.
    const a = await admin();
    const before = (await summary(a, NEXT))!;
    const app = await invest(a, 'Redeemed Later', '9564000006', 400000, '2026-08-10');
    // Redeem it AFTER the payout date, the way Chandra R's three were.
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'maturity', 400000, 400000, '2026-09-05', 'Completed')`,
      [app, `RED-TEST-${app}`]);

    const after = (await summary(a, NEXT))!;
    // Still in the last-batch book, even though its outstanding is now zero.
    expect(after.outstanding).toBe(before.outstanding + 400000);
    expect(after.movement.redeemed.amount).toBe(before.movement.redeemed.amount + 400000);
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
