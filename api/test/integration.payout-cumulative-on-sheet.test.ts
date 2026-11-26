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
import { accruedAtMaturity } from '../src/lib/interest.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const D = '2026-09-28';
// The Accrued tests run AFTER the batch above is cut for D, which settles that
// date — a second preview for it has nothing due and 422s. They use the next
// payout day instead, where the monthly line has accrued again.
const D2 = '2026-10-28';
let cumLineId = 0, cumAppNo = '', payAppNo = '', dblAppNo = '', dblLineId = 0;

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

  // A Doubling holding proper — 20% over 60 months, at maturity. This is the
  // one the Accrued column exists for (owner 2026-11-26).
  const dblId = await make('9611000003', 'Accruing Doubler', 1000000);
  dblAppNo = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [dblId])).rows[0]!.application_no);
  await ctx.db.query(
    `UPDATE application_lines SET payout_frequency = 'AtMaturity', coupon_rate_pct = 20,
            tenure_months = 60, maturity_date = '2031-07-31'
      WHERE application_id = $1`, [dblId]);
  dblLineId = Number((await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1', [dblId])).rows[0]!.id);
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

/**
 * ACCRUED, BUT STILL NOT PAYABLE (owner 2026-11-26):
 *
 *   "additionally - in the summary sheet ill be needing their accured interest
 *    as on date but no interest should be going to them in the payout."
 *
 * So the sheet gains ONE column and loses nothing: Gross/TDS/Net/Total stay at
 * zero on these rows, the NEFT file still cannot see them, and no total moves.
 * The arithmetic itself is pinned in interest.test.ts against the ten live
 * investments; what matters here is that the sheet is wired to it — reading the
 * right dates, for the right as-on date.
 */
describe('the Accrued column', () => {
  it('is appended last, so every existing column keeps its position', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${D2}`)).buffer);
    const hdr = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? '').trim()).filter(Boolean);
    expect(hdr[hdr.length - 1]).toBe('Accrued (Rs)');
    // Ops reconcile this sheet against the bank file by position — the money
    // block must not have shifted to make room.
    expect(hdr.indexOf('Gross (Rs)')).toBeLessThan(hdr.indexOf('Net (Rs)'));
    expect(hdr.indexOf('Total (Rs)')).toBe(hdr.indexOf('Net (Rs)') + 3);
  });

  it('states what the Doubling holding has earned, while paying it nothing', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${D2}`)).buffer);
    const cApp = colOf(ws, 'Application No'), cAcc = colOf(ws, 'Accrued (Rs)');
    const cInv = colOf(ws, 'Invested (Rs)'), cGross = colOf(ws, 'Gross (Rs)');
    const cNet = colOf(ws, 'Net (Rs)'), cTotal = colOf(ws, 'Total (Rs)');
    let dbl: unknown[] | null = null, payer: unknown[] | null = null;
    ws.eachRow((r, n) => {
      if (n === 1) return;
      const v = r.values as unknown[];
      if (String(v[cApp] ?? '') === dblAppNo) dbl = v;
      if (String(v[cApp] ?? '') === payAppNo) payer = v;
    });
    expect(dbl, 'the Doubling holding is on the sheet').toBeTruthy();
    const v = dbl as unknown[];

    // Its money is stated, something has accrued on it...
    expect(Number(v[cInv])).toBe(1000000);
    expect(Number(v[cAcc]), 'interest has been earned').toBeGreaterThan(0);

    // ...and it is the figure the engine computes from this line's own dates,
    // valued at the sheet's date — which is what proves the wiring, not the
    // arithmetic (that is pinned in interest.test.ts).
    const line = (await ctx.db.query(
      `SELECT l.outstanding_amount, l.coupon_rate_pct, l.tenure_months, l.day_count_convention,
              l.maturity_date::text AS mat, l.date_money_received::text AS money,
              s.deemed_date::text AS deemed
         FROM application_lines l JOIN applications a ON a.id = l.application_id
         LEFT JOIN series s ON s.id = a.series_id WHERE l.id = $1`, [dblLineId])).rows[0]!;
    const expected = accruedAtMaturity({
      principal: Number(line.outstanding_amount), ratePct: line.coupon_rate_pct,
      tenureMonths: line.tenure_months, interestStartDate: line.money,
      seriesDeemedDate: line.deemed, maturityDate: line.mat, asOf: D2,
    }).interest;
    expect(Number(v[cAcc])).toBe(Math.round(expected));

    // NOT ONE RUPEE IS PAYABLE. This is the whole point of the column.
    expect(Number(v[cGross])).toBe(0);
    expect(Number(v[cNet])).toBe(0);
    expect(Number(v[cTotal])).toBe(0);

    // A cash row leaves it blank: there, the accrued interest IS the Gross
    // beside it, and repeating it would read as a second amount owed.
    expect(payer, 'the ordinary payer is still on the sheet').toBeTruthy();
    expect(String((payer as unknown[])[cAcc] ?? '')).toBe('');
  });

  it('adds nothing to any total, and still never reaches the bank file', async () => {
    const a = await admin();
    const due = (await a.get(`/api/payouts/preview?date=${D2}`)).json as {
      count: number; totals: { gross: number; net: number; total: number };
      rows: Record<string, unknown>[] };
    const row = due.rows.find((r) => r.application_no === dblAppNo)!;
    expect(Number(row.accrued_amount), 'the figure is on the row').toBeGreaterThan(0);
    expect(row.info_only).toBe(true);

    // Totals are the payable rows and nothing else.
    const payable = due.rows.filter((r) => !r.info_only);
    expect(due.count).toBe(payable.length);
    expect(due.totals.gross).toBe(payable.reduce((t, r) => t + Number(r.gross_amount), 0));
    expect(due.totals.total).toBe(payable.reduce((t, r) => t + Number(r.total_amount), 0));

    const neft = await sheetOf((await a.raw(`/api/payouts/sheet.xlsx?date=${D2}`)).buffer);
    const blob: string[] = [];
    neft.eachRow((r) => blob.push((r.values as unknown[]).map((x) => String(x ?? '')).join('|')));
    expect(blob.join('\n'), 'accruing, not paying').not.toContain('Accruing Doubler');
  });
});

/**
 * THE DOUBLING LINE ON THE PAYOUT SCREEN (owner 2026-11-26: "in the payout
 * table i need a seperate line in the last row which says the amount in the
 * doubling scheme, no of ncd in doubling scheme, no of customers, and accrued
 * interest … just a seperate line to easily know how much is in doubling
 * scheme and how much is the accured int as on date").
 *
 * A LINE, not a column and not a total. The whole point of these rows is that
 * their money is not leaving the bank, so the figure must sit beside the
 * payable totals without ever being added to them.
 */
describe('the Doubling summary line', () => {
  it('states the amount, the NCDs, the customers and the accrued interest', async () => {
    const a = await admin();
    const due = (await a.get(`/api/payouts/preview?date=${D2}`)).json as {
      doubling: { amount: number; accrued: number; investments: number; customers: number };
      rows: Record<string, unknown>[] };

    const info = due.rows.filter((r) => r.info_only);
    expect(info.length).toBeGreaterThan(1);   // the Cumulative one and the Doubling one

    // Every figure is the rows underneath it, totalled — so the line and the
    // sheet can never quote different numbers.
    expect(due.doubling.amount).toBeGreaterThan(0);
    expect(due.doubling.investments).toBe(new Set(info.map((r) => r.application_id)).size);
    expect(due.doubling.customers).toBe(new Set(info.map((r) => r.customer_id)).size);
    expect(due.doubling.accrued)
      .toBeCloseTo(info.reduce((t, r) => t + Number(r.accrued_amount ?? 0), 0), 2);
    // Accrued is what has been EARNED so far, so it is less than the principal.
    expect(due.doubling.accrued).toBeLessThan(due.doubling.amount);
  });

  it('is added to NO total — this money is not leaving the bank', async () => {
    const a = await admin();
    const due = (await a.get(`/api/payouts/preview?date=${D2}`)).json as {
      count: number; customers: number; investments: number;
      doubling: { amount: number; accrued: number; investments: number };
      totals: { gross: number; net: number; total: number; outstanding: number };
      rows: Record<string, unknown>[] };
    const payable = due.rows.filter((r) => !r.info_only);

    expect(due.totals.gross).toBe(payable.reduce((t, r) => t + Number(r.gross_amount), 0));
    expect(due.totals.total).toBe(payable.reduce((t, r) => t + Number(r.total_amount), 0));
    expect(due.count).toBe(payable.length);
    // The counts beside the payable totals stay the payable ones — the owner
    // asked for a separate line, not for the existing figures to move.
    expect(due.investments).toBe(
      new Set(payable.filter((r) => !r.schedule_id).map((r) => r.application_id)).size);
    expect(due.doubling.investments).toBeGreaterThan(0);
  });
});
