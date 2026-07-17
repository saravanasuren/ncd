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
  it('produces the 9 report tabs + Applications + Interest Payouts data tabs', async () => {
    const a = await admin();
    const dl = await a.raw('/api/reports/ncd-book.xlsx');
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      'Ongoing NCD', 'NCD Summary', 'Master Client', 'Redemption', 'Depositorwise',
      'Districtwise', 'Agent wise', 'Staff wise', 'Leads', 'Applications', 'Interest Payouts',
    ]);
    // the two raw-data tabs carry their expected headers
    expect(wb.getWorksheet('Applications')!.getRow(1).getCell(1).value).toBe('App No');
    expect(wb.getWorksheet('Interest Payouts')!.getRow(1).getCell(6).value).toBe('Type');
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
      if (label === 'Grand Total') grand = Number(row.getCell(2).value);
    });
    expect(grand).toBe(800000);
  });

  it('CXO can download the export; branch staff cannot', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.raw('/api/reports/ncd-book.xlsx')).status).toBe(200);
    const staff = await as('staff@demo.local');
    expect((await staff.raw('/api/reports/ncd-book.xlsx')).status).toBe(403);
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
