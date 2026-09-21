/**
 * The Leads page as an Excel download (owner 2026-09-21: "in leads page - get
 * me a download button to download the leads report in excel").
 *
 * The file itself is easy. What is worth pinning is that it is a list of phone
 * numbers, so it must hold exactly what the person could already see on the
 * screen — a branch user's download carrying another user's leads would be a
 * leak dressed up as a report. The rows come from the same scope rule as the
 * list, and the test below proves the two agree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function sheet(c: Client, name: string): Promise<string[][]> {
  const r = await c.raw('/api/leads/report.xlsx');
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer as never);
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow((row) => { out.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))); });
  return out;
}
const flat = (rows: string[][]) => rows.flat().join(' | ');

describe('leads report', () => {
  beforeAll(async () => {
    // One lead each from a staff member and an agent, so scope has something to separate.
    const staff = await as('staff@demo.local');
    const s = await staff.post('/api/leads', {
      full_name: 'Report Lead Staff', phone: '9876500001', district: 'Coimbatore', source: 'Walk-in',
      lead_type: 'ncd', interested_scheme: '13% 36M', expected_amount: 500000, follow_up_date: '2026-09-30',
    });
    expect(s.status).toBe(201);
    await staff.post(`/api/leads/${s.json.id}/notes`, { note: 'Called, will visit branch on Monday' });
    const agent = await as('agent@demo.local');
    const g = await agent.post('/api/leads', {
      full_name: 'Report Lead Agent', phone: '0987600002', lead_type: 'locker', locker_size: 'XL',
    });
    expect(g.status).toBe(201);
  });

  it('is an .xlsx with Summary, Leads and App prospects sheets', async () => {
    const r = await (await admin()).raw('/api/leads/report.xlsx');
    expect(r.status).toBe(200);
    expect(String(r.headers.get('content-type'))).toContain('spreadsheetml');
    expect(String(r.headers.get('content-disposition'))).toMatch(/leads-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Leads', 'App prospects']);
  });

  it('carries what the table hides — creator, follow-up and the latest note', async () => {
    const rows = await sheet(await admin(), 'Leads');
    expect(rows[0]).toEqual([
      'Created On', 'Name', 'Phone', 'Place', 'District', 'Category', 'Source', 'Referred By',
      'Interested In', 'Scheme / Locker Size', 'Expected Amount', 'Follow-up Date', 'Status',
      'Created By', 'Branch', 'Converted To', 'Notes', 'Follow-up Notes', 'Latest Note', 'Latest Note On',
    ]);
    const lead = rows.find((r) => r[1] === 'Report Lead Staff')!;
    expect(lead).toBeTruthy();
    expect(lead[4]).toBe('Coimbatore');
    expect(lead[8]).toBe('NCD');
    expect(lead[9]).toBe('13% 36M');
    expect(Number(lead[10])).toBe(500000);
    expect(lead[11]).toBe('30/09/2026');
    expect(lead[13]).toBe('Demo Branch Staff');
    expect(lead[17]).toBe('1');
    expect(lead[18]).toBe('Called, will visit branch on Monday');

    const locker = rows.find((r) => r[1] === 'Report Lead Agent')!;
    expect(locker[8]).toBe('Locker');
    expect(locker[9]).toBe('XL');
  });

  it('keeps a phone number as text, leading zero and all', async () => {
    // As a number Excel shows 9.88E+09 and drops the 0 — a list nobody can dial.
    const r = await (await admin()).raw('/api/leads/report.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer as never);
    const ws = wb.getWorksheet('Leads')!;
    let found = false;
    ws.eachRow((row) => {
      if (row.getCell(2).value === 'Report Lead Agent') {
        found = true;
        expect(row.getCell(3).value).toBe('0987600002');
        expect(typeof row.getCell(3).value).toBe('string');
      }
    });
    expect(found).toBe(true);
  });

  it('CONTROL: a staff member gets their own leads, and nobody else’s', async () => {
    const staff = await as('staff@demo.local');
    const mine = flat(await sheet(staff, 'Leads'));
    expect(mine).toContain('Report Lead Staff');
    expect(mine).not.toContain('Report Lead Agent');

    const agent = await as('agent@demo.local');
    const theirs = flat(await sheet(agent, 'Leads'));
    expect(theirs).toContain('Report Lead Agent');
    expect(theirs).not.toContain('Report Lead Staff');
  });

  it('holds exactly the leads the page lists — the two cannot drift', async () => {
    for (const who of ['staff@demo.local', 'agent@demo.local']) {
      const c = await as(who);
      const onScreen = ((await c.get('/api/leads')).json.rows as Array<{ full_name: string }>).map((l) => l.full_name).sort();
      const inFile = (await sheet(c, 'Leads')).slice(1).map((r) => r[1]).filter(Boolean).sort();
      expect(inFile, who).toEqual(onScreen);
    }
  });

  it('is written to the audit log — it is every phone number in scope', async () => {
    const a = await admin();
    await a.raw('/api/leads/report.xlsx');
    const n = Number((await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'leads.export'")).rows[0]!.n);
    expect(n).toBeGreaterThan(0);
  });

  it('refuses someone without leads access', async () => {
    const anon = new Client(ctx.base);
    const r = await anon.raw('/api/leads/report.xlsx');
    expect([401, 403]).toContain(r.status);
  });
});
