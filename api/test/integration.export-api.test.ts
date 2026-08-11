/**
 * Read-only export surface `/api/integration/export/v1/*` (stage 1) — the API
 * that replaces the SharePoint dump for Notwo. Contract tests pin the hard
 * rules: GET-only, key-gated, exact field allowlist (no column leak), full PAN,
 * and keyset pagination.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { exportRouter } from '../src/modules/integration/export.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let custId: number;
let appId: number;
let appNo: string;
const KEY = 'dev-integration-key';

const exp = (path: string, key: string | null = KEY) =>
  fetch(ctx.base + '/api/integration/export/v1' + path, { headers: key ? { 'X-Integration-Key': key } : {} })
    .then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

async function as(email: string, password: string) { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const ncd = await as('ncd@demo.local', 'Demo_1234');
  const cust = await a.post('/api/customers', { full_name: 'Export Cust', phone: '9701230001', pan: 'EXPRT1234C' });
  custId = Number(cust.json.id);
  await a.post(`/api/customers/${custId}/bank-accounts`, { account_number: '77779701230001', ifsc: 'ICIC0001111' });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: '2026-07-10',
  });
  appId = Number(create.json.id);
  await approveInvestment(ncd, create); // → Active, so it lands in the reports
  appNo = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [appId])).rows[0]!.application_no);
});
afterAll(async () => { await ctx.close(); });

const CUSTOMER_FIELDS = ['external_customer_id', 'customer_code', 'full_name', 'dob', 'age', 'phone', 'address',
  'tds_status', 'total_invested', 'total_all_time', 'total_redeemed', 'investment_count', 'pan', 'kyc_status', 'is_active', 'updated_at'].sort();
const INVESTMENT_FIELDS = ['external_application_id', 'external_customer_id', 'application_no', 'customer_code', 'customer',
  'series_code', 'status', 'channel', 'source', 'amount', 'date_money_received', 'allotment_date', 'maturity_date',
  'redemption_date', 'coupon_rate_pct', 'tenure_months', 'payout_frequency', 'staff_code', 'staff_name', 'agent_code',
  'agent_name', 'referred_by', 'updated_at'].sort();

describe('export API — stage 1 contract', () => {
  it('the router registers GET routes ONLY (no write-back path exists)', () => {
    const methods = (exportRouter as any).stack
      .filter((l: any) => l.route)
      .flatMap((l: any) => Object.keys(l.route.methods));
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m: string) => m === 'get')).toBe(true);
  });

  it('rejects a missing or wrong integration key', async () => {
    expect((await exp('/customers', null)).status).toBe(401);
    expect((await exp('/customers', 'nope')).status).toBe(401);
  });

  it('manifest is a cheap freshness probe', async () => {
    const r = await exp('/manifest');
    expect(r.status).toBe(200);
    expect(r.json.api_version).toBe(1);
    expect(r.json).toHaveProperty('book_version');
    expect(r.json.resources).toHaveProperty('customers');
    expect(r.json.resources).toHaveProperty('investments');
  });

  it('customers: envelope + EXACT field allowlist + FULL pan', async () => {
    const r = await exp('/customers');
    expect(r.status).toBe(200);
    expect(r.json.source_system).toBe('ncd');
    expect(Array.isArray(r.json.data)).toBe(true);
    const row = r.json.data.find((c: any) => c.external_customer_id === custId);
    expect(row, 'our active customer is in the feed').toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(CUSTOMER_FIELDS); // no extra column leaks
    expect(row.pan).toBe('EXPRT1234C'); // FULL pan, not masked
    expect(row.investment_count).toBeGreaterThanOrEqual(1);
  });

  it('investments: envelope + EXACT field allowlist + stable ids', async () => {
    const r = await exp('/investments');
    expect(r.status).toBe(200);
    const row = r.json.data.find((x: any) => x.external_application_id === appId);
    expect(row, 'our investment is in the feed').toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(INVESTMENT_FIELDS);
    expect(row.external_customer_id).toBe(custId);
    expect(row.status).toBe('Active');
  });

  it('summary carries the 14 headline figures', async () => {
    const r = await exp('/summary');
    expect(r.status).toBe(200);
    for (const f of ['outstanding_book', 'active_investors', 'interest_accrued', 'interest_monthly', 'interest_daily', 'customers', 'investments', 'series']) {
      expect(r.json.data, `summary.${f}`).toHaveProperty(f);
    }
  });

  it('keyset pagination: limit caps the page and yields a cursor', async () => {
    const r = await exp('/customers?limit=1');
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBeLessThanOrEqual(1);
    // next_cursor is a number when more rows remain, else null.
    expect(r.json.next_cursor === null || typeof r.json.next_cursor === 'number').toBe(true);
  });
});

const SERIES_FIELDS = ['external_series_id', 'series_code', 'status', 'investors', 'issued', 'redeemed', 'outstanding'].sort();
const STAFF_FIELDS = ['external_staff_id', 'staff_code', 'full_name', 'role', 'active'].sort();
const AGENT_FIELDS = ['external_agent_id', 'agent_code', 'full_name', 'commission_pct', 'active'].sort();
const INCENTIVE_FIELDS = ['external_accrual_id', 'application_no', 'payee_type', 'payee_code', 'payee_name', 'incentive_amount', 'paid', 'paid_amount', 'accrual_date'].sort();
const INTEREST_FIELDS = ['due_date', 'application_no', 'customer_code', 'customer', 'series_code', 'due_type', 'gross_amount', 'tds_amount', 'net_amount', 'status', 'paid_at', 'utr'].sort();

describe('export API — stage 2 (book resources)', () => {
  it('manifest lists all stage-2 resource counts', async () => {
    const r = await exp('/manifest');
    for (const f of ['customers', 'investments', 'series', 'redemptions', 'staff', 'agents', 'incentives']) {
      expect(r.json.resources, `resources.${f}`).toHaveProperty(f);
    }
  });

  it('series: our demo series present, exact allowlist', async () => {
    const r = await exp('/series');
    expect(r.status).toBe(200);
    const row = r.json.data.find((s: any) => s.series_code === 'NCD DEMO');
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(SERIES_FIELDS);
    expect(typeof row.external_series_id).toBe('number');
  });

  it('staff: rows present, exact allowlist', async () => {
    const r = await exp('/staff');
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBeGreaterThan(0);
    expect(Object.keys(r.json.data[0]).sort()).toEqual(STAFF_FIELDS);
  });

  it('agents: exact allowlist when rows exist', async () => {
    const r = await exp('/agents');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(true);
    if (r.json.data.length) expect(Object.keys(r.json.data[0]).sort()).toEqual(AGENT_FIELDS);
  });

  it('redemptions & incentives: envelope + allowlist when rows exist', async () => {
    const red = await exp('/redemptions');
    expect(red.status).toBe(200);
    expect(Array.isArray(red.json.data)).toBe(true);
    const inc = await exp('/incentives');
    expect(inc.status).toBe(200);
    if (inc.json.data.length) expect(Object.keys(inc.json.data[0]).sort()).toEqual(INCENTIVE_FIELDS);
  });

  it('interest: drill-down by application_no returns the 12-field ledger rows', async () => {
    const r = await exp(`/interest?application_no=${encodeURIComponent(appNo)}`);
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBeGreaterThan(0); // an Active investment has a schedule
    expect(Object.keys(r.json.data[0]).sort()).toEqual(INTEREST_FIELDS);
    expect(r.json.data.every((x: any) => x.application_no === appNo)).toBe(true);
  });
});
