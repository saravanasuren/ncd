/**
 * Gap B — money-out completeness: Federal NEFT sheet, mark-failed, bank-
 * statement matching (authoritative Paid), agent/referrer eligibility. PGlite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, appId: number;
// Distinct payout month per batch (Aug, Sep, Oct …) so each grabs a fresh row.
let _m = 7;
const MONTH = () => { _m++; return `2026-${String(_m).padStart(2, '0')}-28`; };

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  appId = await buildActive();
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function buildActive(): Promise<number> {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'MoneyOut Cust', phone: '9600000001', email: 'mo@ex.com' });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '66660001111', ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  const ncd = await as('ncd@demo.local');
  await approveInvestment(ncd, app);
  return app.json.id;
}

// Each call uses a distinct date so it batches a fresh accrual slice.
// The sheet is downloadable as soon as the batch exists — approval now sits on
// the "mark paid" claim, not on creation.
async function approvedInterestBatch(payoutDate: string): Promise<number> {
  const ncd = await as('ncd@demo.local');
  const batch = await ncd.post('/api/payouts', { payout_date: payoutDate });
  if (batch.status !== 201) throw new Error(`batch create failed: ${batch.status}`);
  return batch.json.batch_id;
}

describe('Federal NEFT sheet', () => {
  it('downloads with the 12-column Federal layout + debit account', async () => {
    const batchId = await approvedInterestBatch(MONTH());
    const a = await admin();
    const dl = await a.raw(`/api/payouts/${batchId}/download.xlsx`);
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).filter(Boolean);
    expect(header).toEqual([
      'Transaction Type', 'Debit Account', 'Transaction Amount', 'Value Date',
      'Beneficiary Account', 'Beneficiary Name', 'IFSC Code', 'Beneficiary Email ID',
      'Beneficiary ID', 'Credit Remarks', 'Debit Remarks', 'Unique Customer Reference Number',
    ]);
    // first data row carries the disbursement debit account
    expect(String(ws.getRow(2).getCell(2).value)).toBe('19820200007409');
    expect(String(ws.getRow(2).getCell(1).value)).toBe('NEFT');
  });
});

describe('bank-statement matching = authoritative Paid', () => {
  it('a matching statement line flips a batched Scheduled row to Paid', async () => {
    const batchId = await approvedInterestBatch(MONTH());
    await (await admin()).raw(`/api/payouts/${batchId}/download.xlsx`); // downloaded
    const a = await admin();
    // Get one batched row's exact net amount.
    const row = (await ctx.db.query("SELECT id, net_amount FROM disbursement_schedule WHERE batch_id = $1 AND status = 'Scheduled' LIMIT 1", [batchId])).rows[0] as any;
    const up = await a.post('/api/bank-statements', { source_bank: 'Federal', lines: [{ value_date: '2026-08-29', amount: Number(row.net_amount), utr: 'FDRLUTR1' }] });
    const match = await a.post(`/api/bank-statements/${up.json.statement_id}/run-match`);
    expect(match.json.matched).toBeGreaterThanOrEqual(1);
    // A batched Scheduled row with that amount is now Paid, stamped with the UTR.
    const paid = (await ctx.db.query("SELECT status FROM disbursement_schedule WHERE utr = 'FDRLUTR1'")).rows[0] as any;
    expect(paid).toBeTruthy();
    expect(paid.status).toBe('Paid');
  });
});

describe('mark row failed', () => {
  it('an admin can fail a scheduled row with a reason', async () => {
    const batchId = await approvedInterestBatch(MONTH());
    const a = await admin();
    const row = (await ctx.db.query("SELECT id FROM disbursement_schedule WHERE batch_id = $1 AND status = 'Scheduled' LIMIT 1", [batchId])).rows[0] as any;
    const r = await a.post(`/api/payouts/rows/${Number(row.id)}/mark-failed`, { reason: 'Account frozen' });
    expect(r.status).toBe(200);
    const after = (await ctx.db.query('SELECT status, failure_reason FROM disbursement_schedule WHERE id = $1', [Number(row.id)])).rows[0] as any;
    expect(after.status).toBe('Failed');
    expect(after.failure_reason).toBe('Account frozen');
  });
});

describe('agent commission eligibility (maker-checker)', () => {
  it('request → approve sets the agent Approved with the rate; over-cap rejected', async () => {
    const agentId = Number((await ctx.db.query("SELECT id FROM agents WHERE agent_code = 'AG-DEMO'")).rows[0]!.id);
    const ncd = await as('ncd@demo.local');
    const over = await ncd.post(`/api/incentives/agents/${agentId}/eligibility`, { rate_pct: 5 });
    expect(over.status).toBe(400); // cap is 2%
    const req = await ncd.post(`/api/incentives/agents/${agentId}/eligibility`, { rate_pct: 1.5, payout_mode: 'OneTime' });
    expect(req.status).toBe(201);
    const a = await admin();
    await a.post(`/api/approvals/${req.json.request.id}/approve`);
    const agent = (await ctx.db.query('SELECT commission_status, commission_rate_pct FROM agents WHERE id = $1', [agentId])).rows[0] as any;
    expect(agent.commission_status).toBe('Approved');
    expect(Number(agent.commission_rate_pct)).toBe(1.5);
  });
});

describe('redemption report', () => {
  it('downloads an xlsx', async () => {
    const a = await admin();
    const dl = await a.raw('/api/redemptions/report.xlsx');
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.buffer);
    expect(wb.worksheets[0]!.name).toBe('Redemptions');
  });
});
