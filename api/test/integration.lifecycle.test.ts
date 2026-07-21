/**
 * Phase 4 integration — full investment lifecycle (PGlite HTTP):
 * customer → application (PendingApproval) → investment approval = go-live →
 * schedule materialised → batch allotment stamps the date → interest batch paid
 * → premature redemption closes the app → incentives accrued + paid. Every
 * approval needs a second person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let customerId: number;
let appId: number;
let subReqId: number;

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

    // Staff enter the money-credited date at enrolment; the app waits in the
    // one approval gate with an investment approval raised.
    const app = await a.post('/api/applications', { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-15', collection_method: 'NEFT', collection_reference: 'UTR123' });
    expect(app.status).toBe(201);
    appId = app.json.id;
    subReqId = app.json.subscription_request.id;
    expect((await a.get(`/api/applications/${appId}`)).json.application.status).toBe('PendingApproval');
  });

  it('eSign is non-gating: the app stays PendingApproval', async () => {
    const a = await admin();
    const es = await a.post(`/api/applications/${appId}/mark-esigned`);
    expect(es.status).toBe(200);
    const after = await a.get(`/api/applications/${appId}`);
    expect(after.json.application.status).toBe('PendingApproval');
    expect(after.json.application.esigned_at).toBeTruthy();
  });

  it('the investment approval needs two people, then goes live + builds the schedule', async () => {
    // maker (admin, who created the app) cannot approve their own investment
    const a = await admin();
    const self = await a.post(`/api/approvals/${subReqId}/approve`);
    expect(self.status).toBe(403);

    // a different checker (NCD Manager) approves → the NCD goes live
    const ncd = await as('ncd@demo.local');
    const ok = await ncd.post(`/api/approvals/${subReqId}/approve`);
    expect(ok.status).toBe(200);

    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Active');
    // interest starts from the staff-entered credit date (after deemed 2026-07-01)
    expect(detail.json.application.interest_start_date).toBe('2026-07-15');
    // active before allotment — allotment_date is still null
    expect(detail.json.application.allotment_date).toBeNull();
    // schedule materialised: first row on the 28th, actual/365
    const first = detail.json.schedule[0];
    expect(first.due_date).toBe('2026-07-28');
    expect(Number(first.gross_amount)).toBeCloseTo(500000 * 0.12 * 13 / 365, 1); // 15→28 Jul = 13 days
  });

  it('allotment later just stamps allotment_date + locks the series', async () => {
    const ncd = await as('ncd@demo.local');
    const a = await admin();
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    expect(batch.status).toBe(201);
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);
    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Active');
    expect(detail.json.application.allotment_date).toBe('2026-07-20');
  });
});

describe('interest payout', () => {
  it('sheet is free + stateless; claiming paid raises approval; approval settles', async () => {
    const a = await admin();
    // Pull the sheet for any date, repeatedly — writes nothing.
    for (const d of ['2026-07-20', '2026-07-28', '2026-07-20']) {
      const sheet = await a.raw(`/api/payouts/sheet.xlsx?date=${d}`);
      expect(sheet.status, `sheet ${d}`).toBe(200);
    }
    expect((await a.get('/api/payouts')).json.rows.length).toBe(0);   // still no batches

    // Claiming payment creates the batch AND raises the approval; nothing settled yet.
    const ncd = await as('ncd@demo.local');
    const claim = await ncd.post('/api/payouts', { payout_date: '2026-07-28', utr: 'NEFTUTR' });
    expect(claim.status).toBe(201);
    let detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.schedule.find((r: any) => r.due_date === '2026-07-28').status).toBe('Scheduled');

    // A different person approves → that settles it.
    await a.post(`/api/approvals/${claim.json.request.id}/approve`);
    detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.schedule.find((r: any) => r.due_date === '2026-07-28').status).toBe('Paid');
  });
});

describe('incentives accrued at allotment', () => {
  it('the referrer (named on the app) accrued 2% of ₹5L = ₹10,000', async () => {
    // customer_was_new + referrer named → the referrer gets 2%. The free-text
    // name became a PendingApproval AGENT at enrolment (2026-07-18 spec), so
    // the accrual routes to that agent payee, not the legacy referrers ledger.
    const { rows } = await ctx.db.query("SELECT payee_type, payee_id, amount FROM incentive_accruals WHERE application_id = $1", [appId]);
    const referrer = rows.find((r: any) => r.payee_type === 'agent');
    expect(referrer).toBeTruthy();
    expect(Number((referrer as any).amount)).toBeCloseTo(10000, 2);
    const agent = (await ctx.db.query("SELECT full_name, commission_status FROM agents WHERE id = $1", [(referrer as any).payee_id])).rows[0] as any;
    expect(agent.full_name).toBe('Neighbour Uncle');
    expect(agent.commission_status).toBe('PendingApproval');
  });
});

describe('premature redemption closes the application (docs/17 regression)', () => {
  it('maker → single CXO approval (old-app parity), then the app is Redeemed', async () => {
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/premature', { application_id: appId, redemption_date: '2027-01-15', reason: 'Customer request' });
    expect(init.status).toBe(201);
    // 5L − 1% penalty (₹495,000) + accrued broken interest now settled with it.
    expect(Number(init.json.netPayment)).toBeGreaterThanOrEqual(495000);
    const reqId = init.json.request.id;

    // Single CXO approval (maker is ncd; CXO ≠ maker).
    const cxo = await as('cxo@demo.local');
    const appr = await cxo.post(`/api/approvals/${reqId}/approve`);
    expect(appr.status).toBe(200);
    expect(appr.json.request.status).toBe('Approved');

    // THE FIX: application is reliably closed.
    const a = await admin();
    const detail = await a.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Redeemed');
    expect(detail.json.lines[0].status).toBe('PrematureWithdrawn');
    // future scheduled interest rows were skipped
    const anyScheduledInterest = detail.json.schedule.some((r: any) => r.status === 'Scheduled' && r.due_type === 'Interest');
    expect(anyScheduledInterest).toBe(false);
  });
});

describe('incentive payout ledger', () => {
  it('admin pays a customer incentive in full and the balance clears', async () => {
    const a = await admin();
    // The free-text referrer routed to an auto-created agent — pay that agent's
    // incentive for this customer's investment (pay-in-full, per customer).
    const refId = Number((await ctx.db.query("SELECT payee_id FROM incentive_accruals WHERE payee_type='agent' AND application_id=$1", [appId])).rows[0]!.payee_id);
    const bal0 = await a.get(`/api/incentives/payees/agent/${refId}/balance`);
    expect(Number(bal0.json.balance)).toBeCloseTo(10000, 2);
    const pay = await a.post(`/api/incentives/payees/agent/${refId}/accruals/${appId}/pay`, {});
    expect(pay.status).toBe(200);
    expect(Number(pay.json.paid)).toBeCloseTo(10000, 2);
    expect(Number(pay.json.balance)).toBeCloseTo(0, 2);
  });
});
