/**
 * Subordinate Bonds — reporting separation (owner spec 2026-08-10, stage 3).
 *
 * Two rules pull in opposite directions and both have to hold at once:
 *
 *   "It should not affect NCD series totals, counts, allotments, or reports."
 *   "[Outstanding book] include them but also an other seperate tile also."
 *
 * So a subordinate bond must be INSIDE the Outstanding Book figure and OUTSIDE
 * every series-shaped number, simultaneously. These tests pin both directions,
 * because a change that fixes one by breaking the other looks correct from
 * whichever screen you happen to be on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let custId: number, seriesId: number, schemeId: number, sobId: number;
const NCD_AMOUNT = 500000;
const SOB_AMOUNT = 260000;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  sobId = Number((await ctx.db.query(
    `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct)
     VALUES ('SOB-R','Sub Bond Reporting', 36, 13) RETURNING id`)).rows[0]!.id);

  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  custId = (await a.post('/api/customers', { full_name: 'Reporting Cust', phone: '9000001111' })).json.id;

  // One live NCD and one live subordinate bond, both approved, so every figure
  // below is comparing like with like.
  const ncd = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount: NCD_AMOUNT, date_money_received: '2026-08-01',
  });
  await approveInvestment(await as('ncd@demo.local'), ncd);
  const sob = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, product_type: 'subordinate_bond',
    sob_product_id: sobId, amount: SOB_AMOUNT, date_money_received: '2026-08-01',
  });
  await approveInvestment(await as('ncd@demo.local'), sob);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const overview = async () => (await (await admin()).get('/api/dashboard/overview')).json;

describe('subordinate bonds in the dashboard', () => {
  it('are INCLUDED in the Outstanding Book, per the owner', async () => {
    const d = await overview();
    expect(Number(d.kpis.outstanding_book)).toBe(NCD_AMOUNT + SOB_AMOUNT);
  });

  it('also report separately, with their own total', async () => {
    const d = await overview();
    expect(Number(d.subordinate_bonds.outstanding)).toBe(SOB_AMOUNT);
    expect(Number(d.subordinate_bonds.investments)).toBe(1);
    expect(Number(d.subordinate_bonds.investors)).toBe(1);
  });

  it('the two tiles OVERLAP — the separate one is not additional money', async () => {
    // Stated outright because the screen says so too. If someone later "fixes"
    // Outstanding Book to exclude them, this fails and explains why.
    const d = await overview();
    expect(Number(d.kpis.outstanding_book)).toBeGreaterThan(Number(d.subordinate_bonds.outstanding));
    expect(Number(d.kpis.outstanding_book) - Number(d.subordinate_bonds.outstanding)).toBe(NCD_AMOUNT);
  });
});

describe('subordinate bonds are absent from every series-shaped number', () => {
  it('do not appear in the series summary', async () => {
    const d = await overview();
    const total = (d.series as any[]).reduce((s, r) => s + Number(r.outstanding), 0);
    // The series pie must total the NCD book only — a sub bond has no series to
    // belong to, and must not be silently attributed to one.
    expect(total).toBe(NCD_AMOUNT);
    expect((d.series as any[]).every((r) => Number(r.investments) === 1)).toBe(true);
  });

  it('do not inflate the active series tile', async () => {
    const d = await overview();
    if (d.active_series) {
      expect(Number(d.active_series.outstanding)).toBe(NCD_AMOUNT);
      expect(Number(d.active_series.investments)).toBe(1);
    }
  });

  it('do not appear in the NCD book export', async () => {
    const rows = (await (await admin()).get('/api/reports/segments/series')).json;
    const flat = JSON.stringify(rows);
    expect(flat).not.toMatch(/SOB-\d{4}-\d{6}/);
  });

  it('are not offered for allotment', async () => {
    // Allotment is a series operation. A bond with no series must never appear
    // in a batch, or it would be allotted into an NCD series by the back door.
    const pending = (await ctx.db.query(
      `SELECT count(*)::int AS n FROM applications
        WHERE product_type = 'subordinate_bond' AND series_id IS NOT NULL`)).rows[0]!;
    expect(Number(pending.n)).toBe(0);
  });
});

describe('the separate tile drill-down', () => {
  it('lists the bond with its product and rate, not a series', async () => {
    const r = await (await admin()).get('/api/dashboard/drill/subordinate-bonds');
    expect(r.status).toBe(200);
    const rows = r.json.rows as any[];
    expect(rows.length).toBe(1);
    expect(String(rows[0].application_no)).toMatch(/^SOB-/);
    expect(rows[0].product_code).toBe('SOB-R');
    // From the LINE snapshot, so editing the product later cannot rewrite it.
    expect(Number(rows[0].coupon_rate_pct)).toBe(13);
    expect(Number(rows[0].outstanding)).toBe(SOB_AMOUNT);
  });

  it('totals to exactly what the tile shows', async () => {
    // The list and the number must come from the same place — a second query
    // that could disagree is how a dashboard loses trust.
    const d = await overview();
    const rows = (await (await admin()).get('/api/dashboard/drill/subordinate-bonds')).json.rows as any[];
    const sum = rows.reduce((s, x) => s + Number(x.outstanding), 0);
    expect(sum).toBe(Number(d.subordinate_bonds.outstanding));
  });
});
