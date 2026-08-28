/**
 * A one-time adjustment on a REDEEMED investment (owner 2026-08-27). A redeemed
 * investment normally can't take an adjustment (no future payout) — but the batch
 * covering its redemption pays its final broken-period interest, and the owner
 * wants that one payout adjustable. So: it's offered while a broken slice is still
 * pending, the create-guard allows it, and the adjustment actually rides onto the
 * slice's net at batch time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function mkRedeemed(a: Client, phone: string) {
  const cust = await a.post('/api/customers', { full_name: 'AdjRedeem', phone });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `55${phone}`, ifsc: 'ICIC0001234', holder_name: 'AdjRedeem' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: '2026-07-05',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  const appId = Number(app.json.id);
  const red = await a.post('/api/redemptions/premature', { application_id: appId, reason: 'test redeem', redemption_date: '2026-07-20' });
  expect(red.status).toBe(201);
  await (await as('cxo@demo.local')).post(`/api/approvals/${red.json.request.id}/approve`);
  return { appId, custId: Number(cust.json.id) };
}
const pendingSlice = async (appId: number) => (await ctx.db.query(
  "SELECT id, net_amount FROM disbursement_schedule WHERE application_id=$1 AND due_type='BrokenInterest' AND status='Scheduled' AND batch_id IS NULL", [appId])).rows[0];

describe('one-time adjustment on a redeemed investment', () => {
  it('is offered + accepted while a broken slice is pending, and reaches the payout', async () => {
    const admin = await superAdmin();
    const { appId, custId } = await mkRedeemed(admin, '9709000001');
    expect((await ctx.db.query('SELECT status FROM applications WHERE id=$1', [appId])).rows[0]!.status).toBe('Redeemed');

    // The customer detail flags it (outstanding 0, but a payout is still pending).
    const row = ((await admin.get(`/api/customers/${custId}`)).json.applications as any[]).find((a) => Number(a.id) === appId);
    expect(Number(row.outstanding)).toBe(0);
    expect(row.has_pending_payout).toBe(true);

    const slice = await pendingSlice(appId);
    const baseNet = Number(slice.net_amount);
    expect(baseNet).toBeGreaterThan(0);

    // The adjustment is now allowed on the redeemed investment.
    const adj = await admin.post('/api/payouts/adjustments', { application_id: appId, kind: 'Addition', amount: 500, narration: 'final top-up' });
    expect(adj.status).toBe(201);
    await (await as('cxo@demo.local')).post(`/api/approvals/${adj.json.request_id}/approve`);

    // The batch covering the redemption carries the +500 onto the slice's net.
    const batch = await (await as('ncd@demo.local')).post('/api/payouts', { payout_date: '2026-07-28' });
    expect(batch.status).toBe(201);
    const paid = (await ctx.db.query('SELECT net_amount, adjustment_amount FROM disbursement_schedule WHERE id=$1', [slice.id])).rows[0]!;
    expect(Number(paid.net_amount)).toBe(baseNet + 500);
    expect(Number(paid.adjustment_amount)).toBe(500);
  });

  it('is refused once the redeemed investment has no payout still due', async () => {
    const admin = await superAdmin();
    const { appId } = await mkRedeemed(admin, '9709000002');
    // Simulate the broken slice already paid → nothing pending.
    await ctx.db.query("UPDATE disbursement_schedule SET status='Paid' WHERE application_id=$1 AND due_type='BrokenInterest' AND status='Scheduled'", [appId]);
    const adj = await admin.post('/api/payouts/adjustments', { application_id: appId, kind: 'Addition', amount: 500, narration: 'too late' });
    expect(adj.status).toBe(422);
  });
});
