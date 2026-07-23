/**
 * One-time payout adjustments (owner 2026-07-23).
 *
 * NCD Manager+ records an Addition/Deduction against ONE investment's next
 * interest settlement, with a narration; Admin/CXO approves it in the queue;
 * the next batch consumes it and it never applies again. Net-only: the owner's
 * example is gross 1000 / TDS 10 / net 990, +100 addition → the bank pays 1090.
 *
 * Own server: batches here consume the accrued interest, so sharing one with
 * the money-out/summary suites would starve their cut-offs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };

let appA: number, appB: number, appNoA = '', appNoB = '';

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  for (const [phone, name] of [['9700000031', 'Adjust Cust A'], ['9700000032', 'Adjust Cust B']] as const) {
    const cust = await a.post('/api/customers', { full_name: name, phone });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '5555000' + phone.slice(-4), ifsc: 'ICIC0001234', holder_name: name });
    const app = await a.post('/api/applications', {
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12',
    });
    await approveInvestment(await as('ncd@demo.local'), app);
    if (phone.endsWith('31')) { appA = Number(app.json.id); appNoA = String(app.json.application_no ?? ''); }
    else { appB = Number(app.json.id); appNoB = String(app.json.application_no ?? ''); }
  }
  if (!appNoA) appNoA = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [appA])).rows[0]!.application_no);
  if (!appNoB) appNoB = String((await ctx.db.query('SELECT application_no FROM applications WHERE id = $1', [appB])).rows[0]!.application_no);
});
afterAll(async () => { await ctx.close(); });

const CUTOFF = '2026-09-28';
const previewRow = async (c: Client, appId: number, date = CUTOFF) => {
  const p = await c.get(`/api/payouts/preview?date=${date}`);
  return { row: (p.json.rows as any[]).find((r) => r.application_id === appId), totals: p.json.totals };
};

describe('payout adjustments — maker/checker lifecycle', () => {
  let adjId = 0, reqId = 0;

  it('branch staff cannot record one', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.post('/api/payouts/adjustments', { application_id: appA, kind: 'Addition', amount: 100, narration: 'should be forbidden' });
    expect(r.status).toBe(403);
  });

  it('NCD manager records an Addition with a narration → PendingApproval, not yet applied', async () => {
    const ncd = await as('ncd@demo.local');
    const noNarr = await ncd.post('/api/payouts/adjustments', { application_id: appA, kind: 'Addition', amount: 100, narration: '' });
    expect(noNarr.status).toBe(400); // narration is mandatory

    const r = await ncd.post('/api/payouts/adjustments', { application_id: appA, kind: 'Addition', amount: 100, narration: 'Festival bonus interest — owner instruction' });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
    adjId = r.json.id; reqId = r.json.request_id;

    // Pending ≠ applied: the preview still pays plain net.
    const { row } = await previewRow(ncd, appA);
    expect(row.total_amount).toBe(row.net_amount);
    expect(row.addition_amount).toBe(0);
  });

  it('the maker (NCD manager) cannot approve it — Admin/CXO only', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/approvals/${reqId}/approve`)).status).toBe(403);
  });

  it('CXO approves → the NEXT payout carries net + 100, exactly the owner example', async () => {
    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/approvals/${reqId}/approve`)).status).toBe(200);

    const ncd = await as('ncd@demo.local');
    const { row, totals } = await previewRow(ncd, appA);
    expect(row.addition_amount).toBe(100);
    expect(row.total_amount).toBeCloseTo(row.net_amount + 100, 2);
    expect(totals.addition).toBe(100);
    expect(totals.total).toBeCloseTo(totals.net + 100, 2);
  });

  it('the summary sheet shows Addition / Deduction / Total after Net, and the NEFT sheet pays the Total', async () => {
    const ncd = await as('ncd@demo.local');
    const { row } = await previewRow(ncd, appA);

    const load = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb.worksheets[0]!; };
    const summary = await load((await ncd.raw(`/api/payouts/preview.summary.xlsx?date=${CUTOFF}`)).buffer);
    const heads = (summary.getRow(1).values as unknown[]).filter(Boolean).map(String);
    expect(heads.slice(heads.indexOf('Net (Rs)'))).toEqual(['Net (Rs)', 'Addition (Rs)', 'Deduction (Rs)', 'Total (Rs)']);

    let hit = false;
    for (let i = 2; i <= summary.rowCount; i++) {
      const cells = summary.getRow(i);
      if (String(cells.getCell(2).value) !== appNoA) continue;
      hit = true;
      const col = (h: string) => heads.indexOf(h) + 1;
      expect(Number(cells.getCell(col('Addition (Rs)')).value)).toBe(100);
      expect(Number(cells.getCell(col('Deduction (Rs)')).value)).toBe(0);
      expect(Number(cells.getCell(col('Total (Rs)')).value)).toBe(Math.round(row.net_amount) + 100);
    }
    expect(hit).toBe(true);

    // The bank file's Transaction Amount = the Total, not the plain net.
    const neft = await load((await ncd.raw(`/api/payouts/sheet.xlsx?date=${CUTOFF}`)).buffer);
    const amounts: number[] = [];
    for (let i = 2; i <= neft.rowCount; i++) amounts.push(Number(neft.getRow(i).getCell(3).value));
    expect(amounts).toContain(Math.round(row.net_amount + 100));
  });

  it('settling a batch consumes it — it never applies twice — and cancelling releases it', async () => {
    const ncd = await as('ncd@demo.local');
    const { row: before } = await previewRow(ncd, appA);
    const batch = await ncd.post('/api/payouts', { payout_date: CUTOFF });
    expect(batch.status).toBe(201);

    const stored = (await ctx.db.query(
      'SELECT status, batch_id FROM payout_adjustments WHERE id = $1', [adjId])).rows[0]!;
    expect(stored.status).toBe('Consumed');
    expect(Number(stored.batch_id)).toBe(Number(batch.json.batch_id));

    // The settled row pays the adjusted amount; gross/TDS stay pure interest.
    const dsRow = (await ctx.db.query(
      `SELECT gross_amount, tds_amount, net_amount FROM disbursement_schedule
        WHERE batch_id = $1 AND application_id = $2 AND status = 'Scheduled'`,
      [batch.json.batch_id, appA])).rows[0]!;
    expect(Number(dsRow.net_amount)).toBeCloseTo(before.net_amount + 100, 2);
    expect(Number(dsRow.net_amount)).not.toBeCloseTo(Number(dsRow.gross_amount) - Number(dsRow.tds_amount), 2);

    // A later preview must NOT re-apply the consumed adjustment.
    const { row: after } = await previewRow(ncd, appA, '2026-10-28');
    expect(after.addition_amount).toBe(0);
    expect(after.total_amount).toBe(after.net_amount);

    // Cancelling the un-settled batch releases the adjustment back to Approved…
    const cancel = await ncd.post(`/api/payouts/${batch.json.batch_id}/cancel`, { reason: 'test release' });
    expect(cancel.status).toBe(200);
    const released = (await ctx.db.query('SELECT status, batch_id FROM payout_adjustments WHERE id = $1', [adjId])).rows[0]!;
    expect(released.status).toBe('Approved');
    expect(released.batch_id).toBeNull();

    // …so it applies to the next cut-off again. Consume it for real this time
    // so the remaining tests see a clean slate.
    const again = await ncd.post('/api/payouts', { payout_date: CUTOFF });
    expect(again.status).toBe(201);
    expect((await ctx.db.query('SELECT status FROM payout_adjustments WHERE id = $1', [adjId])).rows[0]!.status).toBe('Consumed');
  });

  it('a Deduction subtracts, and one larger than the accrued interest refuses to settle', async () => {
    const ncd = await as('ncd@demo.local');
    const cxo = await as('cxo@demo.local');

    const ded = await ncd.post('/api/payouts/adjustments', { application_id: appB, kind: 'Deduction', amount: 50, narration: 'Recover excess paid last cycle' });
    expect(ded.status).toBe(201);
    await cxo.post(`/api/approvals/${ded.json.request_id}/approve`);
    const { row } = await previewRow(ncd, appB, '2026-10-28');
    expect(row.deduction_amount).toBe(50);
    expect(row.total_amount).toBeCloseTo(row.net_amount - 50, 2);

    const huge = await ncd.post('/api/payouts/adjustments', { application_id: appB, kind: 'Deduction', amount: 9999999, narration: 'absurd — must refuse to settle' });
    await cxo.post(`/api/approvals/${huge.json.request_id}/approve`);
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-10-28' });
    expect(batch.status).toBe(422);
    expect(String(batch.json.error?.message ?? batch.json.error)).toMatch(/exceeds the interest accrued/);
    // The bank-file preview refuses identically.
    expect((await ncd.raw(`/api/payouts/sheet.xlsx?date=2026-10-28`)).status).toBe(422);

    // Withdraw the absurd one; the book is settleable again.
    const list = await ncd.get('/api/payouts/adjustments');
    const bad = (list.json.rows as any[]).find((r) => Number(r.amount) === 9999999);
    expect((await ncd.post(`/api/payouts/adjustments/${bad.id}/cancel`, {})).status).toBe(200);
    expect((await ncd.post('/api/payouts', { payout_date: '2026-10-28' })).status).toBe(201);
  });

  it('cancelling a pending adjustment withdraws its approval request too', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/payouts/adjustments', { application_id: appA, kind: 'Addition', amount: 25, narration: 'changed my mind' });
    expect((await ncd.post(`/api/payouts/adjustments/${r.json.id}/cancel`, {})).status).toBe(200);
    const req = (await ctx.db.query('SELECT status FROM approval_requests WHERE id = $1', [r.json.request_id])).rows[0]!;
    expect(req.status).toBe('Cancelled');
    const adj = (await ctx.db.query('SELECT status FROM payout_adjustments WHERE id = $1', [r.json.id])).rows[0]!;
    expect(adj.status).toBe('Cancelled');
  });
});
