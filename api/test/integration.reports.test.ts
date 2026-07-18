/**
 * Phase 5 integration — dashboard + 9-tab export reconciliation (docs/06).
 * Builds a small active book, then asserts the dashboard KPIs and that the
 * export's Depositorwise grand total equals the outstanding book.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await buildActiveBook();
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function makeActiveApp(a: Client, name: string, amount: number) {
  const cust = await a.post('/api/customers', { full_name: name, phone: `9${Math.floor(amount)}` });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `1111${amount}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-10', method: 'NEFT' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
}

async function buildActiveBook() {
  const a = await admin();
  await makeActiveApp(a, 'Investor One', 500000);
  await makeActiveApp(a, 'Investor Two', 300000);
  // activate the funded apps: NCD Manager maker, admin checker (two people)
  const ncd = await as('ncd@demo.local');
  const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
  await a.post(`/api/approvals/${batch.json.request.id}/approve`);
}

describe('dashboard', () => {
  it('outstanding book = ₹8,00,000 across 2 active investors', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    expect(ov.status).toBe(200);
    expect(Number(ov.json.kpis.outstanding_book)).toBe(800000);
    expect(ov.json.kpis.active_investors).toBe(2);
  });

  it('CXO can view the dashboard (read-only role)', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.get('/api/dashboard/overview')).status).toBe(200);
  });
});

describe('9-tab NCD book export', () => {
  it('produces the tabs in order with NCD Summary first and NCD by Series', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/ncd-book.xlsx');
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      'NCD Summary', 'NCD by Series', 'Master Client', 'Redemption', 'Depositorwise',
      'Districtwise', 'Agent wise', 'Staff wise', 'Leads', 'Applications', 'Interest Payouts',
    ]);
    expect(wb.getWorksheet('Applications')!.getRow(1).getCell(1).value).toBe('App No');
    expect(wb.getWorksheet('Interest Payouts')!.getRow(1).getCell(6).value).toBe('Type');
    // grouped sheets collapse detail rows under a summary (outline level 1, hidden)
    const dep = wb.getWorksheet('Depositorwise')!;
    let hasCollapsedDetail = false;
    dep.eachRow((row) => { if (row.outlineLevel === 1 && row.hidden) hasCollapsedDetail = true; });
    expect(hasCollapsedDetail).toBe(true);
  });

  it('Depositorwise grand total reconciles with the outstanding book (₹8,00,000)', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/ncd-book.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    const ws = wb.getWorksheet('Depositorwise')!;
    let grand = 0;
    ws.eachRow((row) => {
      const label = String(row.getCell(1).value ?? '');
      if (label === 'Grand Total') grand = Number(row.getCell(6).value); // Amount is col 6 now
    });
    expect(grand).toBe(800000);
  });

  it('CXO can download the export; branch staff cannot', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.raw('/api/reports/ncd-book.xlsx')).status).toBe(200);
    const staff = await as('staff@demo.local');
    expect((await staff.raw('/api/reports/ncd-book.xlsx')).status).toBe(403);
  });

  it('the full DB dump streams a valid workbook (Customers/Applications/Schedule/Redemptions)', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/dump.xlsx');
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Customers', 'Applications', 'Schedule', 'Redemptions']);
  });
});

describe('segments', () => {
  it('district segment returns grouped rows', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/district');
    expect(r.status).toBe(200);
    expect(r.json.by).toBe('district');
    expect(Array.isArray(r.json.groups)).toBe(true);
    // each group carries its individual investments as children
    if (r.json.groups.length) {
      const g = r.json.groups[0];
      expect(typeof g.key).toBe('string');
      expect(Array.isArray(g.children)).toBe(true);
      expect(g.investments).toBeGreaterThanOrEqual(g.children.length > 0 ? 1 : 0);
    }
  });

  it('series segment is available and grouped', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/series');
    expect(r.status).toBe(200);
    expect(r.json.by).toBe('series');
    expect(Array.isArray(r.json.groups)).toBe(true);
  });
});

describe('dashboard tiles + drill (range-aware)', () => {
  const JULY = 'from=2026-07-01&to=2026-07-31';
  it('overview returns flow tiles for the window (money-in received in July = ₹8L)', async () => {
    const a = await admin();
    const ov = await a.get(`/api/dashboard/overview?${JULY}`);
    expect(ov.status).toBe(200);
    expect(ov.json).toHaveProperty('active_series');
    expect(Number(ov.json.flow.money_in)).toBe(800000);
    expect(ov.json.flow.new_investments).toBe(2);
    expect(Number(ov.json.flow.interest_accrued)).toBeGreaterThanOrEqual(0);
    expect(ov.json.range.anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('new-investments drill lists the funded apps in the window; totals reconcile', async () => {
    const a = await admin();
    const dl = await a.get(`/api/dashboard/drill/new-investments?${JULY}`);
    expect(dl.json.kind).toBe('rows');
    expect(dl.json.rows.length).toBe(2);
    expect(dl.json.rows.reduce((s: number, r: any) => s + Number(r.amount), 0)).toBe(800000);
  });

  it('staff drill returns expandable groups', async () => {
    const a = await admin();
    const dl = await a.get(`/api/dashboard/drill/staff?${JULY}`);
    expect(dl.json.kind).toBe('groups');
    expect(Array.isArray(dl.json.groups)).toBe(true);
  });

  it('a window with no money-in reports zero new investments (range is honoured)', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview?from=2020-01-01&to=2020-01-31');
    expect(Number(ov.json.flow.money_in)).toBe(0);
    expect(ov.json.flow.new_investments).toBe(0);
  });

  it('interest snapshot (accrued + monthly) is point-in-time, independent of the range', async () => {
    const a = await admin();
    // Snapshot block is present and non-negative regardless of window.
    const ov = await a.get('/api/dashboard/overview?from=2020-01-01&to=2020-01-31');
    expect(Number(ov.json.interest_snapshot.accrued_total)).toBeGreaterThanOrEqual(0);
    expect(Number(ov.json.interest_snapshot.monthly_projected)).toBeGreaterThanOrEqual(0);
    // The accrued drill is always "as on today", even when a past window is passed.
    const accruedDrill = await a.get('/api/dashboard/drill/interest-accrued?from=2020-01-01&to=2020-01-31');
    expect(accruedDrill.json.kind).toBe('rows');
    // The legacy range-based flow field still zeroes out for a fully-past window.
    expect(Number(ov.json.flow.interest_accrued)).toBe(0);
  });

  it('cost-of-funds drill: customer total is the DISTINCT active count, not the per-rate sum', async () => {
    const a = await admin();
    const dl = await a.get('/api/dashboard/drill/rate-mix');
    expect(dl.json.kind).toBe('rows');
    expect(dl.json.foot_totals).toBeTruthy();
    const ov = await a.get('/api/dashboard/overview');
    // The footer's customer total must equal the outstanding-book investor count
    // (a customer spanning two coupon rates must NOT be double-counted).
    expect(dl.json.foot_totals.customers).toBe(ov.json.kpis.active_investors);
    // And it must be ≤ the sum of the per-rate rows.
    const perRateSum = (dl.json.rows as any[]).reduce((s, r) => s + Number(r.customers), 0);
    expect(dl.json.foot_totals.customers).toBeLessThanOrEqual(perRateSum);
  });

  it('the series drill narrows to a single series when one is passed', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const one = await a.get(`/api/dashboard/drill/series?series=${sid}`);
    expect(one.json.kind).toBe('groups');
    expect(one.json.groups.every((g: any) => g.key === 'NCD DEMO')).toBe(true);
    // the outstanding drill still shows the whole book (every series)
    const all = await a.get('/api/dashboard/drill/outstanding');
    expect(all.json.kind).toBe('groups');
  });
});
