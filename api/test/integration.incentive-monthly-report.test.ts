/**
 * The monthly incentive download (owner 2026-09-14: "if i choose in august and
 * click download - i need a clear detailed report of incentives of each and
 * every staffs for that particular month. for agents also the same ... no pdf
 * files - i need it in excel").
 *
 * What is worth testing here is not that a file comes back — it is that the
 * file says the same thing the screens do. The owner asked for EARNED-in-month
 * when given the choice, so the month is the money-received month, and a row
 * belongs to the month the investment arrived in regardless of when it was
 * paid. Get that wrong and the download and the Incentives page disagree about
 * what somebody is owed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

/** Read a sheet back as rows of cell values, so the assertions are on the file
 *  a person opens rather than on the JSON that produced it. */
async function sheetRows(buf: Buffer, name: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow((row) => {
    out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))));
  });
  return out;
}

const downloadRaw = (c: Client, month: string) =>
  c.raw(`/api/incentives/monthly-report.xlsx?month=${encodeURIComponent(month)}`);
const downloadBuf = async (c: Client, month: string) => (await downloadRaw(c, month)).buffer;

describe('monthly incentive report', () => {
  it('refuses a month it cannot parse, rather than returning an empty sheet', async () => {
    // An empty workbook for "August" reads as "nobody earned anything", which
    // is a much more expensive misunderstanding than an error.
    const a = await admin();
    for (const bad of ['August', '2026-13', '2026', '']) {
      const r = await a.get(`/api/incentives/monthly-report.xlsx?month=${encodeURIComponent(bad)}`);
      expect(r.status, bad || '(empty)').toBe(400);
    }
  });

  it('is an .xlsx with Summary, Staff and Agents sheets', async () => {
    const a = await admin();
    const r = await downloadRaw(a, '2026-08');
    expect(r.status).toBe(200);
    expect(String(r.headers.get('content-type'))).toContain('spreadsheetml');
    expect(String(r.headers.get('content-disposition'))).toContain('incentives-2026-08.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Staff', 'Agents']);
  });

  it('puts an investment in the month its MONEY was received, not the month it was paid', async () => {
    // The load-bearing rule. The owner chose earned-in-month so the download
    // agrees with the Incentives page and My Earnings.
    const a = await admin();
    const cust = await a.post('/api/customers', {
      full_name: 'Monthly Report Cust', phone: '9766600001', email: 'mr@example.com',
    });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`,
      { account_number: '889766600001', ifsc: 'ICIC0001234' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId,
      scheme_id: schemeId, amount: 500000, date_money_received: '2026-08-14',
    });
    await a.post(`/api/applications/${app.json.id}/mark-esigned`);
    await approveInvestment(await as('ncd@demo.local'), app);

    const inAug = await sheetRows((await downloadBuf(a, '2026-08')), 'Staff');
    const flatAug = inAug.flat().join(' | ');
    expect(flatAug).toContain('Monthly Report Cust');

    // ...and it is NOT in a neighbouring month.
    const inJul = await sheetRows((await downloadBuf(a, '2026-07')), 'Staff');
    expect(inJul.flat().join(' | ')).not.toContain('Monthly Report Cust');
    const inSep = await sheetRows((await downloadBuf(a, '2026-09')), 'Staff');
    expect(inSep.flat().join(' | ')).not.toContain('Monthly Report Cust');
  });

  it('carries the detail a payout needs, not just a total', async () => {
    const a = await admin();
    const rows = await sheetRows((await downloadBuf(a, '2026-08')), 'Staff');
    expect(rows[0]).toEqual([
      'Name', 'Role', 'Application No', 'Customer', 'Customer Code', 'Series',
      'Money Received', 'Investment Amount', 'Rate', 'Incentive', 'Paid?', 'Paid On',
    ]);
    // Every detail row carries a name and an application, so a figure can
    // always be traced back to the investment behind it.
    const body = rows.slice(1).filter((r) => r[0] && r[0] !== 'TOTAL');
    for (const r of body) {
      expect(r[0]).toBeTruthy();
      expect(r[2]).toBeTruthy();
    }
  });

  it('a month with nothing in it says so, in both sheets', async () => {
    // Rather than an empty grid that looks like a broken download.
    const a = await admin();
    const staff = await sheetRows((await downloadBuf(a, '2019-01')), 'Staff');
    const agents = await sheetRows((await downloadBuf(a, '2019-01')), 'Agents');
    expect(staff.flat().join(' ')).toMatch(/earned an incentive/i);
    expect(agents.flat().join(' ')).toMatch(/earned an incentive/i);
  });

  it('CONTROL: report access alone does NOT open the whole incentive book', async () => {
    // A branch manager can download reports but has no business reading every
    // person's earnings. Gated on incentives:manage-eligibility, not
    // reports:download.
    const bm = await as('bm@demo.local');
    const r = await downloadRaw(bm, '2026-08');
    expect(r.status).toBe(403);
  });
});
