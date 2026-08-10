/**
 * Subordinate Bonds — the separate interest run (owner spec 2026-08-10, stage 4).
 *
 * The owner chose "same calculation, kept separate" and "a completely separate
 * run". So the arithmetic is IDENTICAL to an NCD's — these tests check that by
 * computing a sub bond and an NCD on the same terms and asserting the same
 * answer — while the runs never see each other's rows.
 *
 * 🔒 Interest logic is locked. Nothing here changes how a figure is worked out;
 * the whole change is WHICH ROWS a run gathers.
 *
 * The defect this guards against is quiet and expensive: previewDue joined no
 * series, so before stage 4 a subordinate bond would have been swept into the
 * NCD interest batch and paid on the NCD NEFT file — the two products settled
 * together, with nothing on screen to show it had happened.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let custId: number, seriesId: number, schemeId: number, sobId: number;
const AMOUNT = 1200000;          // same principal for both, so the maths is comparable
const RECEIVED = '2026-07-01';
const PAYOUT = '2026-07-31';

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const scheme = (await ctx.db.query("SELECT id, coupon_rate_pct, day_count_convention FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!;
  schemeId = Number(scheme.id);
  // The sub-bond product mirrors the scheme exactly — same rate, same
  // day-count — so any difference in the answer is a difference in the ENGINE,
  // which is precisely what must not exist.
  sobId = Number((await ctx.db.query(
    `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct, payout_frequency, day_count_convention)
     VALUES ('SOB-I','Sub Bond Interest', 36, $1, 'Monthly', $2) RETURNING id`,
    [scheme.coupon_rate_pct, scheme.day_count_convention])).rows[0]!.id);

  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  custId = (await a.post('/api/customers', { full_name: 'Interest Cust', phone: '9000003333' })).json.id;

  const ncd = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount: AMOUNT, date_money_received: RECEIVED,
  });
  await approveInvestment(await as('ncd@demo.local'), ncd);
  const sob = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, product_type: 'subordinate_bond',
    sob_product_id: sobId, amount: AMOUNT, date_money_received: RECEIVED,
  });
  await approveInvestment(await as('ncd@demo.local'), sob);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const preview = async (product?: string) =>
  (await (await admin()).get(`/api/payouts/preview?date=${PAYOUT}${product ? `&product=${product}` : ''}`)).json;

describe('the two runs never see each other', () => {
  it('the NCD run contains no subordinate bond', async () => {
    const p = await preview();
    const refs = (p.rows as any[]).map((r) => String(r.application_no));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((x) => x.startsWith('SOB-'))).toBe(false);
    expect(refs.some((x) => x.startsWith('APP-'))).toBe(true);
  });

  it('the subordinate bond run contains no NCD', async () => {
    const p = await preview('subordinate_bond');
    const refs = (p.rows as any[]).map((r) => String(r.application_no));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((x) => x.startsWith('SOB-'))).toBe(true);
  });

  it('defaults to the NCD run when no product is asked for', async () => {
    // Every existing caller, bookmark and cron keeps its current meaning — and
    // gets the sub bonds excluded without having to know they exist.
    const bare = await preview();
    const explicit = await preview('ncd');
    expect(bare.count).toBe(explicit.count);
    expect(Number(bare.totals.gross)).toBe(Number(explicit.totals.gross));
  });
});

describe('the calculation is identical, not merely similar', () => {
  it('pays a subordinate bond exactly what the same NCD earns', async () => {
    // Same principal, same rate, same day-count, same dates ⇒ same gross, TDS
    // and net, to the paisa. A difference here means the engine forked.
    const ncdRow = ((await preview()).rows as any[]).find((r) => String(r.application_no).startsWith('APP-'));
    const sobRow = ((await preview('subordinate_bond')).rows as any[]).find((r) => String(r.application_no).startsWith('SOB-'));
    expect(ncdRow).toBeTruthy();
    expect(sobRow).toBeTruthy();
    expect(Number(sobRow.days)).toBe(Number(ncdRow.days));
    expect(Number(sobRow.gross_amount)).toBe(Number(ncdRow.gross_amount));
    expect(Number(sobRow.tds_amount)).toBe(Number(ncdRow.tds_amount));
    expect(Number(sobRow.net_amount)).toBe(Number(ncdRow.net_amount));
  });

  it('still honours interest starting ON the day the money arrived', async () => {
    // The owner's first-period rule, unchanged: 01-07 → 31-07 inclusive of the
    // first day is 31 days, not 30.
    const sobRow = ((await preview('subordinate_bond')).rows as any[]).find((r) => String(r.application_no).startsWith('SOB-'));
    expect(Number(sobRow.days)).toBe(31);
    expect(sobRow.from_date).toBe(RECEIVED);
  });
});

describe('separate batches', () => {
  it('a subordinate bond batch is stamped as one and holds only its own rows', async () => {
    const a = await admin();
    const r = await a.post('/api/payouts', { payout_date: PAYOUT, product_type: 'subordinate_bond' });
    expect(r.status).toBe(201);
    const batchId = r.json.batch_id;
    const b = (await ctx.db.query('SELECT product_type, kind FROM payout_batches WHERE id = $1', [batchId])).rows[0]!;
    expect(b.product_type).toBe('subordinate_bond');
    expect(b.kind).toBe('interest');

    const refs = (await ctx.db.query(
      `SELECT a.application_no FROM disbursement_schedule ds
         JOIN applications a ON a.id = ds.application_id WHERE ds.batch_id = $1`, [batchId])).rows;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((x: any) => String(x.application_no).startsWith('SOB-'))).toBe(true);
  });

  it('the NCD batch that follows still holds only NCDs', async () => {
    // Order matters: the sub-bond batch above already consumed its rows, so if
    // the two runs shared a pool this would come back empty or mixed.
    const a = await admin();
    const r = await a.post('/api/payouts', { payout_date: PAYOUT });
    expect(r.status).toBe(201);
    const refs = (await ctx.db.query(
      `SELECT a.application_no FROM disbursement_schedule ds
         JOIN applications a ON a.id = ds.application_id WHERE ds.batch_id = $1`, [r.json.batch_id])).rows;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((x: any) => String(x.application_no).startsWith('APP-'))).toBe(true);
  });

  it('an existing batch is labelled ncd, so no historical figure moves', async () => {
    const old = (await ctx.db.query("SELECT count(*)::int AS n FROM payout_batches WHERE product_type IS NULL")).rows[0]!;
    expect(Number(old.n)).toBe(0);
  });
});
