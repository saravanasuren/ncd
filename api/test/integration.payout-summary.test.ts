/**
 * Payout SUMMARY sheet (wealth parity) — the human companion to the bank NEFT
 * file. Its own server so batch creation here can't perturb the money-out
 * tests: each batch consumes the accrued interest, so these must not share.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

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
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12',
    });
    await approveInvestment(await as('ncd@demo.local'), app);
  }
});
afterAll(async () => { await ctx.close(); });

const HEADERS = [
  '#', 'Application No', 'Customer Name', 'DOB', 'Age', 'PAN', 'Gender', 'Category', 'Series', 'Type',
  'Invested (Rs)', 'Rate %', 'Beneficiary Name', 'Bank A/C', 'IFSC',
  'Interest From', 'Interest To', 'Days', 'Gross (Rs)', 'TDS (Rs)', 'Net (Rs)',
  'Addition (Rs)', 'Deduction (Rs)', 'Total (Rs)',
];

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets[0]!;
}

describe('preview documents agree (the mid-cycle 422)', () => {
  // The bug this pins: the summary/PDF used to read PROJECTED schedule rows
  // (due_date <= cut-off) while the NEFT sheet computes pro-rata accrual.
  // Projections sit on month-ends, so mid-cycle the summary 422'd "no interest
  // accrued" while the NEFT sheet for the same date produced hundreds of rows
  // — seen live 2026-07-23. All three previews must be views of one dataset.
  // A date a few days after interest starts — accrual exists, but the first
  // month-end projection hasn't come due, which is the state that 422'd live.
  let MID_CYCLE = '';
  beforeAll(async () => {
    MID_CYCLE = String((await ctx.db.query(
      `SELECT (min(COALESCE(a.interest_start_date, se.deemed_date))::date + 5)::text AS d
         FROM applications a JOIN series se ON se.id = a.series_id`)).rows[0]!.d).slice(0, 10);
  });

  it('summary + PDF produce for a mid-cycle date whenever the NEFT sheet does', async () => {
    const a = await admin();
    const neft = await a.raw(`/api/payouts/sheet.xlsx?date=${MID_CYCLE}`);
    expect(neft.status).toBe(200); // accrual exists → the pair must both work
    expect((await a.raw(`/api/payouts/preview.summary.xlsx?date=${MID_CYCLE}`)).status).toBe(200);
    expect((await a.raw(`/api/payouts/preview.pdf?date=${MID_CYCLE}`)).status).toBe(200);
  });

  it('summary row count equals the preview count for the same date', async () => {
    const a = await admin();
    const preview = await a.get(`/api/payouts/preview?date=${MID_CYCLE}`);
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${MID_CYCLE}`)).buffer);
    expect(ws.rowCount - 1).toBe(preview.json.count); // minus the header row
  });

  it('an EMPTY date param falls back to today instead of 422ing', async () => {
    // ?date= (cleared field) is an empty string — `?? today` never fires on it,
    // and an empty payoutDate compares before every watermark: previewDue
    // returned zero rows and the download dumped raw JSON at the user.
    const a = await admin();
    const today = new Date().toISOString().slice(0, 10);
    const empty = await a.get('/api/payouts/preview?date=');
    const explicit = await a.get(`/api/payouts/preview?date=${today}`);
    expect(empty.status).toBe(200);
    expect(empty.json.count).toBe(explicit.json.count);
    expect((await a.raw('/api/payouts/preview.summary.xlsx?date=')).status)
      .toBe((await a.raw(`/api/payouts/preview.summary.xlsx?date=${today}`)).status);
    expect((await a.raw('/api/payouts/sheet.xlsx?date=banana')).status)
      .toBe((await a.raw(`/api/payouts/sheet.xlsx?date=${today}`)).status);
  });
});

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
    expect(String(row.getCell(10).value)).toMatch(/^(Addition|Balance After Redemption|Redemption)$/); // Type ('Live' renamed, owner 2026-07-23)
    expect(Number(row.getCell(18).value)).toBeGreaterThan(0);                  // Days
    // Beneficiary Name comes from the BANK ACCOUNT's holder_name (owner #4),
    // not the customer record — joint/differently-named accounts must match.
    expect(String(row.getCell(13).value)).toMatch(/^Summary Cust/);
    // Gross = TDS + Net, all whole rupees — Net stays PURE interest; the paid
    // figure with adjustments lives in Total.
    expect(Number(row.getCell(19).value)).toBe(Number(row.getCell(20).value) + Number(row.getCell(21).value));
    for (const c of [19, 20, 21, 24]) expect(Number(row.getCell(c).value) % 1).toBe(0);
    // No adjustments in play here: Total == Net, Addition/Deduction zero.
    expect(Number(row.getCell(24).value)).toBe(Number(row.getCell(21).value));
    expect(Number(row.getCell(22).value)).toBe(0);
    expect(Number(row.getCell(23).value)).toBe(0);
  });

  it('Interest From precedes Interest To (the off-by-one wealth hit)', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    const ymd = (v: unknown) => { const [d, m, y] = String(v).split('/').map(Number); return Date.UTC(y!, m! - 1, d!); };
    for (let r = 2; r <= Math.min(ws.rowCount, 12); r++) {
      const from = ws.getRow(r).getCell(16).value;
      const to = ws.getRow(r).getCell(17).value;
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

  it('cut-off history is closed to own-scope staff and agents', async () => {
    // It reports BOOK-WIDE totals with no scoping, so dashboard:view (which
    // branch_staff hold) must not be enough.
    for (const who of ['staff@demo.local', 'agent@demo.local']) {
      expect((await (await as(who)).get('/api/payouts/cutoff-history')).status).toBe(403);
    }
    // The report downloaders and the payout maker do get it.
    for (const who of ['cxo@demo.local', 'ncd@demo.local']) {
      expect((await (await as(who)).get('/api/payouts/cutoff-history')).status).toBe(200);
    }
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

// Owner 2026-07-24: a month's redemptions belong in THAT month's payout sheet.
// The redemption transfer pays principal only; the broken-period interest is
// swept into the interest batch and shown as a 'Redemption' row.
describe('redemption interest lands in that month\'s payout sheet', () => {
  let appId = 0, redDate = '';

  it('the redemption transfer pays principal only — interest is left for the batch', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Redeeming Investor', phone: '9600000031' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660009999', ifsc: 'ICIC0001234', holder_name: 'Redeeming Investor' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-12',
    });
    appId = Number(app.json.id);
    await approveInvestment(await as('ncd@demo.local'), app);

    // Redeem mid-cycle so a real broken-period slice accrues.
    redDate = '2026-09-15';
    const red = await a.post('/api/redemptions/premature', { application_id: appId, reason: 'exit', redemption_date: redDate });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const r = (await ctx.db.query('SELECT principal, penalty, net_payment, broken_interest, broken_tds FROM redemptions WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(r.broken_interest)).toBeGreaterThan(0);          // interest really accrued
    // net_payment is principal − penalty ONLY; the interest is NOT bundled in.
    expect(Number(r.net_payment)).toBe(Number(r.principal) - Number(r.penalty));

    // …and it is waiting as a Scheduled BrokenInterest row for the batch.
    const slice = (await ctx.db.query(
      "SELECT gross_amount, tds_amount, net_amount, status, batch_id FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date", [appId, redDate])).rows[0] as any;
    expect(slice.status).toBe('Scheduled');
    expect(slice.batch_id).toBeNull();
    expect(Number(slice.gross_amount)).toBe(Number(r.broken_interest));
    expect(Number(slice.tds_amount)).toBe(Number(r.broken_tds));
  });

  it("that month's batch sweeps it and the sheet types it 'Redemption'", async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-09-28' }); // the month it was redeemed in
    expect(batch.status).toBe(201);

    // The slice is now attached to the batch, not orphaned.
    const slice = (await ctx.db.query(
      "SELECT batch_id, status FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date", [appId, redDate])).rows[0] as any;
    expect(Number(slice.batch_id)).toBe(Number(batch.json.batch_id));
    expect(slice.status).not.toBe('Skipped');   // it must NOT be superseded away

    const ws = await sheetOf((await a.raw(`/api/payouts/${batch.json.batch_id}/summary.xlsx`)).buffer);
    const types = new Set<string>();
    let found = null as null | { from: unknown; to: unknown; gross: number };
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      types.add(String(row.getCell(10).value));
      if (String(row.getCell(3).value) === 'Redeeming Investor' && String(row.getCell(10).value) === 'Redemption') {
        found = { from: row.getCell(16).value, to: row.getCell(17).value, gross: Number(row.getCell(19).value) };
      }
    }
    expect(types.has('Redemption')).toBe(true);   // the third type finally appears
    expect(found).toBeTruthy();
    expect(found!.gross).toBeGreaterThan(0);
    expect(String(found!.from)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);  // dates present, not blank
    expect(String(found!.to)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  // Wealth parity (_segmentSummaryRows): a redemption slice prints the principal
  // it was EARNED on and stops the day BEFORE the redemption date — the row is
  // interest up to the exit, not interest on the exit day.
  it('the Redemption row carries its own principal basis and ends the day before the exit', async () => {
    const a = await admin();
    const basis = (await ctx.db.query(
      "SELECT principal_basis FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date",
      [appId, redDate])).rows[0] as any;
    expect(Number(basis.principal_basis)).toBe(1000000);   // stamped at approval

    const batchId = Number((await ctx.db.query(
      "SELECT batch_id FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date",
      [appId, redDate])).rows[0]!.batch_id);
    const ws = await sheetOf((await a.raw(`/api/payouts/${batchId}/summary.xlsx`)).buffer);
    let row: ExcelJS.Row | null = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      if (String(ws.getRow(r).getCell(10).value) === 'Redemption'
        && String(ws.getRow(r).getCell(3).value) === 'Redeeming Investor') row = ws.getRow(r);
    }
    expect(row).toBeTruthy();
    expect(Number(row!.getCell(11).value)).toBe(1000000);  // Invested = the basis, not the face amount
    expect(String(row!.getCell(17).value)).toBe('14/09/2026'); // Interest To = redemption date − 1
  });
});

/**
 * A rejected batch must give the redemption slice BACK, not destroy it. The
 * batch never creates a BrokenInterest row — it attaches one the redemption
 * approval wrote — so the reject handler's blanket "delete this batch's
 * still-Scheduled rows" was deleting the customer's broken-period interest
 * outright: gone from the schedule, unpayable by any later batch, and silently
 * absent from every future summary sheet.
 */
describe('a rejected batch releases the redemption slice instead of deleting it', () => {
  it('the slice survives the reject, unbatched and still Scheduled', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const ncd = await as('ncd@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Rejected Batch Investor', phone: '9600000032' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660008888', ifsc: 'ICIC0001234', holder_name: 'Rejected Batch Investor' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-12',
    });
    const id = Number(app.json.id);
    await approveInvestment(ncd, app);

    const rDate = '2026-11-15';
    const red = await a.post('/api/redemptions/premature', { application_id: id, reason: 'exit', redemption_date: rDate });
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);
    const before = (await ctx.db.query(
      "SELECT id, gross_amount FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date", [id, rDate])).rows[0] as any;
    expect(Number(before.gross_amount)).toBeGreaterThan(0);

    const batch = await ncd.post('/api/payouts', { payout_date: '2026-11-28' });
    expect(batch.status).toBe(201);
    await a.post(`/api/approvals/${batch.json.request.id}/reject`, { reason: 'wrong cut-off date' });

    const after = (await ctx.db.query(
      'SELECT status, batch_id, gross_amount FROM disbursement_schedule WHERE id = $1', [Number(before.id)])).rows[0] as any;
    expect(after).toBeTruthy();                       // NOT deleted
    expect(after.status).toBe('Scheduled');
    expect(after.batch_id).toBeNull();                // free for the next batch
    expect(Number(after.gross_amount)).toBe(Number(before.gross_amount));

    // …and the next batch really does pick it up again.
    const retry = await ncd.post('/api/payouts', { payout_date: '2026-11-30' });
    expect(retry.status).toBe(201);
    expect(Number((await ctx.db.query('SELECT batch_id FROM disbursement_schedule WHERE id = $1', [Number(before.id)])).rows[0]!.batch_id))
      .toBe(Number(retry.json.batch_id));
  });
});

/**
 * Sheet ORDER: previewDue builds regular interest and redemption slices in two
 * separate passes, so unsorted every Redemption row piles up at the bottom of
 * the sheet, detached from the customer it belongs to. Wealth groups each
 * application's rows together, interest first, slices under it.
 */
describe('a customer\'s redemption row sits with their interest rows', () => {
  it('the preview sheet groups by customer, not by row type', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const ncd = await as('ncd@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    // Two investors. The one that PART-redeems sorts BEFORE the other, so its
    // Redemption row must sit next to its own interest row — not shoved past
    // the later customer to the bottom of the sheet.
    const mk = async (name: string, phone: string) => {
      const cust = await a.post('/api/customers', { full_name: name, phone });
      await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '6666' + phone, ifsc: 'ICIC0001234', holder_name: name });
      const app = await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-12',
      });
      await approveInvestment(ncd, app);
      return Number(app.json.id);
    };
    const midId = await mk('Order Mid Investor', '9600000041');
    await mk('Order Zed Investor', '9600000042');

    // A PARTIAL exit: the line stays live, so this customer has both a regular
    // interest row and a redemption slice in the same sheet.
    const red = await a.post('/api/redemptions/premature', {
      application_id: midId, reason: 'part exit', redemption_date: '2027-01-15', amount: 400000,
    });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const preview = await a.get('/api/payouts/preview?date=2027-01-28');
    const rows = preview.json.rows as Array<{ customer_name: string; row_type?: string }>;
    const mine = rows.filter((r) => String(r.customer_name).startsWith('Order '));
    expect(mine.some((r) => r.row_type === 'Redemption')).toBe(true);

    // Every customer's rows are contiguous — a name never reappears after
    // someone else's row, which is exactly what the two-pass build produced.
    const names = rows.map((r) => r.customer_name);
    const firstSeen = new Map<string, number>();
    names.forEach((n, i) => { if (!firstSeen.has(n)) firstSeen.set(n, i); });
    for (const [n, start] of firstSeen) {
      const last = names.lastIndexOf(n);
      for (let i = start; i <= last; i++) expect(names[i]).toBe(n);
    }
    // Specifically: the redemption slice did not get stranded after Zed's row.
    expect(names.lastIndexOf('Order Mid Investor')).toBeLessThan(names.indexOf('Order Zed Investor'));
  });
});
