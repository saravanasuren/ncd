/**
 * Subordinate Bonds — the data model (owner spec 2026-08-10, stage 1).
 *
 * A subordinate bond is a customer investment that is NOT an NCD. The owner
 * confirmed it shares the SAME approval gate, TDS rules, ₹30L threshold,
 * maturity and premature handling, incentive matrix and interest calculation —
 * so it lives in `applications` rather than a parallel table. What it does NOT
 * share is a series.
 *
 * The CHECK constraint is the entire guarantee that the two shapes cannot blur
 * into each other, so it is what these tests are mostly about. Everything
 * downstream — series totals, allotments, the separate payout run — depends on
 * "no subordinate bond is ever in a series" being true in the database and not
 * merely in the code that happens to write it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let customerId: number, seriesId: number, sobProductId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  customerId = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
     VALUES ('SOB001','Sub Bond Cust','9000000777','Approved',TRUE) RETURNING id`)).rows[0]!.id);
  sobProductId = Number((await ctx.db.query(
    `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct)
     VALUES ('SOB-A','Subordinate Bond A', 36, 12.5) RETURNING id`)).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

/** Insert an application directly, returning the DB error message if refused. */
async function tryInsert(no: string, cols: Record<string, unknown>): Promise<string | null> {
  const keys = Object.keys(cols);
  const ph = keys.map((_, i) => `$${i + 3}`).join(',');
  try {
    await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, ${keys.join(',')}, total_amount)
       VALUES ($1,$2,${ph},100000)`,
      [no, customerId, ...keys.map((k) => cols[k])]);
    return null;
  } catch (e) { return (e as Error).message; }
}

describe('subordinate bond — shape constraint', () => {
  it('accepts an NCD: has a series, no sub-bond product', async () => {
    expect(await tryInsert('APP-SOB-1', { series_id: seriesId, product_type: 'ncd' })).toBeNull();
  });

  it('accepts a subordinate bond: has a product, NO series', async () => {
    expect(await tryInsert('SOB-T-1', { series_id: null, product_type: 'subordinate_bond', sob_product_id: sobProductId })).toBeNull();
  });

  it('REFUSES a subordinate bond sitting inside a series', async () => {
    // The owner's first requirement: "It must not be included in any NCD
    // series." Enforced by the database, not merely by the code that writes it,
    // because every series total and allotment depends on it being true.
    const err = await tryInsert('SOB-T-2', { series_id: seriesId, product_type: 'subordinate_bond', sob_product_id: sobProductId });
    expect(err).toMatch(/chk_app_product_shape/);
  });

  it('REFUSES a subordinate bond with no product to price it', async () => {
    // With no series there is no scheme, so the product is the only source of
    // rate, tenure and day-count. Without it the investment cannot be priced.
    const err = await tryInsert('SOB-T-3', { series_id: null, product_type: 'subordinate_bond' });
    expect(err).toMatch(/chk_app_product_shape/);
  });

  it('REFUSES an NCD with no series', async () => {
    // Making series_id nullable must not quietly let an NCD lose its series —
    // it would vanish from every series-based report.
    const err = await tryInsert('APP-SOB-2', { series_id: null, product_type: 'ncd' });
    expect(err).toMatch(/chk_app_product_shape/);
  });

  it('REFUSES an NCD carrying a sub-bond product', async () => {
    const err = await tryInsert('APP-SOB-3', { series_id: seriesId, product_type: 'ncd', sob_product_id: sobProductId });
    expect(err).toMatch(/chk_app_product_shape/);
  });

  it('defaults an existing-style insert to ncd, so nothing already written changes meaning', async () => {
    await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, total_amount)
       VALUES ('APP-SOB-4',$1,$2,100000)`, [customerId, seriesId]);
    const r = await ctx.db.query("SELECT product_type FROM applications WHERE application_no = 'APP-SOB-4'");
    expect(r.rows[0]!.product_type).toBe('ncd');
  });
});

// NOTE the path: productsRouter is mounted at `/api`, NOT `/api/products`, so
// these live at /api/sob-products. Two comments already in the web code warn
// about this same trap for /api/banks.
describe('subordinate bond product master', () => {
  it('lists, creates and updates through the API', async () => {
    const a = await admin();
    const created = await a.post('/api/sob-products', {
      code: 'SOB-B', name: 'Subordinate Bond B', tenure_months: 24, coupon_rate_pct: 11,
    });
    expect(created.status).toBe(201);
    const list = await a.get('/api/sob-products');
    const row = (list.json.rows as any[]).find((r) => r.code === 'SOB-B');
    expect(row).toBeTruthy();
    expect(Number(row.coupon_rate_pct)).toBe(11);
    expect(row.payout_frequency).toBe('Monthly');
    // No ticket rule: the owner confirmed sub bonds have NO ₹1,00,000 unit
    // requirement, so the master must not carry one to enforce.
    expect(row.min_ticket).toBeUndefined();

    const upd = await a.put(`/api/sob-products/${row.id}`, { coupon_rate_pct: 11.5, is_active: false });
    expect(upd.status).toBe(200);
    const after = ((await a.get('/api/sob-products')).json.rows as any[]).find((r) => r.code === 'SOB-B');
    expect(Number(after.coupon_rate_pct)).toBe(11.5);
    expect(after.is_active).toBe(false);
  });

  it('refuses a duplicate code, a zero rate and a nonsense tenure', async () => {
    const a = await admin();
    expect((await a.post('/api/sob-products', { code: 'SOB-A', name: 'dup', tenure_months: 12, coupon_rate_pct: 10 })).status).toBe(409);
    // A zero-rate bond pays nothing — far likelier a slip than an intention,
    // and it would generate a schedule of ₹0 payouts.
    expect((await a.post('/api/sob-products', { code: 'SOB-Z', name: 'zero', tenure_months: 12, coupon_rate_pct: 0 })).status).toBe(400);
    expect((await a.post('/api/sob-products', { code: 'SOB-Y', name: 'bad tenure', tenure_months: 0, coupon_rate_pct: 10 })).status).toBe(400);
  });

  it('needs products:manage to write, but not to read', async () => {
    const staff = new Client(ctx.base);
    await staff.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    // Enrolment has to list the products, so reading is open to any signed-in user.
    expect((await staff.get('/api/sob-products')).status).toBe(200);
    expect((await staff.post('/api/sob-products', { code: 'SOB-X', name: 'x', tenure_months: 12, coupon_rate_pct: 10 })).status).toBe(403);
  });
});
