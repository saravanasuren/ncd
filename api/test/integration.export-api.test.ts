/**
 * Read-only export surface `/api/integration/export/v1/*` — the API that
 * replaces the SharePoint dump for Notwo. Contract tests pin the hard rules:
 * GET-only, key-gated, exact field allowlists (no column leak), `id` + FK ids,
 * full PAN, and keyset pagination.
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

const F = {
  customer: ['id', 'customer_code', 'full_name', 'dob', 'age', 'phone', 'address', 'tds_status', 'total_invested', 'total_all_time', 'total_redeemed', 'investment_count', 'pan', 'kyc_status', 'is_active', 'updated_at'].sort(),
  investment: ['id', 'customer_id', 'series_id', 'application_no', 'customer_code', 'customer', 'series_code', 'status', 'channel', 'source', 'amount', 'date_money_received', 'allotment_date', 'maturity_date', 'redemption_date', 'coupon_rate_pct', 'tenure_months', 'payout_frequency', 'staff_code', 'staff_name', 'agent_code', 'agent_name', 'referred_by', 'updated_at'].sort(),
  series: ['id', 'series_code', 'status', 'investors', 'issued', 'redeemed', 'outstanding'].sort(),
  staff: ['id', 'staff_code', 'full_name', 'role', 'active'].sort(),
  agent: ['id', 'agent_code', 'full_name', 'commission_pct', 'active'].sort(),
  incentive: ['id', 'investment_id', 'application_no', 'payee_type', 'payee_id', 'payee_code', 'payee_name', 'incentive_amount', 'paid', 'paid_amount', 'accrual_date'].sort(),
  interest: ['investment_id', 'application_no', 'due_date', 'customer_code', 'customer', 'series_code', 'due_type', 'gross_amount', 'tds_amount', 'net_amount', 'status', 'paid_at', 'utr'].sort(),
  cheque: ['id', 'lockerhub_application_id', 'customer_id', 'customer_code', 'amount', 'cheque_no', 'bank_name', 'received_on', 'status', 'cleared_on', 'lockerhub_settled_at', 'updated_at'].sort(),
};

describe('export API — the contract', () => {
  it('the router registers GET routes ONLY (no write-back path exists)', () => {
    const methods = (exportRouter as any).stack.filter((l: any) => l.route).flatMap((l: any) => Object.keys(l.route.methods));
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m: string) => m === 'get')).toBe(true);
  });

  it('rejects a missing or wrong integration key', async () => {
    expect((await exp('/customers', null)).status).toBe(401);
    expect((await exp('/customers', 'nope')).status).toBe(401);
  });

  it('manifest gives per-resource { max_updated_at, count }', async () => {
    const r = await exp('/manifest');
    expect(r.status).toBe(200);
    expect(r.json.api_version).toBe(1);
    for (const f of ['customers', 'investments', 'series', 'redemptions', 'staff', 'agents', 'incentives', 'interest', 'locker-cheques']) {
      expect(r.json.resources[f], `resources.${f}`).toBeTruthy();
      expect(r.json.resources[f]).toHaveProperty('count');
      expect(r.json.resources[f]).toHaveProperty('max_updated_at');
    }
    expect(typeof r.json.resources.customers.max_updated_at).toBe('string'); // has updated_at
    expect(r.json.resources.series.max_updated_at).toBeNull();               // full-snapshot
  });

  it('customers: exact allowlist, id, FULL pan, updated_at', async () => {
    const r = await exp('/customers');
    const row = r.json.data.find((c: any) => c.id === custId);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(F.customer);
    expect(row.pan).toBe('EXPRT1234C');
    expect(typeof row.updated_at).toBe('string');
  });

  it('investments: id + customer_id + series_id FKs', async () => {
    const r = await exp('/investments');
    const row = r.json.data.find((x: any) => x.id === appId);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(F.investment);
    expect(row.customer_id).toBe(custId);
    expect(row.series_id).toBe(seriesId);
    expect(row.status).toBe('Active');
  });

  it('series/staff: exact allowlist + numeric id', async () => {
    const s = await exp('/series');
    const srow = s.json.data.find((x: any) => x.series_code === 'NCD DEMO');
    expect(Object.keys(srow).sort()).toEqual(F.series);
    expect(typeof srow.id).toBe('number');
    const st = await exp('/staff');
    expect(st.json.data.length).toBeGreaterThan(0);
    expect(Object.keys(st.json.data[0]).sort()).toEqual(F.staff);
  });

  it('agents/redemptions/incentives: allowlist when rows exist', async () => {
    const ag = await exp('/agents');
    if (ag.json.data.length) expect(Object.keys(ag.json.data[0]).sort()).toEqual(F.agent);
    const red = await exp('/redemptions');
    expect(Array.isArray(red.json.data)).toBe(true);
    const inc = await exp('/incentives');
    if (inc.json.data.length) expect(Object.keys(inc.json.data[0]).sort()).toEqual(F.incentive);
  });

  it('interest: drill-down by application_no, investment_id FK, 13-field rows', async () => {
    const r = await exp(`/interest?application_no=${encodeURIComponent(appNo)}`);
    expect(r.json.data.length).toBeGreaterThan(0);
    expect(Object.keys(r.json.data[0]).sort()).toEqual(F.interest);
    expect(r.json.data.every((x: any) => x.application_no === appNo && x.investment_id === appId)).toBe(true);
  });

  it('summary: headline figures', async () => {
    const r = await exp('/summary');
    for (const f of ['outstanding_book', 'interest_accrued', 'customers', 'investments', 'series']) {
      expect(r.json.data).toHaveProperty(f);
    }
  });

  it('lockers: rent-only feed, envelope + roster_complete flag; NO deposit fields', async () => {
    const r = await exp('/lockers');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(true);
    expect(r.json).toHaveProperty('roster_complete');
    for (const row of r.json.data) {
      for (const banned of ['deposit_amount', 'pledged_amount', 'ncd_backed']) expect(row).not.toHaveProperty(banned);
    }
  });

  it('locker-cheques: envelope + allowlist when rows exist', async () => {
    const r = await exp('/locker-cheques');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(true);
    if (r.json.data.length) expect(Object.keys(r.json.data[0]).sort()).toEqual(F.cheque);
  });

  it('keyset pagination caps the page and yields a cursor', async () => {
    const r = await exp('/customers?limit=1');
    expect(r.json.data.length).toBeLessThanOrEqual(1);
    expect(r.json.next_cursor === null || typeof r.json.next_cursor === 'number').toBe(true);
  });

  // The bug Notwo hit: manifest used raw count(*) while the list uses a filtered
  // report fn, so the two disagreed (585 vs 441) and the reconcile flagged a
  // false gap. They must be equal for every resource.
  it('manifest count equals each list endpoint total (reconcile invariant)', async () => {
    const man = (await exp('/manifest')).json.resources;
    for (const r of ['customers', 'investments', 'series', 'redemptions', 'staff', 'agents', 'incentives', 'locker-cheques']) {
      const list = await exp(`/${r}?limit=2000`);
      expect(list.json.next_cursor, `${r} fits one page in the test book`).toBeNull();
      expect(man[r].count, `manifest.${r}.count must equal /${r} row count`).toBe(list.json.data.length);
    }
  });
});
