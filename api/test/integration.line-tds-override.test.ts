/**
 * Per-investment TDS override (migration 047). A customer can be marked No-TDS,
 * yet a single investment — e.g. one over ₹30L, where the enrolment prompt asks
 * the creator — can carry its own TDS. computeTds already lets a per-line flag
 * win over the customer flag; this pins that the create path stores it and the
 * materialised schedule honours it, WITHOUT touching the customer's own status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, custId: number;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  // A customer the operator marked No-TDS.
  const c = await a.post('/api/customers', { full_name: 'No TDS Investor', phone: '9500000077', tds_applicable: false });
  custId = Number(c.json.id);
  await a.post(`/api/customers/${custId}/bank-accounts`, { account_number: '77770000077', ifsc: 'ICIC0001234' });
});
afterAll(async () => { await ctx.close(); });

const book = async (a: Client, amount: number, override?: boolean) => {
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-12', ...(override !== undefined ? { tds_applicable: override } : {}),
  });
  expect(app.status).toBe(201);
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
};

const scheduleTds = async (appId: number) => Number((await ctx.db.query<{ t: string }>(
  "SELECT COALESCE(sum(tds_amount),0) AS t FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest'", [appId])).rows[0]!.t);

describe('per-investment TDS override for a No-TDS customer', () => {
  it('an override investment deducts TDS even though the customer is No-TDS', async () => {
    const a = await admin();
    const appId = await book(a, 3100000, true); // > ₹30L, TDS forced on for this one
    // The line carries the override, and its schedule actually deducts TDS.
    const lineFlag = (await ctx.db.query<{ tds_applicable: boolean | null }>(
      'SELECT tds_applicable FROM application_lines WHERE application_id=$1', [appId])).rows[0]!.tds_applicable;
    expect(lineFlag).toBe(true);
    expect(await scheduleTds(appId)).toBeGreaterThan(0);
  });

  it('a normal investment for the same customer still deducts nothing (follows No-TDS)', async () => {
    const a = await admin();
    const appId = await book(a, 500000); // no override
    const lineFlag = (await ctx.db.query<{ tds_applicable: boolean | null }>(
      'SELECT tds_applicable FROM application_lines WHERE application_id=$1', [appId])).rows[0]!.tds_applicable;
    expect(lineFlag).toBeNull();               // NULL = follow the customer
    expect(await scheduleTds(appId)).toBe(0);  // customer is No-TDS → no deduction
  });

  it('leaves the customer record itself untouched (still No-TDS)', async () => {
    const still = (await ctx.db.query<{ tds_applicable: boolean }>('SELECT tds_applicable FROM customers WHERE id=$1', [custId])).rows[0]!.tds_applicable;
    expect(still).toBe(false);
  });
});
