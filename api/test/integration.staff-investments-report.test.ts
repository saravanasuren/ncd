/**
 * Staff-wise investments report (owner 2026-09-21): how much each staff member
 * brought in, month-wise and series-wise. Attribution is the resolved staff
 * referrer (referred_by_text matching an is_staff user), the same rule as the
 * staff-wise dashboard tile. The .xlsx carries two pivots + the detail grain.
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

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function fund(a: Client, name: string, phone: string, amount: number, referredBy: string, when: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone, referred_by_text: referredBy });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `9${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: when,
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return app;
}

describe('staff-wise investments report', () => {
  it('splits a staff member’s investments by month and by series', async () => {
    const a = await admin();
    // 'Demo NCD Manager' is a seeded is_staff user, so these attribute Staff-wise.
    await fund(a, 'SIR Cust July A', '9700000701', 200000, 'Demo NCD Manager', '2026-07-10');
    await fund(a, 'SIR Cust July B', '9700000702', 300000, 'Demo NCD Manager', '2026-07-20');
    await fund(a, 'SIR Cust Aug',    '9700000703', 400000, 'Demo NCD Manager', '2026-08-05');
    // An agent-name referrer must NOT appear (staff-only report).
    await fund(a, 'SIR Cust Agent',  '9700000704', 999000, 'Gokul The Agent', '2026-07-15');

    const r = await a.get('/api/reports/staff-investments');
    expect(r.status).toBe(200);
    const rows = r.json.rows as Array<{ staff: string; month: string; series_code: string; count: number; amount: number }>;

    const mine = rows.filter((x) => x.staff === 'Demo NCD Manager');
    // Two months for this staff: 2026-07 (200k + 300k) and 2026-08 (400k).
    const jul = mine.find((x) => x.month === '2026-07');
    const aug = mine.find((x) => x.month === '2026-08');
    expect(jul?.amount).toBe(500000);
    expect(jul?.count).toBe(2);
    expect(aug?.amount).toBe(400000);
    expect(aug?.count).toBe(1);
    expect(mine.every((x) => x.series_code === 'NCD DEMO')).toBe(true);

    // The agent-name referrer is excluded from a staff report.
    expect(rows.some((x) => x.staff === 'Gokul The Agent')).toBe(false);
    expect(r.json.months).toContain('2026-07');
    expect(r.json.months).toContain('2026-08');
  });

  it('the Excel has a By Month pivot, a By Series pivot and a Detail sheet', async () => {
    const a = await admin();
    const res = await a.raw('/api/reports/staff-investments.xlsx');
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    expect(wb.getWorksheet('By Month')).toBeTruthy();
    expect(wb.getWorksheet('By Series')).toBeTruthy();
    expect(wb.getWorksheet('Detail')).toBeTruthy();

    // By Month: the staff row carries their grand total (200k+300k+400k = 900k).
    const byMonth = wb.getWorksheet('By Month')!;
    let staffTotal: number | null = null;
    byMonth.eachRow((row) => {
      if (String(row.getCell(1).value) === 'Demo NCD Manager') {
        staffTotal = Number(row.getCell(row.cellCount).value);
      }
    });
    expect(staffTotal).toBe(900000);
  });
});
