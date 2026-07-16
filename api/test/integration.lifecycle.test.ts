/**
 * Phase 4 integration — full investment lifecycle (PGlite HTTP):
 * customer → application → collection → eSign → batch allot → schedule
 * materialised → interest batch paid → premature redemption closes the app →
 * incentives accrued + paid. Every approval needs a second person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let customerId: number;
let appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  const r = await c.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('build an Active investment', () => {
  it('admin creates + approves a customer, then an application', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Lifecycle Investor', phone: '9111100000', referred_by_text: 'Neighbour Uncle' });
    customerId = cust.json.id;
    // add a verified bank account so the schedule has a payee
    await a.post(`/api/customers/${customerId}/bank-accounts`, { account_number: '55550001111', ifsc: 'ICIC0004321' });

    const app = await a.post('/api/applications', { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 500000 });
    expect(app.status).toBe(201);
    appId = app.json.id;
  });

  it('collection → eSign → pending allotment', async () => {
    const a = await admin();
    const col = await a.post(`/api/applications/${appId}/confirm-collection`, { amount_received: 500000, date_money_received: '2026-07-15', method: 'NEFT', reference: 'UTR123' });
    expect(col.status).toBe(200);
    // interest starts from the receipt date (after deemed 2026-07-01)
    expect(col.json.interest_start_date).toBe('2026-07-15');
    const es = await a.post(`/api/applications/${appId}/mark-esigned`);
    expect(es.status).toBe(200);
    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('PendingAllotment');
  });

  it('batch allotment needs two people, then activates + builds the schedule', async () => {
    // NCD Manager is the maker
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    expect(batch.status).toBe(201);
    const reqId = batch.json.request.id;

    // maker cannot approve their own allotment
    const self = await ncd.post(`/api/approvals/${reqId}/approve`);
    expect(self.status).toBe(403);

    // admin (a different checker) approves
    const a = await admin();
    const ok = await a.post(`/api/approvals/${reqId}/approve`);
    expect(ok.status).toBe(200);

    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Active');
    // schedule materialised: first row on the 28th, actual/365
    const first = detail.json.schedule[0];
    expect(first.due_date).toBe('2026-07-28');
    expect(Number(first.gross_amount)).toBeCloseTo(500000 * 0.12 * 13 / 365, 1); // 15→28 Jul = 13 days
  });
});

describe('interest payout', () => {
  it('interest batch: maker creates, checker approves, admin marks paid', async () => {
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-07-28' });
    expect(batch.status).toBe(201);
    expect(batch.json.count).toBeGreaterThan(0);
    const reqId = batch.json.request.id;
    const batchId = batch.json.batch_id;

    const a = await admin();
    await a.post(`/api/approvals/${reqId}/approve`);
    const paid = await a.post(`/api/payouts/${batchId}/mark-paid`, { utr: 'NEFTUTR' });
    expect(paid.status).toBe(200);
    expect(paid.json.paid).toBeGreaterThan(0);

    const detail = await a.get(`/api/applications/${appId}`);
    const julyRow = detail.json.schedule.find((r: any) => r.due_date === '2026-07-28');
    expect(julyRow.status).toBe('Paid');
  });
});

describe('incentives accrued at allotment', () => {
  it('the referrer (named on the app) accrued 2% of ₹5L = ₹10,000', async () => {
    // customer_was_new + referrer named → referrer gets 2%
    const { rows } = await ctx.db.query("SELECT payee_type, amount FROM incentive_accruals WHERE application_id = $1", [appId]);
    const referrer = rows.find((r: any) => r.payee_type === 'referrer');
    expect(referrer).toBeTruthy();
    expect(Number((referrer as any).amount)).toBeCloseTo(10000, 2);
  });
});

describe('premature redemption closes the application (docs/17 regression)', () => {
  it('2-level chain (NCD Manager → CXO), then the app is Redeemed', async () => {
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/premature', { application_id: appId, redemption_date: '2027-01-15', reason: 'Customer request' });
    expect(init.status).toBe(201);
    expect(Number(init.json.netPayment)).toBe(495000); // 5L − 1% penalty
    const reqId = init.json.request.id;

    // Level 1 — NCD Manager (a different person than the maker; here maker is ncd,
    // so use admin for L1, CXO for L2 to satisfy no-self-approve).
    const a = await admin();
    const l1 = await a.post(`/api/approvals/${reqId}/approve`);
    expect(l1.status).toBe(200);
    expect(l1.json.request.status).toBe('Pending'); // advanced to level 2

    const cxo = await as('cxo@demo.local');
    const l2 = await cxo.post(`/api/approvals/${reqId}/approve`);
    expect(l2.status).toBe(200);
    expect(l2.json.request.status).toBe('Approved');

    // THE FIX: application is reliably closed.
    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Redeemed');
    expect(detail.json.lines[0].status).toBe('PrematureWithdrawn');
    // future scheduled interest rows were skipped
    const anyScheduledInterest = detail.json.schedule.some((r: any) => r.status === 'Scheduled' && r.due_type === 'Interest');
    expect(anyScheduledInterest).toBe(false);
  });
});

describe('incentive payout ledger', () => {
  it('admin pays a partial incentive and the balance drops', async () => {
    const a = await admin();
    const staffUserId = 1; // seed admin enrolled this customer
    const before = await a.get(`/api/incentives/payees/staff/${staffUserId}/balance`);
    // referrer got the money in this case (new+referrer), so staff balance may be 0;
    // pay a referrer instead to exercise the ledger:
    const refId = Number((await ctx.db.query("SELECT payee_id FROM incentive_accruals WHERE payee_type='referrer' AND application_id=$1", [appId])).rows[0]!.payee_id);
    const bal0 = await a.get(`/api/incentives/payees/referrer/${refId}/balance`);
    expect(Number(bal0.json.balance)).toBeCloseTo(10000, 2);
    const pay = await a.post(`/api/incentives/payees/referrer/${refId}/pay`, { amount: 4000, reference: 'part-1' });
    expect(pay.status).toBe(200);
    expect(Number(pay.json.balance)).toBeCloseTo(6000, 2);
    void before;
  });
});
