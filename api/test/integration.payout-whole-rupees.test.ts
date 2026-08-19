/**
 * Interest is paid in WHOLE RUPEES (owner-approved 2026-08-16: "there should be
 * no decimal. round off properly").
 *
 * 🔒 This is a change to the interest FIGURES, made only on the owner's explicit
 * approval after they were shown that it alters money paid to customers and TDS
 * remitted. What did NOT change is the formula: same principal, rate, days and
 * day-count denominator. Only the precision of the result moved, paise → rupees.
 *
 * The owner's rounding rule is preserved exactly, one decimal place up:
 *   gross rounds independently, TDS rounds independently, net = gross − TDS
 *   with NO further rounding ("no rounding because already in gross and tds we
 *   are rounding the figures").
 *
 * Nearest, not floor — chosen because always-down would quietly keep back about
 * ₹0.50 per investment per month across the whole book.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { roundRupee } from '../src/lib/dates.js';

let ctx: TestCtx;
let custId: number, seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  custId = (await a.post('/api/customers', { full_name: 'Rounding Cust', phone: '9000006666' })).json.id;
  // An amount and rate whose exact interest lands well inside a rupee, so the
  // rounding is doing real work rather than being a no-op.
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount: 1300000, date_money_received: '2026-07-01',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const preview = async (date = '2026-07-31') => (await (await admin()).get(`/api/payouts/preview?date=${date}`)).json;

const whole = (v: unknown) => Number.isInteger(Number(v));

describe('roundRupee', () => {
  it('rounds to the NEAREST rupee', () => {
    expect(roundRupee(1234.49)).toBe(1234);
    expect(roundRupee(1234.50)).toBe(1235);
    expect(roundRupee(1234.51)).toBe(1235);
    expect(roundRupee(1234)).toBe(1234);
  });
});

describe('every interest figure is a whole rupee', () => {
  it('gross, TDS and net all carry no paise', async () => {
    const p = await preview();
    expect((p.rows as any[]).length).toBeGreaterThan(0);
    for (const r of p.rows as any[]) {
      expect(whole(r.gross_amount)).toBe(true);
      expect(whole(r.tds_amount)).toBe(true);
      expect(whole(r.net_amount)).toBe(true);
    }
  });

  it('net is gross MINUS tds, never re-rounded', async () => {
    // The owner's rule, unchanged in shape: both inputs are already whole, so
    // the subtraction is exact. A re-rounder here would only hide a bug.
    for (const r of (await preview()).rows as any[]) {
      expect(Number(r.net_amount)).toBe(Number(r.gross_amount) - Number(r.tds_amount));
    }
  });

  it('the batch total is whole too, because every row is', async () => {
    const t = (await preview()).totals;
    expect(whole(t.gross)).toBe(true);
    expect(whole(t.tds)).toBe(true);
    expect(whole(t.net)).toBe(true);
  });

  it('the formula did not change — only its precision', async () => {
    // Recompute the row by hand from the stored terms and check it matches to
    // the rupee. If someone later "simplifies" the day count or the
    // denominator, this fails.
    const r = ((await preview()).rows as any[])[0]!;
    const line = (await ctx.db.query(
      'SELECT outstanding_amount, coupon_rate_pct FROM application_lines WHERE id = $1', [r.line_id])).rows[0]!;
    const expected = roundRupee(
      (Number(line.outstanding_amount) * Number(line.coupon_rate_pct)) / 100 * Number(r.days) / 365);
    expect(Number(r.gross_amount)).toBe(expected);
  });
});

describe('the batch comparison carries outstanding', () => {
  it('the preview reports the principal its interest was earned on', async () => {
    const t = (await preview()).totals;
    expect(Number(t.outstanding)).toBe(1300000);
  });

  it('the LAST paid batch reports its outstanding too', async () => {
    // The comparison has two sides and I had only tested one. Seed a paid batch
    // directly — the endpoint reads whatever is Paid, so this exercises the
    // real query without driving the whole approve-and-settle flow.
    const line = (await ctx.db.query(
      `SELECT l.id AS line_id, l.application_id FROM application_lines l
        WHERE l.status = 'Active' LIMIT 1`)).rows[0]!;
    const batch = (await ctx.db.query(
      `INSERT INTO payout_batches (batch_no, kind, payout_date, total_gross, total_tds, total_net, status)
       VALUES ('NEFT-TEST-0001','interest','2026-06-30', 1000, 100, 900, 'Paid') RETURNING id`)).rows[0]!;
    await ctx.db.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, batch_id)
       VALUES ($1,$2,'2026-06-30','Interest',1000,100,900,'Paid',$3)`,
      [line.line_id, line.application_id, batch.id]);

    const r = await (await admin()).get('/api/payouts/last-interest-summary');
    expect(r.status).toBe(200);
    const sum = r.json.summary;
    expect(sum.batch_no).toBe('NEFT-TEST-0001');
    // The principal behind that batch — the line's own outstanding, since this
    // row carries no principal_basis (it is not a redemption slice).
    expect(Number(sum.outstanding)).toBe(1300000);
    expect(Number(sum.net)).toBe(900);
  });

  it('outstanding is the base, so it is far larger than the interest on it', async () => {
    // A sanity check that the new row is a PRINCIPAL and not another interest
    // figure — mixing the two up is the obvious way to get this wrong.
    const t = (await preview()).totals;
    expect(Number(t.outstanding)).toBeGreaterThan(Number(t.gross) * 10);
  });
});
