/**
 * A CUMULATIVE / AT-MATURITY PRODUCT BELONGS ON THE SUMMARY SHEET AT ZERO,
 * AND NOWHERE NEAR THE BANK FILE (owner 2026-10-27).
 *
 *   "in the summary sheet - i want u to bring in the doubling series investment
 *    amounts also, but in the interest column alone keep their interest as 0 as
 *    they will not get paid in this batch. and in the neft sheet they should
 *    not appear as no interest is going to them."
 *
 * #486 took these products out of the monthly cash run, which was right — they
 * earn into their maturity value, not a transfer. But it also took them off the
 * SHEET, so ₹93,00,000 of real book went missing from the page ops reconcile
 * against. They are back as information-only rows.
 *
 * The thing that must never regress is the asymmetry: VISIBLE on the summary,
 * ABSENT from the NEFT file, and never written into a batch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const D = '2026-09-28';
let cumLineId = 0, cumAppNo = '', payAppNo = '';

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  const make = async (phone: string, name: string, amount: number) => {
    const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '7777000' + phone.slice(-4), ifsc: 'ICIC0001234', holder_name: name });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10' });
    await approveInvestment(await as('ncd@demo.local'), app);
    return Number(app.json.id);
  };
  const payId = await make('9611000001', 'Monthly Payer', 500000);
  const cumId = await make('9611000002', 'Doubling Holder', 400000);
  payAppNo = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [payId])).rows[0]!.application_no);
  cumAppNo = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [cumId])).rows[0]!.application_no);
  // What matters is the frequency previewDue filters on, not how it got there.
  await ctx.db.query("UPDATE application_lines SET payout_frequency = 'Cumulative' WHERE application_id = $1", [cumId]);
  cumLineId = Number((await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1', [cumId])).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const sheetOf = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer); return wb.worksheets[0]!;
};
const colOf = (ws: ExcelJS.Worksheet, name: string) => {
  const hdr = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim());
  const i = hdr.indexOf(name);
  if (i < 0) throw new Error(`no such column: ${name}`);
  // `hdr` and every row both come from ExcelJS `.values`, which is 1-based with
  // a leading hole — so this index already addresses a row directly.
  return i;
};

describe('a cumulative product on the sheet but not in the bank file', () => {
  it('shows on the preview with every money column at zero', async () => {
    const a = await admin();
    const due = (await a.get(`/api/payouts/preview?date=${D}`)).json as {
      count: number; customers: number; investments: number;
      totals: { gross: number; tds: number; net: number; total: number; outstanding: number };
      rows: Record<string, unknown>[] };
    const row = due.rows.find((r) => r.application_no === cumAppNo);
    expect(row, 'the cumulative investment must be ON the sheet').toBeTruthy();
    expect(row!.info_only).toBe(true);
    for (const f of ['gross_amount', 'tds_amount', 'net_amount', 'total_amount'])
      expect(Number(row![f]), `${f} must be zero`).toBe(0);
    // It says WHY it is at zero rather than reading as a missed payment.
    expect(String(row!.row_type)).toBe('Cumulative');

    // ...and it gates nothing: not the payable count, not the totals.
    const payable = due.rows.filter((r) => !r.info_only);
    expect(due.count).toBe(payable.length);
    expect(due.totals.gross).toBe(payable.reduce((t, r) => t + Number(r.gross_amount), 0));
    expect(due.investments).toBe(new Set(payable.filter((r) => !r.schedule_id).map((r) => r.application_id)).size);
  });

  it('prints its invested amount on the summary sheet, with 0 interest', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${D}`)).buffer);
    const cApp = colOf(ws, 'Application No'), cInv = colOf(ws, 'Invested (Rs)');
    const cGross = colOf(ws, 'Gross (Rs)'), cNet = colOf(ws, 'Net (Rs)'), cTotal = colOf(ws, 'Total (Rs)');
    let found: unknown[] | null = null, sawPayer = false;
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const v = r.values as unknown[];
      if (String(v[cApp] ?? '') === cumAppNo) found = v;
      if (String(v[cApp] ?? '') === payAppNo) sawPayer = true;
    });
    expect(sawPayer, 'the ordinary investment is still there').toBe(true);
    expect(found, 'the cumulative investment must appear on the summary').toBeTruthy();
    const v = found as unknown[];
    expect(Number(v[cInv])).toBe(400000);   // its money IS stated
    expect(Number(v[cGross])).toBe(0);
    expect(Number(v[cNet])).toBe(0);
    expect(Number(v[cTotal])).toBe(0);
  });

  it('is absent from the NEFT file', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/sheet.xlsx?date=${D}`)).buffer);
    const text: string[] = [];
    ws.eachRow((r) => text.push((r.values as unknown[]).map((x) => String(x ?? '')).join('|')));
    const blob = text.join('\n');
    expect(blob, 'the ordinary payee is in the bank file').toContain('77770000001');
    expect(blob, 'the cumulative holder must NOT be').not.toContain('77770000002');
    expect(blob).not.toContain('Doubling Holder');
  });

  it('is never written into a batch', async () => {
    const a = await admin();
    const batch = await a.post('/api/payouts', { payout_date: D });
    expect(batch.status).toBe(201);
    const id = Number(batch.json.id ?? batch.json.batch_id);
    const mine = await ctx.db.query(
      'SELECT count(*) AS n FROM disbursement_schedule WHERE line_id = $1 AND batch_id = $2', [cumLineId, id]);
    expect(Number(mine.rows[0]!.n), 'no schedule row may be materialised for it').toBe(0);
    // Nor did the run touch the line's existing rows — no batch stamped on any
    // of them, and none swept to 'Skipped' by the pro-rata supersede pass.
    const touched = await ctx.db.query(
      `SELECT count(*) FILTER (WHERE batch_id IS NOT NULL) AS batched,
              count(*) FILTER (WHERE status = 'Skipped')   AS skipped
         FROM disbursement_schedule WHERE line_id = $1`, [cumLineId]);
    expect(Number(touched.rows[0]!.batched)).toBe(0);
    expect(Number(touched.rows[0]!.skipped)).toBe(0);

    // ...and yet the SAVED batch's own summary still lists it (owner
    // 2026-10-27: "let it be in the sheet b also"). The preview sheet gets
    // these from previewDue; a saved batch is built from its schedule rows, and
    // this one has none — so it has to be added there separately, or the two
    // sheets would disagree about the same batch.
    const ws = await sheetOf((await a.raw(`/api/payouts/${id}/summary.xlsx`)).buffer);
    const cApp = colOf(ws, 'Application No'), cInv = colOf(ws, 'Invested (Rs)');
    const cTotal = colOf(ws, 'Total (Rs)');
    let row: unknown[] | null = null, sawPayer = false;
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const v = r.values as unknown[];
      if (String(v[cApp] ?? '') === cumAppNo) row = v;
      if (String(v[cApp] ?? '') === payAppNo) sawPayer = true;
    });
    expect(sawPayer, 'the paid investment is on the batch sheet').toBe(true);
    expect(row, 'and so is the cumulative one').toBeTruthy();
    expect(Number((row as unknown[])[cInv])).toBe(400000);
    expect(Number((row as unknown[])[cTotal])).toBe(0);
  });
});
