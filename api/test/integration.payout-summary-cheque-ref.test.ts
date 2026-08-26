/**
 * Cheque / UTR reference on the payout summary sheet (owner 2026-08-26).
 *
 * The rule the owner asked for, and the reason for it: a row that settles ONE
 * tranche names the cheque/UTR that brought that money in. Once a clubbed
 * investment's tranches fold into a single debenture line, that row covers
 * several cheques — so it names none of them, and its Payment Mode reads
 * 'Multiple tranches' instead.
 *
 * The trap this pins down: the sheet used to take Payment Mode from
 * `applications.collection_method`, which holds only the FIRST credit's detail
 * (migration 054). A second tranche's row therefore advertised the first
 * tranche's payment method — and would have sat next to the second tranche's
 * reference, describing two different payments.
 *
 * Its own server: creating batches here consumes accrued interest, which would
 * starve the other payout tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
let clubbedAppNo: string, soloAppNo: string;

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** The three tranches of the clubbed investment, each paid its own way. */
const TRANCHES = [
  { amount: 100000, collection_method: 'Cheque',    collection_reference: 'CHQ-000111' },
  { amount: 100000, collection_method: 'NEFT/RTGS', collection_reference: 'UTR-000222' },
  { amount: 100000, collection_method: 'IMPS',      collection_reference: 'IMPS-000333' },
];
const SOLO_REF = 'SOLO-000999';

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();

  // A clubbed investment: three tranches, three different payments, ONE debenture.
  const cust = await a.post('/api/customers', { full_name: 'Cheque Clubbed', phone: '9703000001' });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '610000001', ifsc: 'ICIC0001234', holder_name: 'Cheque Clubbed' });
  const first = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    date_money_received: '2026-07-05', ...TRANCHES[0],
  });
  clubbedAppNo = String(first.json.application_no);
  for (const t of TRANCHES.slice(1)) {
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      date_money_received: '2026-07-05', club_with_application_id: Number(first.json.id), ...t,
    });
    expect(club.json.clubbed).toBe(true);
  }
  await approveInvestment(await as('ncd@demo.local'), first);

  // Control: an ordinary one-payment investment. It must be untouched by all this.
  const cust2 = await a.post('/api/customers', { full_name: 'Cheque Solo', phone: '9703000002' });
  await a.post(`/api/customers/${cust2.json.id}/bank-accounts`, { account_number: '610000002', ifsc: 'ICIC0001234', holder_name: 'Cheque Solo' });
  const solo = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust2.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: '2026-07-05',
    collection_method: 'Cheque', collection_reference: SOLO_REF,
  });
  soloAppNo = String(solo.json.application_no);
  await approveInvestment(await as('ncd@demo.local'), solo);
});
afterAll(async () => { await ctx.close(); });

const sheetOf = async (buf: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb.worksheets[0]!;
};
/** Resolve a column by HEADER, never by number — the whole point of this change
 *  is that column positions move when someone adds a column. */
const colOf = (ws: ExcelJS.Worksheet, name: string): number => {
  const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const i = headers.indexOf(name);
  if (i < 0) throw new Error(`no such column: ${name} (have: ${headers.filter(Boolean).join(', ')})`);
  return i;
};
/** Every row of the sheet belonging to one application, as {header: value}. */
const rowsFor = (ws: ExcelJS.Worksheet, appNo: string) => {
  const appCol = colOf(ws, 'Application No');
  const out: Record<string, unknown>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    if (String(ws.getRow(r).getCell(appCol).value) !== appNo) continue;
    out.push({
      mode: ws.getRow(r).getCell(colOf(ws, 'Payment Mode')).value,
      ref: ws.getRow(r).getCell(colOf(ws, 'Cheque / Ref No')).value,
      invested: ws.getRow(r).getCell(colOf(ws, 'Invested (Rs)')).value,
    });
  }
  return out;
};
const previewSheet = async (date: string) =>
  sheetOf((await (await admin()).raw(`/api/payouts/preview.summary.xlsx?date=${date}`)).buffer);

describe('cheque / UTR reference on the summary sheet', () => {
  it('sits immediately after Payment Mode, and appends rather than shifting any existing column', async () => {
    const ws = await previewSheet('2026-07-28');
    expect(colOf(ws, 'Cheque / Ref No')).toBe(colOf(ws, 'Payment Mode') + 1);
    // Appended at the END: the Federal-file reconciliation depends on the
    // earlier columns keeping their index, so nothing may sit after it.
    const headers = (ws.getRow(1).values as unknown[]).filter(Boolean);
    expect(headers[headers.length - 1]).toBe('Cheque / Ref No');
  });

  it('an ordinary one-payment investment shows its own cheque number and method', async () => {
    const rows = rowsFor(await previewSheet('2026-07-28'), soloAppNo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(SOLO_REF);
    expect(rows[0]!.mode).toBe('Cheque');
  });

  it('while each tranche is still in its own broken period, every row names ITS OWN payment', async () => {
    // This is the regression the change fixes: all three rows used to show the
    // FIRST tranche's method, because the sheet read applications.collection_*.
    const rows = rowsFor(await previewSheet('2026-07-28'), clubbedAppNo);
    expect(rows).toHaveLength(TRANCHES.length);
    expect(rows.map((r) => r.ref).sort()).toEqual(TRANCHES.map((t) => t.collection_reference).sort());
    expect(rows.map((r) => r.mode).sort()).toEqual(TRANCHES.map((t) => t.collection_method).sort());
  });

  it('once the tranches fold into one debenture line, the row says "Multiple tranches" and names no cheque', async () => {
    // Settle every broken period, which is what makes the tranches foldable.
    await ctx.db.query(
      `UPDATE disbursement_schedule ds SET status = 'Paid', paid_at = '2026-07-28'
         FROM application_lines l, applications a
        WHERE ds.line_id = l.id AND l.application_id = a.id
          AND ds.due_date = '2026-07-28' AND ds.due_type IN ('Interest','BrokenInterest')`);

    const ws = await previewSheet('2026-08-28');
    const clubbed = rowsFor(ws, clubbedAppNo);
    expect(clubbed).toHaveLength(1);                       // folded into one
    expect(Number(clubbed[0]!.invested)).toBe(300000);     // ...covering all three tranches
    expect(clubbed[0]!.mode).toBe('Multiple tranches');
    expect(clubbed[0]!.ref ?? '').toBe('');                // no single cheque is truthful here

    // The control never folds — a group of one — so it still names its cheque.
    const solo = rowsFor(ws, soloAppNo);
    expect(solo).toHaveLength(1);
    expect(solo[0]!.ref).toBe(SOLO_REF);
    expect(solo[0]!.mode).toBe('Cheque');
  });

  it('a saved batch reaches the same answer as the preview it was made from', async () => {
    // The two sheets are built by different queries — the preview consolidates
    // in memory, the saved batch detects folded siblings in SQL. Ops reconcile
    // them against each other, so they must agree cell for cell here.
    const before = rowsFor(await previewSheet('2026-09-28'), clubbedAppNo);
    const batch = await (await as('ncd@demo.local')).post('/api/payouts', { payout_date: '2026-09-28' });
    expect(batch.status).toBe(201);
    const ws = await sheetOf((await (await admin()).raw(`/api/payouts/${batch.json.batch_id}/summary.xlsx`)).buffer);

    const clubbed = rowsFor(ws, clubbedAppNo);
    expect(clubbed).toHaveLength(1);
    expect(clubbed[0]!.mode).toBe('Multiple tranches');
    expect(clubbed[0]!.ref ?? '').toBe('');
    expect(clubbed[0]!.mode).toBe(before[0]!.mode);

    const solo = rowsFor(ws, soloAppNo);
    expect(solo[0]!.ref).toBe(SOLO_REF);
    expect(solo[0]!.mode).toBe('Cheque');
  });
});
