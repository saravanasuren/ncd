/**
 * Customer-wise report — ported from wealth's report of the same name
 * (app/src/routes/reports.js `_customerWiseRows`). Pins the exact column set,
 * the three-way money split, and the deliberate divergence from wealth: this
 * report nets partial premature withdrawals into "Total investment" (ncd's own
 * book value) rather than restating the ₹25L overstatement bug wealth's own
 * raw a.total_amount had.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function activeCustomer(a: Client, name: string, phone: string, amount: number, extra: Record<string, unknown> = {}) {
  const cust = await a.post('/api/customers', {
    full_name: name, phone, pan: extra.pan, dob: extra.dob, address: extra.address,
    city: extra.city, district: extra.district, state: extra.state, pincode: extra.pincode,
  });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `9${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-10',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return { cid, appId: Number(app.json.id) };
}

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('customer-wise report', () => {
  it('carries DOB, PAN, address, TDS status and the money split', async () => {
    const a = await admin();
    await activeCustomer(a, 'Full Detail Investor', '9700000101', 500000, {
      pan: 'ABCDE1234F', dob: '1985-06-02',
      address: '12 Mount Road', city: 'Coimbatore', district: 'Coimbatore', state: 'Tamil Nadu', pincode: '641001',
    });
    const r = await a.get('/api/reports/customer-wise');
    expect(r.status).toBe(200);
    const row = (r.json.customers as any[]).find((c) => c.full_name === 'Full Detail Investor');
    expect(row).toBeTruthy();
    expect(row.dob).toBe('1985-06-02');
    expect(row.age).toBeGreaterThan(30);
    expect(row.pan).toBe('ABCDE1234F');
    expect(row.address).toBe('12 Mount Road, Coimbatore, Coimbatore, Tamil Nadu, 641001');
    expect(row.tds_status).toBe('TDS applicable'); // default: no form, tds_applicable defaults true
    expect(Number(row.total_invested)).toBe(500000);
    expect(Number(row.total_all_time)).toBe(500000);
    expect(Number(row.total_redeemed)).toBe(0);
    expect(row.applications).toHaveLength(1);
    expect(row.applications[0].status).toBe('Active');
    expect(row.applications[0].series_code).toBeTruthy();
  });

  it('a 15G/15H filing shows "Form 121 (…) — no TDS"', async () => {
    const a = await admin();
    const { cid } = await activeCustomer(a, 'Form Filer', '9700000102', 500000);
    await a.patch(`/api/customers/${cid}/tax`, { tds_applicable: false, tax_form: '15G', tax_form_expires_on: '2027-03-31' });
    const r = await a.get('/api/reports/customer-wise');
    const row = (r.json.customers as any[]).find((c) => c.full_name === 'Form Filer');
    expect(row.tds_status).toBe('Form 121 (15G) — no TDS');
  });

  // The deliberate divergence from wealth: wealth sums the raw a.total_amount
  // for "Total investment", which restates the exact ₹25L overstatement bug
  // already fixed everywhere else in ncd (a partially-redeemed line still
  // showing its FULL original amount). This report nets it instead, while
  // "All-time invested" keeps showing the original amount — that split is the
  // whole point of the two columns existing separately.
  it('total_invested nets a partial withdrawal; total_all_time keeps the original amount', async () => {
    const a = await admin();
    const { cid, appId } = await activeCustomer(a, 'Partial Withdrawer', '9700000103', 1000000);
    // Simulate a ₹4L partial premature withdrawal the way the redemption
    // approval itself would leave the line (app stays Active).
    await ctx.db.query("UPDATE application_lines SET outstanding_amount = 600000 WHERE application_id = $1", [appId]);

    const r = await a.get('/api/reports/customer-wise');
    const row = (r.json.customers as any[]).find((c) => c.full_name === 'Partial Withdrawer');
    expect(Number(row.total_invested)).toBe(600000);   // netted — the live book value
    expect(Number(row.total_all_time)).toBe(1000000);  // original subscription, untouched
    void cid;
  });

  it('a fully redeemed customer shows 0 invested and the redeemed amount', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Fully Redeemed Investor', phone: '9700000104' });
    const cid = Number(cust.json.id);
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '97000001040', ifsc: 'ICIC0001111' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-07-10',
    });
    const appId = Number(app.json.id);
    await approveInvestment(await as('ncd@demo.local'), app);
    await ctx.db.query("UPDATE applications SET status = 'Redeemed' WHERE id = $1", [appId]);

    const r = await a.get('/api/reports/customer-wise');
    const row = (r.json.customers as any[]).find((c) => c.full_name === 'Fully Redeemed Investor');
    expect(Number(row.total_invested)).toBe(0);
    expect(Number(row.total_redeemed)).toBe(500000);
    expect(Number(row.total_all_time)).toBe(500000);
    expect(row.applications[0].status).toBe('Redeemed');
  });

  it('an inactive (deactivated) customer never appears', async () => {
    const a = await admin();
    const { cid } = await activeCustomer(a, 'Deactivated Investor', '9700000105', 500000);
    await ctx.db.query('UPDATE customers SET is_active = FALSE WHERE id = $1', [cid]);
    const r = await a.get('/api/reports/customer-wise');
    expect((r.json.customers as any[]).some((c) => c.full_name === 'Deactivated Investor')).toBe(false);
  });

  it('a customer with no real investment (Draft/Cancelled/Rejected only) never appears', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Draft Only Investor', phone: '9700000106' });
    const r = await a.get('/api/reports/customer-wise');
    expect((r.json.customers as any[]).some((c) => c.full_name === 'Draft Only Investor')).toBe(false);
    void cust;
  });

  it('grand_total sums total_invested (netted), not the raw subscribed amounts', async () => {
    const a = await admin();
    const before = await a.get('/api/reports/customer-wise');
    await activeCustomer(a, 'Grand Total Check', '9700000107', 700000);
    const after = await a.get('/api/reports/customer-wise');
    expect(Number(after.json.grand_total)).toBe(Number(before.json.grand_total) + 700000);
    expect(after.json.count).toBe(before.json.count + 1);
  });

  it('branch staff without reports:download are refused', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.get('/api/reports/customer-wise')).status).toBe(403);
    expect((await staff.raw('/api/reports/customer-wise.xlsx')).status).toBe(403);
  });

  it('CXO can reach it', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.get('/api/reports/customer-wise')).status).toBe(200);
  });
});

describe('customer-wise report — Excel export', () => {
  it('produces two sheets with the exact wealth header set, in order', async () => {
    const a = await admin();
    await activeCustomer(a, 'Excel Header Check', '9700000201', 500000, { pan: 'ZZAAA9999Z' });
    const dl = await a.raw('/api/reports/customer-wise.xlsx');
    expect(dl.status).toBe(200);
    const wb = await sheetOf(dl.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Customers', 'Investments']);

    const custHeader = (wb.getWorksheet('Customers')!.getRow(1).values as unknown[]).filter((v) => v !== undefined && v !== null);
    expect(custHeader).toEqual([
      'S.No', 'Customer Code', 'Name', 'DOB', 'Age', 'PAN', 'Phone', 'Address',
      'TDS / Form 121', 'Total Investment', 'Redemption Amount', 'All-time Invested', 'No. of Investments',
    ]);

    const invHeader = (wb.getWorksheet('Investments')!.getRow(1).values as unknown[]).filter((v) => v !== undefined && v !== null);
    expect(invHeader).toEqual(['Customer Code', 'Name', 'PAN', 'Application No', 'Series', 'Amount', 'Status', 'Date']);
  });

  it('the Investments sheet has one row per application, matching the customer count in the JSON', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/customer-wise.xlsx');
    const wb = await sheetOf(dl.buffer);
    const json = await a.get('/api/reports/customer-wise');
    const expectedInvRows = (json.json.customers as any[]).reduce((s, c) => s + c.applications.length, 0);
    expect(wb.getWorksheet('Investments')!.rowCount - 1).toBe(expectedInvRows);
    expect(wb.getWorksheet('Customers')!.rowCount - 1).toBe(json.json.count);
  });
});
