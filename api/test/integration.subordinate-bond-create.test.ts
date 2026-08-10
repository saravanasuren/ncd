/**
 * Subordinate Bonds — recording one, end to end (owner spec 2026-08-10, stage 2).
 *
 * Same approval gate as an NCD, its own SOB- number, priced from its product
 * master, and NO whole-₹1,00,000 unit rule.
 *
 * That last one is the trap this file mostly exists for. `ticketRule()` FALLS
 * BACK to ₹1L min / ₹1L multiple when the scheme is null — and a subordinate
 * bond line has no scheme — so without an explicit exemption a ₹60,000 sub bond
 * would sail through create and then be refused at approval by a rule that does
 * not apply to it. That failure would appear only at the checker's desk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let custId: number, seriesId: number, schemeId: number, sobId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  sobId = Number((await ctx.db.query(
    `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct, payout_frequency, day_count_convention)
     VALUES ('SOB-M','Sub Bond Monthly', 36, 13.25, 'Monthly', 'Actual365') RETURNING id`)).rows[0]!.id);
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  custId = (await a.post('/api/customers', { full_name: 'SOB Investor', phone: '9000000888' })).json.id;
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const sob = (amount: number, over: Record<string, unknown> = {}) => ({
  ...requiredInvestmentFields(),
  customer_id: custId, product_type: 'subordinate_bond', sob_product_id: sobId,
  amount, date_money_received: '2026-08-01', ...over,
});

describe('creating a subordinate bond', () => {
  it('is numbered SOB-, carries no series, and is priced from its product', async () => {
    const r = await (await admin()).post('/api/applications', sob(500000));
    expect(r.status).toBe(201);
    expect(String(r.json.application_no)).toMatch(/^SOB-\d{4}-\d{6}$/);

    const row = (await ctx.db.query(
      'SELECT product_type, series_id, sob_product_id, status FROM applications WHERE id = $1', [r.json.id])).rows[0]!;
    expect(row.product_type).toBe('subordinate_bond');
    expect(row.series_id).toBeNull();
    expect(Number(row.sob_product_id)).toBe(sobId);
    // Same gate as an NCD — the owner confirmed approval behaviour is identical.
    expect(row.status).toBe('PendingApproval');

    // Rate/tenure are SNAPSHOT onto the line from the product, so a later edit
    // to the product never rewrites a live investment.
    const line = (await ctx.db.query(
      'SELECT scheme_id, coupon_rate_pct, tenure_months, day_count_convention FROM application_lines WHERE application_id = $1', [r.json.id])).rows[0]!;
    expect(line.scheme_id).toBeNull();
    expect(Number(line.coupon_rate_pct)).toBe(13.25);
    expect(Number(line.tenure_months)).toBe(36);
  });

  it('runs on its OWN counter, not the APP- one', async () => {
    const a = await admin();
    const s1 = await a.post('/api/applications', sob(200000));
    const ncd = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-08-01',
    });
    const s2 = await a.post('/api/applications', sob(300000));
    expect(String(ncd.json.application_no)).toMatch(/^APP-/);
    const n = (x: any) => Number(String(x.json.application_no).split('-')[2]);
    // The NCD in between must not have consumed a number from the SOB sequence.
    expect(n(s2)).toBe(n(s1) + 1);
  });

  it('ACCEPTS an amount that is not a whole ₹1,00,000 unit, and approves it', async () => {
    // The heart of stage 2. ₹60,000 is a complete subordinate bond.
    const a = await admin();
    const r = await a.post('/api/applications', sob(60000));
    expect(r.status).toBe(201);

    const reqId = r.json.subscription_request.id;
    const approved = await (await as('ncd@demo.local')).post(`/api/approvals/${reqId}/approve`, {});
    // Without the exemption this is a 400 from the NCD ticket rule, and the
    // failure only ever shows up at the checker's desk.
    expect(approved.status).toBe(200);
    expect(approved.json.request.status).toBe('Approved');
  });

  it('still refuses an NCD that is not a whole unit, at approval', async () => {
    // The exemption must be narrow: exempting sub bonds must not quietly
    // exempt everything by widening the condition.
    const a = await admin();
    // ₹1,50,000 — above the minimum, so this exercises the MULTIPLE rule
    // rather than the floor, which is the half a sub bond is exempt from.
    const r = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
      amount: 150000, date_money_received: '2026-08-01',
    });
    const res = await (await as('ncd@demo.local')).post(`/api/approvals/${r.json.subscription_request.id}/approve`, {});
    expect(res.status).toBe(400);
    expect(String(res.json.error.message)).toMatch(/units of/i);
  });

  it('refuses a subordinate bond with no product, and an NCD with no series', async () => {
    const a = await admin();
    const noProduct = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, product_type: 'subordinate_bond',
      amount: 100000, date_money_received: '2026-08-01',
    });
    expect(noProduct.status).toBe(400);
    const noSeries = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, amount: 100000, date_money_received: '2026-08-01',
    });
    expect(noSeries.status).toBe(400);
  });

  it('refuses a retired product for new money', async () => {
    const dead = Number((await ctx.db.query(
      `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct, is_active)
       VALUES ('SOB-DEAD','Retired', 12, 10, FALSE) RETURNING id`)).rows[0]!.id);
    const r = await (await admin()).post('/api/applications', sob(100000, { sob_product_id: dead }));
    expect(r.status).toBe(400);
    expect(String(r.json.error.message)).toMatch(/no longer active/i);
  });

  it('refuses clubbing rather than inventing what it would mean', async () => {
    // Clubbing exists to gather part payments up to a whole unit, and sub bonds
    // have no unit rule — so the owner has never specified what clubbing one
    // should do. Refused loudly instead of guessed at.
    const a = await admin();
    const first = await a.post('/api/applications', sob(100000));
    const r = await a.post('/api/applications', sob(50000, { club_with_application_id: first.json.id }));
    expect(r.status).toBe(400);
    expect(String(r.json.error.message)).toMatch(/cannot be clubbed/i);
  });

  it('is never listed as a part payment on the Outstanding worklist', async () => {
    const a = await admin();
    await a.post('/api/applications', sob(70000));
    const rows = (await a.get('/api/reports/outstanding')).json.rows as any[];
    const sobRows = rows.filter((x) => String(x.reference).startsWith('SOB-'));
    expect(sobRows.length).toBeGreaterThan(0);
    // "Needs ₹30,000 more to make a whole unit" is wrong advice for a product
    // with no unit rule — they belong under awaiting-approval instead.
    expect(sobRows.every((x) => x.kind === 'awaiting_approval')).toBe(true);
  });
});
