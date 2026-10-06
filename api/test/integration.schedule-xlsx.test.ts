/**
 * The Download-Excel button on an investment's interest & redemption schedule
 * (owner 2026-10-06: "get me a excel download for this table").
 *
 * The point of the feature is that the file IS the table, so that is what these
 * assert: row for row, rupee for rupee, against the very response the page
 * renders — not against a second expectation written out by hand, which could
 * agree with the file while both drifted from the screen.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { applicationScheduleXlsx } from '../src/modules/reports/documents.js';

let ctx: TestCtx;
let appId: number;
let appNo: string;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const cust = await a.post('/api/customers', { full_name: 'Schedule Investor', phone: '9800012345' });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '11110001', ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 2500000, date_money_received: '2026-07-10',
  });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(await as('ncd@demo.local'), app);   // go live → schedule materialises
  appId = Number(app.json.id);
  appNo = String(app.json.application_no ?? (await a.get(`/api/applications/${appId}`)).json.application.application_no);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets[0]!;
}
/** The header row's cells, as text. */
const headersOf = (ws: ExcelJS.Worksheet) =>
  (ws.getRow(4).values as unknown[]).slice(1).map((v) => String(v ?? ''));
const cell = (ws: ExcelJS.Worksheet, row: number, header: string) =>
  ws.getRow(row).getCell(headersOf(ws).indexOf(header) + 1).value;

describe('investment schedule → xlsx', () => {
  it('downloads as an attachment named after the application', async () => {
    const dl = await (await as('admin@dhanam.finance', 'ChangeMe_Dev_123')).raw(`/api/applications/${appId}/schedule.xlsx`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers.get('content-type'))).toContain('spreadsheetml');
    expect(String(dl.headers.get('content-disposition'))).toBe(`attachment; filename="schedule-${appNo}.xlsx"`);
  });

  it('is the table on screen — same rows, same money, in the same order', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const page = (await a.get(`/api/applications/${appId}`)).json;
    const ws = await sheetOf((await a.raw(`/api/applications/${appId}/schedule.xlsx`)).buffer);
    expect(page.schedule.length).toBeGreaterThan(1);

    // Rows start under the header (row 4); two title rows and a gap sit above it.
    page.schedule.forEach((r: Record<string, unknown>, i: number) => {
      const n = 5 + i;
      const [y, m, d] = String(r.due_date).slice(0, 10).split('-');
      expect(cell(ws, n, 'Due date')).toBe(`${d}/${m}/${y}`);
      expect(String(cell(ws, n, 'Type'))).toContain(String(r.due_type));
      expect(cell(ws, n, 'Gross (Rs)')).toBeCloseTo(Number(r.gross_amount), 2);
      expect(cell(ws, n, 'TDS (Rs)')).toBeCloseTo(Number(r.tds_amount), 2);
      expect(cell(ws, n, 'Net (Rs)')).toBeCloseTo(Number(r.net_amount), 2);
      expect(cell(ws, n, 'Status')).toBe(String(r.status));
    });
    // …and nothing beyond them but the gap and the three total rows.
    const last = 5 + page.schedule.length - 1;
    expect(cell(ws, last + 1, 'Type')).toBeFalsy();
    expect(cell(ws, last + 2, 'Type')).toBe('Interest over the term');
    expect(cell(ws, last + 3, 'Type')).toBe('Total due (interest + principal)');
    expect(cell(ws, last + 4, 'Type')).toBe('Of which paid');
  });

  it('keeps interest and principal apart, and says how much is paid', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const page = (await a.get(`/api/applications/${appId}`)).json;
    const ws = await sheetOf((await a.raw(`/api/applications/${appId}/schedule.xlsx`)).buffer);
    const interestRow = 5 + page.schedule.length + 1;
    const rows: Record<string, unknown>[] = page.schedule;
    const sum = (k: string, rs: Record<string, unknown>[]) => rs.reduce((s, r) => s + Number(r[k]), 0);
    const interest = rows.filter((r) => String(r.due_type).includes('Interest'));
    const principal = rows.filter((r) => !String(r.due_type).includes('Interest'));

    // The guard that matters: this investment redeems Rs 25,00,000 of capital, so
    // the two figures must differ by exactly that. One merged total would read as
    // interest earned and be out by the whole principal.
    expect(principal.length).toBeGreaterThan(0);
    expect(cell(ws, interestRow, 'Gross (Rs)')).toBeCloseTo(sum('gross_amount', interest), 2);
    expect(cell(ws, interestRow + 1, 'Gross (Rs)')).toBeCloseTo(sum('gross_amount', rows), 2);
    expect(Number(cell(ws, interestRow + 1, 'Gross (Rs)')) - Number(cell(ws, interestRow, 'Gross (Rs)')))
      .toBeCloseTo(sum('gross_amount', principal), 2);
    // Nothing is settled on a just-activated investment, so the paid line is zero
    // rather than absent — a blank there would read as "unknown".
    expect(cell(ws, interestRow + 2, 'Net (Rs)')).toBe(0);
  });

  it('carries the investment and the customer in its first two rows', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const ws = await sheetOf((await a.raw(`/api/applications/${appId}/schedule.xlsx`)).buffer);
    expect(String(ws.getRow(1).getCell(1).value)).toContain(appNo);
    expect(String(ws.getRow(1).getCell(1).value)).toContain('Schedule Investor');
    const detail = String(ws.getRow(2).getCell(1).value);
    expect(detail).toContain('NCD DEMO');       // series
    expect(detail).toContain('months');          // tenure, off the line
    expect(detail).toMatch(/money received 10\/07\/2026/);
  });

  it('opens to exactly whoever the table opens to', async () => {
    // The export must not be a second, laxer door onto the same data: for every
    // user, the file answers precisely when the page does. Asserted as a
    // relation rather than a fixed status, so it holds however branch scoping
    // is seeded.
    for (const email of ['staff@demo.local', 'agent@demo.local', 'cxo@demo.local']) {
      const c = await as(email);
      const page = await c.get(`/api/applications/${appId}`);
      const file = await c.raw(`/api/applications/${appId}/schedule.xlsx`);
      expect(file.status, `${email} must reach the file iff it reaches the table`).toBe(page.status);
    }
  });
});

describe('schedule xlsx — the columns the screen cannot show', () => {
  const app = {
    application_no: 'APP-TEST-1', customer_name: 'Test Holder', customer_code: 'DHN1',
    series_code: 'NCD_23', total_amount: 2500000, date_money_received: '2025-07-29',
    maturity_date: '2030-10-20', status: 'Active',
  };
  const lines = [{ coupon_rate_pct: 12, tenure_months: 60 }];

  it('records when a settled row was actually paid', async () => {
    const ws = await sheetOf(await applicationScheduleXlsx(app, lines, [
      { due_date: '2025-08-31', due_type: 'Interest', gross_amount: 25000, tds_amount: 0, net_amount: 25000,
        status: 'Paid', paid_at: '2025-09-01 10:22:00+05:30' },
    ]));
    expect(cell(ws, 5, 'Status')).toBe('Paid');
    expect(cell(ws, 5, 'Paid on')).toBe('01/09/2025');
  });

  it('gives a one-off deduction its own column — and only when there is one', async () => {
    const plain = await sheetOf(await applicationScheduleXlsx(app, lines, [
      { due_date: '2025-08-31', due_type: 'Interest', gross_amount: 25000, tds_amount: 2500, net_amount: 22500, status: 'Scheduled' },
    ]));
    expect(headersOf(plain)).not.toContain('Adjustment (Rs)');

    // net < gross - TDS: the difference is an adjustment consumed by the payout.
    const docked = await sheetOf(await applicationScheduleXlsx(app, lines, [
      { due_date: '2025-08-31', due_type: 'Interest', gross_amount: 25000, tds_amount: 2500, net_amount: 15269, status: 'Paid' },
    ]));
    expect(headersOf(docked)).toContain('Adjustment (Rs)');
    expect(cell(docked, 5, 'Adjustment (Rs)')).toBeCloseTo(7231, 2);
  });

  it('shows every distinct rate a clubbed investment carries, not just the first', async () => {
    const ws = await sheetOf(await applicationScheduleXlsx(app, [
      { coupon_rate_pct: 12, tenure_months: 60 }, { coupon_rate_pct: 11.5, tenure_months: 60 },
    ], [{ due_date: '2025-08-31', due_type: 'Interest', gross_amount: 1, tds_amount: 0, net_amount: 1, status: 'Scheduled' }]));
    const detail = String(ws.getRow(2).getCell(1).value);
    expect(detail).toContain('12% / 11.5%');
    expect(detail).toContain('60 months');     // the shared tenure is said once
  });

  it('labels a combined row with the tranches behind it', async () => {
    const ws = await sheetOf(await applicationScheduleXlsx(app, lines, [
      { due_date: '2025-09-30', due_type: 'Interest', gross_amount: 50000, tds_amount: 0, net_amount: 50000,
        status: 'Scheduled', combined: true, tranche_count: 3 },
    ]));
    expect(cell(ws, 5, 'Type')).toBe('Interest (3 tranches)');
  });
});
