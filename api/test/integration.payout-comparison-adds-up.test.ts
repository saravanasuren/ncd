/**
 * The comparison panel's Outstanding chain must close on the number the SCREEN
 * prints, not on one only the service can see.
 *
 * Reported from the floor on 2026-10-27: Last ₹74,71,00,000 + Added
 * ₹5,80,00,000 − Redeemed ₹57,00,000 came to ₹79,94,00,000 against a "This
 * batch" of ₹79,52,00,000, and the downloaded sheet said ₹5,38,00,000 where
 * the screen said ₹5,80,00,000 — the same ₹42,00,000, twice. Most of that is
 * by design (Added counts money received; This batch counts what the run earns
 * on) and is bridged by `not_in_run` / `backdated`.
 *
 * What was NOT by design: the split behind the identity was keyed on the run's
 * APPLICATIONS, so it summed every line those applications own — including
 * lines the run does not pay on. "This batch" on screen is previewDue's
 * `totals.outstanding`, which is per LINE. An investment holding one monthly
 * line and one at-maturity line therefore reconciled against principal the
 * batch never earned a rupee against, and the panel could not add up no matter
 * how carefully it was read.
 *
 * #486 made exactly that shape reachable by excluding Cumulative / at-maturity
 * lines from the run, so this pins it.
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

async function invest(a: Client, name: string, phone: string, amount: number, moneyDate: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
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
    outstanding: number;
    movement: {
      added: { amount: number };
      redeemed: { amount: number }; this_outstanding: number;
      recorded_outstanding: number | null; late_entry: number;
      book: { in_run: number; cumulative: number; rolled: number; other: number };
    };
  } | null;

const previewOutstanding = async (a: Client, date: string) =>
  Number((await a.get(`/api/payouts/preview?date=${date}`)).json.totals.outstanding);

describe('the Outstanding chain lands on the printed total', () => {
  it('sets up a paid batch and an investment the run only partly carries', async () => {
    const a = await admin();
    await invest(a, 'Monthly Only', '9566000001', 1000000, '2026-08-01');

    const batch = await a.post('/api/payouts', { payout_date: PAYOUT });
    expect(batch.status).toBe(201);
    const batchId = Number(batch.json.id ?? batch.json.batch_id);
    await ctx.db.query("UPDATE payout_batches SET status = 'Paid' WHERE id = $1", [batchId]);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $2::date WHERE batch_id = $1", [batchId, PAYOUT]);

    // Money in after the batch, on an application that ALSO carries an
    // at-maturity line — the #486 shape. The second line is written directly:
    // what matters is that one application owns a line the run pays on and a
    // line it does not.
    const mixed = await invest(a, 'Mixed Lines', '9566000002', 900000, '2026-08-29');
    const src = (await ctx.db.query<{ scheme_id: string; day_count_convention: string; coupon_rate_pct: string; tenure_months: number }>(
      `SELECT scheme_id, day_count_convention, coupon_rate_pct, tenure_months
         FROM application_lines WHERE application_id = $1 LIMIT 1`, [mixed])).rows[0]!;
    await ctx.db.query(
      `INSERT INTO application_lines
         (application_id, scheme_id, amount, outstanding_amount, coupon_rate_pct,
          tenure_months, payout_frequency, day_count_convention, status)
       VALUES ($1, $2, $3, $3, $4, $5, 'Cumulative', $6, 'Active')`,
      [mixed, src.scheme_id, 400000, src.coupon_rate_pct, src.tenure_months, src.day_count_convention]);
  });

  it('the Cumulative line is not in the run — #486', async () => {
    const a = await admin();
    const rows = (await a.get(`/api/payouts/preview?date=${NEXT}`)).json.rows as Array<Record<string, unknown>>;
    const freqs = new Set(rows.map((r) => String(r.payout_frequency ?? '')).filter(Boolean));
    expect(freqs.has('Cumulative')).toBe(false);
  });

  // THE FOUR-COLUMN IDENTITY (owner 2026-10-27: "make it look like the previous
  // look itself. last batch, redemption, addition, this batch").
  //
  // #490 needed two extra bridging terms because Added counted money RECEIVED
  // while This batch counted only what the run EARNS INTEREST ON. That is fixed
  // at the source: both sides are the whole book now, so the plain row closes.
  it('Last + Added − Redeemed = This batch, with no bridging terms', async () => {
    const a = await admin();
    const s = (await summary(a, NEXT))!;
    expect(s.outstanding + s.movement.added.amount - s.movement.redeemed.amount)
      .toBe(s.movement.this_outstanding);
  });

  it('This batch is the whole book, and its parts say which is which', async () => {
    const a = await admin();
    const s = (await summary(a, NEXT))!;
    const printed = await previewOutstanding(a, NEXT);
    const b = s.movement.book;

    // The part the run actually earns on IS the screen's printed total — the
    // two figures are different on purpose and must each be what they claim.
    expect(b.in_run).toBe(printed);
    // The Cumulative line is on the book and in no interest run: ₹4,00,000.
    expect(b.cumulative).toBe(400000);
    // And the named parts account for the whole thing, with nothing left over.
    expect(b.in_run + b.cumulative + b.rolled + b.other).toBe(s.movement.this_outstanding);
    expect(s.movement.this_outstanding).toBeGreaterThan(printed);
  });

  // The ₹49,00,000 the owner spotted by eye, generalised: a snapshot taken when
  // the batch was cut permanently misses anything that was on the book then but
  // reached the system later, so Last batch is MEASURED instead of read off it.
  it('Last batch includes money that was on the book then but keyed in later', async () => {
    const a = await admin();
    const before = (await summary(a, NEXT))!;
    // Backdated to BEFORE the last batch, entered now.
    await invest(a, 'Keyed In Late', '9566000003', 700000, '2026-08-10');
    const after = (await summary(a, NEXT))!;

    expect(after.outstanding).toBe(before.outstanding + 700000);
    // The recorded snapshot itself never moves — only the measured figure does,
    // and the difference is reported so a moving number can be explained.
    expect(after.movement.recorded_outstanding).toBe(before.movement.recorded_outstanding);
    expect(after.movement.late_entry).toBe(before.movement.late_entry + 700000);
    // Still balances.
    expect(after.outstanding + after.movement.added.amount - after.movement.redeemed.amount)
      .toBe(after.movement.this_outstanding);
  });

  // The 2026-09-24 complaint — "THE OLD BATCH AMOUNT WHY IS IT CHANGING - IF
  // THERE IS REDEMPTION OR ADDITION ?" — must stay fixed under the new formula.
  it('a redemption of old money does NOT move Last batch', async () => {
    const a = await admin();
    const before = (await summary(a, NEXT))!;
    const app = Number((await ctx.db.query(
      `SELECT a.id FROM applications a JOIN customers c ON c.id = a.customer_id
        WHERE c.full_name = 'Monthly Only'`)).rows[0]!.id);
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 0, status = 'Redeemed' WHERE application_id = $1", [app]);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [app]);
    await ctx.db.query(
      `INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status)
       VALUES ($2, $1, 'maturity', 1000000, 1000000, '2026-09-05', 'Paid')`,
      [app, `RED-CMP-${app}`]);

    const after = (await summary(a, NEXT))!;
    // Out of old money, into Redeemed — the sum is untouched.
    expect(after.outstanding).toBe(before.outstanding);
    expect(after.movement.redeemed.amount).toBe(before.movement.redeemed.amount + 1000000);
    expect(after.outstanding + after.movement.added.amount - after.movement.redeemed.amount)
      .toBe(after.movement.this_outstanding);
  });
});
