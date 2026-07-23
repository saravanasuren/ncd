/**
 * Payout SUMMARY sheet (wealth parity) — the human companion to the bank NEFT
 * file. Its own server so batch creation here can't perturb the money-out
 * tests: each batch consumes the accrued interest, so these must not share.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
/** A payout date far enough out that everything seeded has accrued. */
const CUTOFF = '2026-11-28';

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  // Two live investments with bank details, so the sheet has real rows and a
  // beneficiary name to print.
  for (const [i, name] of [['9600000021', 'Summary Cust One'], ['9600000022', 'Summary Cust Two']] as const) {
    const cust = await a.post('/api/customers', { full_name: name, phone: i, email: `${i}@ex.com` });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '6666000' + i.slice(-4), ifsc: 'ICIC0001234', holder_name: name });
    const app = await a.post('/api/applications', {
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12',
    });
    await approveInvestment(await as('ncd@demo.local'), app);
  }
});
afterAll(async () => { await ctx.close(); });

const HEADERS = [
  '#', 'Application No', 'Customer Name', 'DOB', 'PAN', 'Series', 'Type',
  'Invested (Rs)', 'Rate %', 'Beneficiary Name', 'Bank A/C', 'IFSC',
  'Interest From', 'Interest To', 'Days', 'Gross (Rs)', 'TDS (Rs)', 'Net (Rs)',
];

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets[0]!;
}

describe('payout summary sheet', () => {
  it('preview carries wealth\'s 18 columns, in order', async () => {
    const a = await admin();
    const dl = await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`);
    expect(dl.status).toBe(200);
    const ws = await sheetOf(dl.buffer);
    expect((ws.getRow(1).values as unknown[]).filter(Boolean)).toEqual(HEADERS);
    expect(ws.rowCount).toBeGreaterThan(1);

    const row = ws.getRow(2);
    expect(String(row.getCell(2).value)).toMatch(/^APP-/);                     // Application No
    expect(String(row.getCell(7).value)).toMatch(/^(Addition|Live|Redemption)$/); // Type
    expect(Number(row.getCell(15).value)).toBeGreaterThan(0);                  // Days
    // Beneficiary Name comes from the BANK ACCOUNT's holder_name (owner #4),
    // not the customer record — joint/differently-named accounts must match.
    expect(String(row.getCell(10).value)).toMatch(/^Summary Cust/);
    // Gross = TDS + Net, all whole rupees.
    expect(Number(row.getCell(16).value)).toBe(Number(row.getCell(17).value) + Number(row.getCell(18).value));
    for (const c of [16, 17, 18]) expect(Number(row.getCell(c).value) % 1).toBe(0);
  });

  it('Interest From precedes Interest To (the off-by-one wealth hit)', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    const ymd = (v: unknown) => { const [d, m, y] = String(v).split('/').map(Number); return Date.UTC(y!, m! - 1, d!); };
    for (let r = 2; r <= Math.min(ws.rowCount, 12); r++) {
      const from = ws.getRow(r).getCell(13).value;
      const to = ws.getRow(r).getCell(14).value;
      if (!from || !to) continue;
      expect(ymd(from)).toBeLessThanOrEqual(ymd(to));
    }
  });

  it('a saved batch produces the same sheet, named after the batch', async () => {
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: CUTOFF });
    expect(batch.status).toBe(201);
    const a = await admin();
    const dl = await a.raw(`/api/payouts/${batch.json.batch_id}/summary.xlsx`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers.get('content-disposition'))).toMatch(/-summary\.xlsx"$/);
    const ws = await sheetOf(dl.buffer);
    expect((ws.getRow(1).values as unknown[]).filter(Boolean)).toEqual(HEADERS);
    expect(ws.rowCount).toBeGreaterThan(1);
  });

  it('404s an unknown batch', async () => {
    const a = await admin();
    expect((await a.raw('/api/payouts/999999/summary.xlsx')).status).toBe(404);
  });
});
