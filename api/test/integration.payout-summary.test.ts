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
  // Branch sits beside Referred By (owner 2026-08-25) — inserted, so everything
  // after it shifts one place right. This list IS the contract for that order.
  '#', 'Application No', 'Customer Name', 'Referred By', 'Branch', 'DOB', 'Age', 'PAN', 'Gender', 'Category', 'Series', 'Type',
  'Invested (Rs)', 'Rate %', 'Beneficiary Name', 'Bank A/C', 'IFSC',
  'Interest From', 'Interest To', 'Days', 'Gross (Rs)', 'TDS (Rs)', 'Net (Rs)',
  'Addition (Rs)', 'Deduction (Rs)', 'Total (Rs)', 'Phone', 'Payment Mode',
];

/** Column index BY HEADER NAME. The sheet has had two columns inserted mid-way
 *  (Referred By, then Branch); indexing by number meant every insert silently
 *  repointed these assertions at neighbouring data. Resolve by name instead. */
const C = (name: string): number => {
  const i = HEADERS.indexOf(name);
  if (i < 0) throw new Error(`no such column: ${name}`);
  return i + 1;
};

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
    expect(String(row.getCell(C('Application No')).value)).toMatch(/^APP-/);                     // Application No
    expect(String(row.getCell(C('Type')).value)).toMatch(/^(Addition|Balance After Redemption|Redemption)$/); // Type ('Live' renamed, owner 2026-07-23)
    expect(Number(row.getCell(C('Days')).value)).toBeGreaterThan(0);                  // Days
    // Beneficiary Name comes from the BANK ACCOUNT's holder_name (owner #4),
    // not the customer record — joint/differently-named accounts must match.
    expect(String(row.getCell(C('Beneficiary Name')).value)).toMatch(/^Summary Cust/);
    // Gross = TDS + Net, all whole rupees — Net stays PURE interest; the paid
    // figure with adjustments lives in Total.
    expect(Number(row.getCell(C('Gross (Rs)')).value)).toBe(Number(row.getCell(C('TDS (Rs)')).value) + Number(row.getCell(C('Net (Rs)')).value));
    for (const c of ['Gross (Rs)', 'TDS (Rs)', 'Net (Rs)', 'Total (Rs)'].map(C)) expect(Number(row.getCell(c).value) % 1).toBe(0);
    // No adjustments in play here: Total == Net, Addition/Deduction zero.
    expect(Number(row.getCell(C('Total (Rs)')).value)).toBe(Number(row.getCell(C('Net (Rs)')).value));
    expect(Number(row.getCell(C('Addition (Rs)')).value)).toBe(0);
    expect(Number(row.getCell(C('Deduction (Rs)')).value)).toBe(0);
    // Owner 2026-07-27: Phone + Payment Mode, appended (not inserted) so every
    // existing column keeps its position for Federal Net reconciliation.
    expect(String(row.getCell(C('Phone')).value)).toMatch(/^9600000\d{3}$/);
    expect(String(row.getCell(C('Payment Mode')).value)).toBe('NEFT/RTGS');
  });

  // Owner 2026-08-25: "bring in branch names in the payouts summary sheet as a
  // column next to referred by". The branch comes from applications.branch_id —
  // the branch that EARNED the investment, stamped at creation from the
  // referrer's branch — NOT the customer's current branch, which moves if they
  // are reassigned. Same source the Branch-wise report reads.
  it('Branch sits next to Referred By and names the branch that earned it', async () => {
    const a = await admin();
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const branchId = Number((await ctx.db.query(
      `INSERT INTO branches (code, name) VALUES ('BRSUM','Summary Branch') RETURNING id`)).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Branch Investor', phone: '9600000077' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000, date_money_received: '2026-07-12',
    });
    await approveInvestment(await as('ncd@demo.local'), app);
    // The branch is stamped on the APPLICATION at creation; set it directly so
    // the test pins where the sheet reads from, not how it got there.
    await ctx.db.query('UPDATE applications SET branch_id = $2 WHERE id = $1', [app.json.id, branchId]);

    // The header lands immediately after Referred By — the position asked for.
    expect(C('Branch')).toBe(C('Referred By') + 1);

    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    let seen: unknown = undefined;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Branch Investor') seen = row.getCell(C('Branch')).value;
    }
    expect(seen).toBe('Summary Branch');
  });

  it('an investment with no branch leaves the cell blank, never the word null', async () => {
    const a = await admin();
    const res = await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`);
    const ws = await sheetOf(res.buffer);
    for (let r = 2; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).getCell(C('Branch')).value;
      expect(String(v ?? '')).not.toMatch(/^(null|undefined)$/);
    }
  });

  // Owner 2026-07-27: Referred By sits right after Customer Name (inserted,
  // not appended — an explicit position request, unlike Phone/Payment Mode).
  // Resolves through the SAME REFERRER rule as the rest of the app (staff/
  // agent CODE first, name as legacy fallback) — not the raw stored text.
  it('Referred By resolves the agent CODE to their current display name', async () => {
    const a = await admin();
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const ag = await a.post('/api/agents', { full_name: 'Summary Referrer Agent', agent_code: 'AG-SUM1' });
    expect(ag.status).toBe(201);
    const cust = await a.post('/api/customers', {
      full_name: 'Referred Investor', phone: '9600000099', referred_by_text: 'AG-SUM1',
    });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000, date_money_received: '2026-07-12',
    });
    await approveInvestment(await as('ncd@demo.local'), app);

    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    let referredBy: unknown = undefined;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Referred Investor') referredBy = row.getCell(C('Referred By')).value;
    }
    expect(referredBy).toBe('Summary Referrer Agent'); // the agent's NAME, not the code 'AG-SUM1'
  });

  it('Interest From precedes Interest To (the off-by-one wealth hit)', async () => {
    const a = await admin();
    const ws = await sheetOf((await a.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    // Owner 2026-07-27: this sheet's dates are dd-mm-yyyy (hyphens), NOT the
    // NEFT sheet's dd/mm/yyyy — do not "fix" this split back to '/'.
    const ymd = (v: unknown) => { const [d, m, y] = String(v).split('-').map(Number); return Date.UTC(y!, m! - 1, d!); };
    for (let r = 2; r <= Math.min(ws.rowCount, 12); r++) {
      const from = ws.getRow(r).getCell(C('Interest From')).value;
      const to = ws.getRow(r).getCell(C('Interest To')).value;
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
      types.add(String(row.getCell(C('Type')).value));
      if (String(row.getCell(C('Customer Name')).value) === 'Redeeming Investor' && String(row.getCell(C('Type')).value) === 'Redemption') {
        found = { from: row.getCell(C('Interest From')).value, to: row.getCell(C('Interest To')).value, gross: Number(row.getCell(C('Gross (Rs)')).value) };
      }
    }
    expect(types.has('Redemption')).toBe(true);   // the third type finally appears
    expect(found).toBeTruthy();
    expect(found!.gross).toBeGreaterThan(0);
    expect(String(found!.from)).toMatch(/^\d{2}-\d{2}-\d{4}$/);  // dates present, not blank (dd-mm-yyyy, owner 2026-07-27)
    expect(String(found!.to)).toMatch(/^\d{2}-\d{2}-\d{4}$/);
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
      if (String(ws.getRow(r).getCell(C('Type')).value) === 'Redemption'
        && String(ws.getRow(r).getCell(C('Customer Name')).value) === 'Redeeming Investor') row = ws.getRow(r);
    }
    expect(row).toBeTruthy();
    expect(Number(row!.getCell(C('Invested (Rs)')).value)).toBe(1000000);  // Invested = the basis, not the face amount
    expect(String(row!.getCell(C('Interest To')).value)).toBe('14-09-2026'); // Interest To = redemption date − 1 (dd-mm-yyyy, owner 2026-07-27)
  });
});

/**
 * Found live 2026-07-27: every redemption slice's "Interest From" showed the
 * SAME wrong date — the line's last-paid anchor itself, regardless of the
 * slice's own due_date. "Interest To" (period_to) was correctly printed as
 * due_date − 1, but "days" was computed from the raw due_date, so working
 * backward from period_to by (days − 1) always landed exactly one day short
 * of the real start — the two off-by-ones cancelled out and hid the bug
 * behind an internally-consistent-looking (but wrong) pair of dates.
 * This fixture has a REAL prior paid cycle before redeeming (unlike the
 * fixture above, whose "last paid" falls back to interest_start_date) — that
 * prior-paid-anchor path was the one actually broken.
 */
describe('a redemption slice\'s "Interest From" starts the day AFTER the line was last paid', () => {
  it('with a multi-day gap between the last paid cycle and the redemption', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const ncd = await as('ncd@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Gap Redeemer', phone: '9600000071' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660007171', ifsc: 'ICIC0001234', holder_name: 'Gap Redeemer' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-12',
    });
    const appId = Number(app.json.id);
    await approveInvestment(ncd, app);

    // Pay one real cycle, so the line has a genuine PAID watermark — the
    // exact anchor the bug's "last-paid" path depends on. A fixed date (not
    // NEXT_CUTOFF()) — this file's own month counter runs out partway through
    // the suite, and '2026-07-28' isn't claimed by any other test here.
    const payDate = '2026-07-28';
    const batch = await ncd.post('/api/payouts', { payout_date: payDate });
    expect(batch.status).toBe(201);
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    // Redeem 11 days after that paid cutoff — a real multi-day gap.
    const [y, m, d] = payDate.split('-').map(Number);
    const redDate = new Date(Date.UTC(y!, m! - 1, d! + 11)).toISOString().slice(0, 10);
    const red = await a.post('/api/redemptions/premature', { application_id: appId, reason: 'exit', redemption_date: redDate });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const redBatchDate = new Date(Date.UTC(y!, m! - 1, d! + 12)).toISOString().slice(0, 10); // next-day cutoff sweeps it
    const redBatch = await ncd.post('/api/payouts', { payout_date: redBatchDate });
    expect(redBatch.status).toBe(201);

    const ws = await sheetOf((await a.raw(`/api/payouts/${redBatch.json.batch_id}/summary.xlsx`)).buffer);
    let from: unknown = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Gap Redeemer' && String(row.getCell(C('Type')).value) === 'Redemption') from = row.getCell(C('Interest From')).value;
    }
    const expectedFrom = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10); // day AFTER the paid cutoff
    const [ey, em, ed] = expectedFrom.split('-');
    expect(String(from)).toBe(`${ed}-${em}-${ey}`); // NOT the paid cutoff date itself
  });
});

/**
 * Owner 2026-07-27 (repeated instruction — do not remove this again): a
 * redemption slice belongs to the month it fell due in even when its broken
 * interest is genuinely ₹0 (redeemed the day right after the last regular
 * payout, so nothing new accrued). It must still show on that month's
 * summary sheet, paid at ₹0 — not silently disappear because a `gross > 0`
 * filter treated "nothing owed" the same as "no such row".
 */
describe('a zero-interest redemption slice still shows on its month\'s sheet, not silently dropped', () => {
  it('redeemed the day right after the last paid cycle — ₹0, but still a row', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const ncd = await as('ncd@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Zero Gap Redeemer', phone: '9600000072' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660007272', ifsc: 'ICIC0001234', holder_name: 'Zero Gap Redeemer' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-08-12',
    });
    const appId = Number(app.json.id);
    await approveInvestment(ncd, app);

    const payDate = '2026-08-28';
    const batch = await ncd.post('/api/payouts', { payout_date: payDate });
    expect(batch.status).toBe(201);
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    // Redeem the VERY NEXT DAY — last paid through 28-Aug, redemption stops
    // the day before it (still 28-Aug), so zero new days have accrued.
    const redDate = '2026-08-29';
    const red = await a.post('/api/redemptions/premature', { application_id: appId, reason: 'exit', redemption_date: redDate });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const slice = (await ctx.db.query(
      "SELECT gross_amount, net_amount, status, batch_id FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date",
      [appId, redDate])).rows[0] as any;
    expect(Number(slice.gross_amount)).toBe(0);

    const redBatch = await ncd.post('/api/payouts', { payout_date: '2026-08-30' });
    expect(redBatch.status).toBe(201);

    // The ₹0 slice was swept INTO the batch — it belongs to this month, per
    // owner instruction, not left orphaned as Scheduled/batch_id NULL.
    const after = (await ctx.db.query(
      "SELECT gross_amount, status, batch_id FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND due_date=$2::date",
      [appId, redDate])).rows[0] as any;
    expect(Number(after.batch_id)).toBe(Number(redBatch.json.batch_id));

    const ws = await sheetOf((await a.raw(`/api/payouts/${redBatch.json.batch_id}/summary.xlsx`)).buffer);
    let found: { gross: unknown; net: unknown } | null = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Zero Gap Redeemer' && String(row.getCell(C('Type')).value) === 'Redemption') {
        found = { gross: row.getCell(C('Gross (Rs)')).value, net: row.getCell(C('Net (Rs)')).value };
      }
    }
    expect(found).toBeTruthy(); // NOT dropped from the sheet
    expect(Number(found!.gross)).toBe(0);
    expect(Number(found!.net)).toBe(0);
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

// Owner 2026-07-25: found via this very sheet — a brand-new "Addition" row was
// a day short. Interest starts ON the day of investment, not the day after.
describe('a new investment earns interest starting the day of investment', () => {
  it('invested 1-Sep, previewed 5-Sep → 5 days accrue (1st through 5th), not 4', async () => {
    const a = await admin();
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Day One Investor', phone: '9600000051' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660005151', ifsc: 'ICIC0001234', holder_name: 'Day One Investor' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-09-01',
    });
    await approveInvestment(await as('ncd@demo.local'), app);

    const preview = await a.get('/api/payouts/preview?date=2026-09-05');
    const row = (preview.json.rows as Array<{ customer_name: string; days: number; gross_amount: number }>)
      .find((r) => r.customer_name === 'Day One Investor');
    expect(row).toBeTruthy();
    expect(row!.days).toBe(5); // 1,2,3,4,5 Sep — not 4 (which would drop the 1st)
    // 500000 × 12% × 5/365 = ₹821.92 exactly, paid as ₹822 — interest is
    // computed in WHOLE RUPEES since 2026-08-16 (owner-approved). The day count
    // this test exists to pin is unchanged; only the precision of the result is.
    expect(Number(row!.gross_amount)).toBe(822);
  });

  it('the same day-count shows up correctly on the saved batch sheet\'s "Days" column', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Day One Batch Investor', phone: '9600000052' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660005252', ifsc: 'ICIC0001234', holder_name: 'Day One Batch Investor' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-10-01',
    });
    await approveInvestment(ncd, app);

    const batch = await ncd.post('/api/payouts', { payout_date: '2026-10-05' });
    expect(batch.status).toBe(201);
    const ws = await sheetOf((await a.raw(`/api/payouts/${batch.json.batch_id}/summary.xlsx`)).buffer);
    let found: { from: unknown; to: unknown; days: number } | null = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Day One Batch Investor') {
        found = { from: row.getCell(C('Interest From')).value, to: row.getCell(C('Interest To')).value, days: Number(row.getCell(C('Days')).value) };
      }
    }
    expect(found).toBeTruthy();
    expect(found!.days).toBe(5);
    expect(String(found!.from)).toBe('01-10-2026'); // the day of investment itself (dd-mm-yyyy, owner 2026-07-27)
    expect(String(found!.to)).toBe('05-10-2026');
  });
});

/**
 * "Invested (Rs)" on a partially-redeemed line's own interest row must show
 * what's actually still outstanding, not the original face amount — found via
 * a live sheet showing ₹10L for a line that had ₹5L redeemed out from under it
 * (J Ananthaprabha, APP-2026-000231), while the gross interest right next to
 * it was correctly computed on the reduced ₹5L. Both the preview sheet and the
 * saved-batch sheet had the same fallback-to-`l.amount` bug.
 */
describe('"Invested (Rs)" reflects the outstanding balance after a partial redemption', () => {
  const mkPartial = async (name: string, phone: string, investedOn: string) => {
    const a = await admin();
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: name, phone });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '6666' + phone, ifsc: 'ICIC0001234', holder_name: name });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: investedOn,
    });
    await approveInvestment(await as('ncd@demo.local'), app);
    return Number(app.json.id);
  };

  it('the preview summary shows the reduced balance, not the original ₹10L', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const appId = await mkPartial('Partial Preview Investor', '9600000061', '2027-02-01');
    const red = await a.post('/api/redemptions/premature', {
      application_id: appId, reason: 'part exit', redemption_date: '2027-03-10', amount: 400000,
    });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const ws = await sheetOf((await a.raw('/api/payouts/preview.summary.xlsx?date=2027-03-28')).buffer);
    let invested: number | null = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Partial Preview Investor' && String(row.getCell(C('Type')).value) !== 'Redemption') {
        invested = Number(row.getCell(C('Invested (Rs)')).value);
      }
    }
    expect(invested).toBe(600000); // 1,000,000 − 400,000, not the original face amount
  });

  it('the saved-batch summary shows the reduced balance too', async () => {
    const a = await admin();
    const cxo = await as('cxo@demo.local');
    const ncd = await as('ncd@demo.local');
    const appId = await mkPartial('Partial Batch Investor', '9600000062', '2027-02-01');
    const red = await a.post('/api/redemptions/premature', {
      application_id: appId, reason: 'part exit', redemption_date: '2027-04-10', amount: 400000,
    });
    expect(red.status).toBe(201);
    await cxo.post(`/api/approvals/${red.json.request.id}/approve`);

    const batch = await ncd.post('/api/payouts', { payout_date: '2027-04-28' });
    expect(batch.status).toBe(201);
    const ws = await sheetOf((await a.raw(`/api/payouts/${batch.json.batch_id}/summary.xlsx`)).buffer);
    let invested: number | null = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(C('Customer Name')).value) === 'Partial Batch Investor' && String(row.getCell(C('Type')).value) !== 'Redemption') {
        invested = Number(row.getCell(C('Invested (Rs)')).value);
      }
    }
    expect(invested).toBe(600000);
  });
});
