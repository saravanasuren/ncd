/**
 * Gap D — search, dashboard drill, audit, system, report PDFs/exports,
 * funded-subscription integration, backdated importer. PGlite HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, customerId: number, appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await build();
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function build() {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Searchable Investor', phone: '9400000001', email: 's@ex.com' });
  customerId = cust.json.id; // live on creation — no approval step
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${customerId}/bank-accounts`, { account_number: '44440001111', ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12' });
  appId = app.json.id;
  await a.post(`/api/applications/${appId}/mark-esigned`);
  await approveInvestment(ncd, app);
}

describe('universal search + drill', () => {
  it('finds a customer by name (scoped)', async () => {
    const a = await admin();
    const r = await a.get('/api/dashboard/search?q=Searchable');
    expect(r.status).toBe(200);
    expect(r.json.customers.some((c: any) => c.id === customerId)).toBe(true);
  });
  it('drills a series into its active customers', async () => {
    const a = await admin();
    const r = await a.get(`/api/dashboard/drill/series?param=${seriesId}`);
    expect(r.status).toBe(200);
    // Grouped drill: series summary rows, each carrying its investments as children.
    expect(r.json.kind).toBe('groups');
    const children = (r.json.groups as any[]).flatMap((g) => g.children);
    expect(children.some((x: any) => Number(x.amount) === 500000)).toBe(true);
  });
});

describe('audit + system', () => {
  it('audit browser lists recent actions', async () => {
    const a = await admin();
    const r = await a.get('/api/audit?entity_type=applications');
    expect(r.status).toBe(200);
    expect(r.json.rows.length).toBeGreaterThan(0);
    expect(r.json.rows[0]).toHaveProperty('action');
  });
  it('system notification queue is readable', async () => {
    const a = await admin();
    expect((await a.get('/api/system/notifications')).status).toBe(200);
  });
});

describe('report documents', () => {
  it('SOA is a PDF', async () => {
    const a = await admin();
    const dl = await a.raw(`/api/reports/soa/${customerId}.pdf`);
    expect(dl.status).toBe(200);
    expect(dl.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
  it('TDS report is an xlsx', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/tds/2026-08.xlsx');
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dl.buffer);
    expect(wb.worksheets[0]!.name).toContain('TDS');
  });
  it('full dump has the key sheets', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/dump.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(dl.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Customers', 'Applications', 'Schedule', 'Redemptions']));
  });
});

describe('funded subscription (integration)', () => {
  it('creates a live app; wealth wire shape; idempotent', async () => {
    // The live LockerHub payload sends customer_phone + numeric series/scheme ids.
    const body = {
      customer_phone: '9400000001', customer_name: 'Funded Cust',
      series_id: seriesId, scheme_id: schemeId,
      amount: 200000, lockerhub_intent_no: 'LH-INTENT-1',
      lockerhub_application_no: 'APP-2026-90001', provider: 'easebuzz', provider_ref: 'EZB123', verified: true,
    };
    const post = () => fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
      method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const first = await post();
    expect(first.status).toBe(200);
    expect(first.json.success).toBe(true);
    expect(first.json.wealth_subscription_id).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(first.json.wealth_subscription_request_id).toBe(first.json.wealth_subscription_id);
    expect(first.json.is_placeholder).toBe(false);
    expect(first.json.customer_id).toBeGreaterThan(0);
    const again = await post();
    expect(again.status).toBe(200);
    expect(again.json.already_processed).toBe(true);
    expect(again.json.wealth_subscription_id).toBe(first.json.wealth_subscription_id);
    const st = (await ctx.db.query('SELECT status FROM applications WHERE lockerhub_intent_no = $1', ['LH-INTENT-1'])).rows[0] as any;
    expect(st.status).toBe('Active'); // app payment is reconciled → goes live instantly
    // …and a notice lands on the Approvals page so the admin knows app money came in
    const notice = (await ctx.db.query(
      "SELECT status FROM approval_requests WHERE request_type = 'app_investment' AND entity_type = 'applications' AND entity_id = (SELECT id::text FROM applications WHERE lockerhub_intent_no = $1)", ['LH-INTENT-1'])).rows[0] as any;
    expect(notice?.status).toBe('Pending');

    // an unknown phone auto-creates a Draft stub customer (money never 404s)
    const stubPost = await fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
      method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, customer_phone: '9400000077', lockerhub_intent_no: 'LH-INTENT-2', lockerhub_application_no: 'APP-2026-90002' }),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    expect(stubPost.status).toBe(200);
    const stub = (await ctx.db.query("SELECT creation_status, pan FROM customers WHERE phone = '9400000077'")).rows[0] as any;
    expect(stub.creation_status).toBe('Draft');
    expect(stub.pan).toBe('LH_9400000077');
  });
});

describe('backdated importer', () => {
  it('imports an active investment with a schedule, and is idempotent', async () => {
    const a = await admin();
    const rows = [{ full_name: 'Imported Holder', pan: 'ABCDE1234F', series_code: 'NCD DEMO', scheme_code: 'NCD-DEMO', amount: 300000, allotment_date: '2025-01-01' }];
    const first = await a.post('/api/imports/backdated', { rows });
    expect(first.status).toBe(201);
    expect(first.json.created).toBe(1);
    const cust = (await ctx.db.query("SELECT id FROM customers WHERE pan = 'ABCDE1234F'")).rows[0] as any;
    const sched = (await ctx.db.query('SELECT count(*)::int AS n FROM disbursement_schedule ds JOIN applications ap ON ap.id = ds.application_id WHERE ap.customer_id = $1', [Number(cust.id)])).rows[0] as any;
    expect(Number(sched.n)).toBeGreaterThan(0);
    // some historic rows are Paid
    const paid = (await ctx.db.query("SELECT count(*)::int AS n FROM disbursement_schedule ds JOIN applications ap ON ap.id = ds.application_id WHERE ap.customer_id = $1 AND ds.status = 'Paid'", [Number(cust.id)])).rows[0] as any;
    expect(Number(paid.n)).toBeGreaterThan(0);
    // re-run: idempotent
    const second = await a.post('/api/imports/backdated', { rows });
    expect(second.json.created).toBe(0);
    expect(second.json.skipped).toBe(1);
  });
});
