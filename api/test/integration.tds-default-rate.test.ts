/**
 * TDS default rate for schemeless lines (owner 2026-07-27): "TDS applicable
 * means 10% flat, no different schemes as of now." Every pre-NCD-27 legacy
 * investment has no scheme_id (found on 519 of 681 active lines in
 * production) — computeTds's rule lookup is scheme-based, so without a
 * fallback these lines silently paid 0% TDS regardless of the customer's
 * flag. DEFAULT_TDS_RULE (10%) closes that gap in previewDue, materialize,
 * and the redemption broken-interest calc.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const asNcd = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' }); return c; };

/** Every real investment is created through a scheme (the enrolment API
 * requires one) — a NULL scheme_id only ever happens on legacy/migrated
 * lines. Simulate that shape directly, the same way it actually looks in
 * production, rather than only testing the scheme-linked path. */
async function makeSchemelessLine(amount: number, phone: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Legacy Schemeless Investor', phone });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `70${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount,
    date_money_received: '2026-07-01', collection_method: 'NEFT', collection_reference: `UTR-${phone}`,
  });
  const appId = Number(app.json.id);
  const ncd = await asNcd();
  await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`); // go live, materialises normally

  // Now strip the scheme_id, matching a legacy line's real shape.
  await ctx.db.query('UPDATE application_lines SET scheme_id = NULL WHERE application_id = $1', [appId]);
  return { appId, customerId: Number(cust.json.id) };
}

describe('TDS default rate applies even when the line has no scheme', () => {
  it('the live payout preview deducts 10%, not 0%', async () => {
    const { appId } = await makeSchemelessLine(1000000, '9700055501');
    const a = await admin();
    const p = await a.get('/api/payouts/preview?date=2026-07-11');
    const row = (p.json.rows as any[]).find((r) => Number(r.application_id) === appId);
    expect(row, 'accrual row for the schemeless line').toBeTruthy();
    // Precision 0 = within half a rupee. TDS is rounded to a whole rupee since
    // 2026-08-16 (owner-approved), so 10% of ₹3,616 is deducted as ₹362 rather
    // than ₹361.60. The point of this test — that the DEFAULT 10% applies to a
    // line with no scheme, instead of 0% — is unaffected.
    expect(Number(row.tds_amount)).toBeCloseTo(Number(row.gross_amount) * 0.1, 0);
    expect(Number.isInteger(Number(row.tds_amount))).toBe(true);
    expect(Number(row.tds_amount)).toBeGreaterThan(0);
  });

  it('materialising a fresh schemeless line also snapshots 10% TDS onto its schedule rows', async () => {
    const { appId } = await makeSchemelessLine(500000, '9700055502');
    const rows = (await ctx.db.query(
      `SELECT gross_amount, tds_amount FROM disbursement_schedule
        WHERE application_id = $1 AND due_type IN ('Interest','BrokenInterest') AND gross_amount > 0`,
      [appId])).rows as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Within half a rupee — TDS on the materialised schedule is rounded to a
      // whole rupee too, so the projection is in the same units it will be paid.
      expect(Number(r.tds_amount)).toBeCloseTo(Number(r.gross_amount) * 0.1, 0);
      expect(Number.isInteger(Number(r.tds_amount))).toBe(true);
    }
  });

  it('a customer explicitly NOT tds_applicable still pays 0%, scheme or no scheme', async () => {
    const { appId, customerId } = await makeSchemelessLine(500000, '9700055503');
    await ctx.db.query('UPDATE customers SET tds_applicable = FALSE WHERE id = $1', [customerId]);
    const a = await admin();
    const p = await a.get('/api/payouts/preview?date=2026-07-11');
    const row = (p.json.rows as any[]).find((r) => Number(r.application_id) === appId);
    expect(row, 'accrual row').toBeTruthy();
    expect(Number(row.tds_amount)).toBe(0);
  });

  it('a premature redemption on a schemeless line also deducts 10% on its broken-interest slice', async () => {
    const { appId } = await makeSchemelessLine(500000, '9700055504');
    const ncd = await asNcd();
    const init = await ncd.post('/api/redemptions/premature', { application_id: appId, redemption_date: '2026-07-15', reason: 'Customer request' });
    expect(init.status).toBe(201);
    const row = (await ctx.db.query(
      `SELECT gross_amount, tds_amount FROM disbursement_schedule
        WHERE application_id = $1 AND due_type = 'BrokenInterest' AND gross_amount > 0
        ORDER BY id DESC LIMIT 1`, [appId])).rows[0] as any;
    expect(row, 'broken-interest row from the redemption').toBeTruthy();
    // Precision 0 = within half a rupee. TDS is rounded to a whole rupee since
    // 2026-08-16 (owner-approved), so 10% of ₹3,616 is deducted as ₹362 rather
    // than ₹361.60. The point of this test — that the DEFAULT 10% applies to a
    // line with no scheme, instead of 0% — is unaffected.
    expect(Number(row.tds_amount)).toBeCloseTo(Number(row.gross_amount) * 0.1, 0);
    expect(Number.isInteger(Number(row.tds_amount))).toBe(true);
    expect(Number(row.tds_amount)).toBeGreaterThan(0);
  });
});
