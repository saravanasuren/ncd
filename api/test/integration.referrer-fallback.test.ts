/**
 * The accrual engine reads the referrer the same way everything else does
 * (owner 2026-09-07: "geetha s was enrolled by rithiesh but referred by nambi
 * ... why is it showing under rithiesh name").
 *
 * applications/service.ts has defined the canonical rule for a long time:
 *   COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)
 * Scoping, visibility and every report use it. The accrual engine alone read
 * the application's own column, so an investment whose referrer sat on the
 * CUSTOMER but not on the investment paid the wrong people:
 *
 *   - the referrer earned nothing at all
 *   - the enroller was paid the full NO-referrer rate instead of the reduced
 *     with-referrer one
 *
 * Geetha.S on production: referred by agent NAMBI, blank on the investment,
 * ₹70,00,000 paid Rithiesh L staff_new at 2% (₹1,40,000) and NAMBI nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const checker = () => as('ncd@demo.local');

const accrualsOf = async (appId: number) =>
  (await ctx.db.query<Record<string, unknown>>(
    `SELECT payee_type, payee_id, matrix_cell, amount FROM incentive_accruals
      WHERE application_id = $1 ORDER BY id`, [appId])).rows;

/** An investment whose referrer is on the CUSTOMER, and blank on the investment. */
async function investRefOnCustomerOnly(name: string, phone: string, referrer: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, referred_by_text: referrer });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `5151${phone}`, ifsc: 'ICIC0001111' });
  const series = (await a.get('/api/series')).json.rows[0];
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount: 500000, date_money_received: '2026-08-10',
  });
  const appId = Number(create.json.id);
  // Exactly the production shape: the investment carries no referrer of its own.
  await ctx.db.query(`UPDATE applications SET referred_by_text = NULL WHERE id = $1`, [appId]);
  await approveInvestment(await checker(), create);
  return appId;
}

describe('the referrer falls back to the customer', () => {
  it('pays the REFERRER even when only the customer names them', async () => {
    const agent = (await ctx.db.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM agents WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0]!;
    const appId = await investRefOnCustomerOnly('Ref On Customer', '9538000001', agent.full_name);

    const rows = await accrualsOf(appId);
    const referrerRow = rows.find((r) => r.matrix_cell === 'referrer');
    // Before the fix this row did not exist at all — the referrer earned nothing.
    expect(referrerRow).toBeTruthy();
    expect(referrerRow!.payee_type).toBe('agent');
    expect(Number(referrerRow!.payee_id)).toBe(Number(agent.id));
    expect(Number(referrerRow!.amount)).toBeGreaterThan(0);
  });

  it('...and the enroller is NOT paid the full no-referrer rate', async () => {
    const rows = await accrualsOf(
      await investRefOnCustomerOnly('Ref Rate Check', '9538000002',
        (await ctx.db.query<{ full_name: string }>(`SELECT full_name FROM agents WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0]!.full_name));
    const staffRow = rows.find((r) => String(r.matrix_cell ?? '').startsWith('staff'));
    // The with-referrer cell, not staff_new_no_referrer. Whether it pays
    // anything at all is the matrix's business; what matters is that the engine
    // KNEW there was a referrer.
    if (staffRow) expect(String(staffRow.matrix_cell)).not.toBe('staff_new');
  });

  it('an investment with its OWN referrer is unchanged — the app value still wins', async () => {
    const a = await admin();
    const agent = (await ctx.db.query<{ full_name: string }>(
      `SELECT full_name FROM agents WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0]!;
    const cust = await a.post('/api/customers', { full_name: 'Own Ref', phone: '9538000003', referred_by_text: agent.full_name });
    const cid = Number(cust.json.id);
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '51519538000003', ifsc: 'ICIC0001111' });
    const series = (await a.get('/api/series')).json.rows[0];
    const scheme = (await a.get('/api/schemes')).json.rows[0];
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid,
      series_id: series.id, scheme_id: scheme.id, amount: 500000, date_money_received: '2026-08-10',
    });
    await approveInvestment(await checker(), create);
    const rows = await accrualsOf(Number(create.json.id));
    expect(rows.find((r) => r.matrix_cell === 'referrer')).toBeTruthy();
  });

  it('no referrer anywhere still means no referrer accrual', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'No Ref At All', phone: '9538000004' });
    const cid = Number(cust.json.id);
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '51519538000004', ifsc: 'ICIC0001111' });
    const series = (await a.get('/api/series')).json.rows[0];
    const scheme = (await a.get('/api/schemes')).json.rows[0];
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid,
      series_id: series.id, scheme_id: scheme.id, amount: 500000, date_money_received: '2026-08-10',
    });
    await approveInvestment(await checker(), create);
    const rows = await accrualsOf(Number(create.json.id));
    // The fallback must not invent a referrer where there is none.
    expect(rows.find((r) => r.matrix_cell === 'referrer')).toBeFalsy();
  });
});
