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
/** A payout date far enough out that everything seeded has accrued. Each
 * batch CONSUMES the interest it covers, so every test that creates one takes
 * its own month — otherwise the next create has nothing left and 422s. */
const CUTOFF = '2026-08-28';
let _m = 8;
const NEXT_CUTOFF = () => { _m++; return `2026-${String(_m).padStart(2, '0')}-28`; };

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
    const batch = await ncd.post('/api/payouts', { payout_date: NEXT_CUTOFF() });
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

// The four wealth payout features that hadn't been ported (owner 2026-07-23).
describe('payout PDFs, cancel and cut-off history', () => {
  it('preview.pdf and summary.pdf render real PDFs', async () => {
    const a = await admin();
    // A far cut-off, so there is always un-batched accrual left to preview
    // however many months the earlier tests consumed.
    const prev = await a.raw('/api/payouts/preview.pdf?date=2027-06-28');
    expect(prev.status).toBe(200);
    expect(prev.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(prev.buffer.length).toBeGreaterThan(1000);

    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: NEXT_CUTOFF() });
    expect(batch.status).toBe(201);
    const pdf = await a.raw(`/api/payouts/${batch.json.batch_id}/summary.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(String(pdf.headers.get('content-disposition'))).toMatch(/-summary\.pdf"$/);
  });

  it('cancel releases the batch rows back to the un-batched pool', async () => {
    const ncd = await as('ncd@demo.local');
    const a = await admin();
    const batch = await ncd.post('/api/payouts', { payout_date: NEXT_CUTOFF() });
    expect(batch.status).toBe(201);
    const id = batch.json.batch_id;
    const before = Number((await ctx.db.query('SELECT count(*) AS n FROM disbursement_schedule WHERE batch_id = $1', [id])).rows[0]!.n);
    expect(before).toBeGreaterThan(0);

    const cancelled = await a.post(`/api/payouts/${id}/cancel`, { reason: 'wrong cut-off date' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.rows_released).toBe(before);
    // Rows are unlinked and Scheduled again — re-batchable.
    expect(Number((await ctx.db.query('SELECT count(*) AS n FROM disbursement_schedule WHERE batch_id = $1', [id])).rows[0]!.n)).toBe(0);
    expect((await ctx.db.query('SELECT status FROM payout_batches WHERE id = $1', [id])).rows[0]!.status).toBe('Cancelled');
    // Any open "mark paid" claim is withdrawn with it.
    const open = await ctx.db.query("SELECT count(*) AS n FROM approval_requests WHERE entity_type='payout_batches' AND entity_id=$1 AND status='Pending'", [String(id)]);
    expect(Number((open.rows[0] as any).n)).toBe(0);
    // Cancelling twice is refused, not silently repeated.
    expect((await a.post(`/api/payouts/${id}/cancel`, { reason: 'again' })).status).toBe(409);
  });

  it('a settled batch cannot be cancelled', async () => {
    const ncd = await as('ncd@demo.local');
    const a = await admin();
    const batch = await ncd.post('/api/payouts', { payout_date: NEXT_CUTOFF() });
    expect(batch.status).toBe(201);
    const id = batch.json.batch_id;
    await ctx.db.query("UPDATE payout_batches SET status='Paid' WHERE id=$1", [id]);
    const r = await a.post(`/api/payouts/${id}/cancel`, { reason: 'too late' });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/already settled/i);
  });

  it('cut-off history lists the periods with their totals', async () => {
    const a = await admin();
    const h = await a.get('/api/payouts/cutoff-history');
    expect(h.status).toBe(200);
    expect(Array.isArray(h.json.rows)).toBe(true);
    expect(h.json.rows.length).toBeGreaterThan(0);
    const row = h.json.rows[0];
    expect(row.batch_no).toMatch(/\w/);
    expect(row.cutoff_date).toBeTruthy();
    expect(row).toHaveProperty('rows_paid');
    expect(row).toHaveProperty('customers');
    expect(row).toHaveProperty('net_paid');
    expect(h.json).toHaveProperty('has_more');
  });
});
