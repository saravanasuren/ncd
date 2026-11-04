/**
 * THE APPROVER CAN CORRECT A PREMATURE REDEMPTION'S DATE — AND ONLY WHILE IT
 * IS STILL PENDING (owner 2026-11-04: "i need date change for for the approver
 * to change if there is any changes for redemption dates", and when asked at
 * what stage: "only while approveing, once its approved means the money is
 * gone out").
 *
 * The date is the END OF THE INTEREST ACCRUAL, not a label. Before this there
 * was no edit path at all: a wrong date meant a hand-written database change,
 * done twice in October against a five-step runbook. What makes the pending-only
 * rule worth having is that it is also far safer — the `Premature` and
 * `BrokenInterest` schedule rows are not written until FINAL APPROVAL, so there
 * is nothing to move and no paid row to disturb.
 *
 * The one thing that is easy to miss, and is pinned below: the final-approve
 * handler dates both rows from `approval_requests.metadata.redemption_date`.
 * Change the redemption alone and the approval still uses the old date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function activeInvestment(name: string, phone: string, amount = 500000) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid,
    series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
}

const raise = async (a: Client, appId: number, date: string) =>
  (await a.post('/api/redemptions/premature', { application_id: appId, redemption_date: date, reason: 'Loan Repayment' })).json;

describe('the approver changes a pending redemption date', () => {
  it('moves the date, and the broken interest moves with it', async () => {
    const a = await admin();
    const appId = await activeInvestment('Date Change One', '9571000001');
    const r = await raise(a, appId, '2026-09-10');
    const before = Number(r.brokenInterest);
    expect(before).toBeGreaterThan(0);

    const res = await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'cheque cleared on the 20th' });
    expect(res.status).toBe(200);
    expect(res.json.redemption_date).toBe('2026-09-20');
    expect(res.json.previous_date).toBe('2026-09-10');
    // Ten more days of accrual, so strictly more interest.
    expect(res.json.broken_interest).toBeGreaterThan(before);

    const row = (await ctx.db.query<{ redemption_date: string; broken_interest: string; net_payment: string; principal: string; penalty: string }>(
      'SELECT redemption_date, broken_interest, net_payment, principal, penalty FROM redemptions WHERE id = $1',
      [r.redemption_id])).rows[0]!;
    expect(String(row.redemption_date).slice(0, 10)).toBe('2026-09-20');
    expect(Number(row.broken_interest)).toBe(res.json.broken_interest);
    // net_payment is principal − penalty; the broken interest is paid on the
    // monthly sheet, so the transfer itself must NOT move.
    expect(Number(row.net_payment)).toBe(Number(row.principal) - Number(row.penalty));
  });

  it('the figure equals what the request would have carried on that date', async () => {
    // The whole point of sharing one accrual helper: a corrected date must not
    // produce a different number from the same date entered first time.
    const a = await admin();
    const direct = await raise(a, await activeInvestment('Date Change Direct', '9571000002'), '2026-09-20');
    const moved = await raise(a, await activeInvestment('Date Change Moved', '9571000003'), '2026-09-10');
    const after = await a.post(`/api/redemptions/${moved.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'corrected to the real date' });
    expect(after.json.broken_interest).toBe(Number(direct.brokenInterest));
  });

  it('carries the new date onto the approval request, or approval uses the old one', async () => {
    // The trap. Both schedule rows are dated from the approval metadata.
    const a = await admin();
    const appId = await activeInvestment('Date Change Meta', '9571000004');
    const r = await raise(a, appId, '2026-09-10');
    await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'corrected' });
    const meta = (await ctx.db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM approval_requests WHERE id = $1', [Number(r.request.id)])).rows[0]!.metadata;
    expect(String(meta.redemption_date)).toBe('2026-09-20');
  });

  it('refuses once approved — the money has gone out', async () => {
    const a = await admin();
    const appId = await activeInvestment('Date Change Approved', '9571000005');
    const r = await raise(a, appId, '2026-09-10');
    await ctx.db.query("UPDATE redemptions SET status = 'Approved' WHERE id = $1", [r.redemption_id]);
    const res = await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'too late' });
    expect(res.status).toBe(422);
    expect(String(res.json.error?.message ?? res.json.message)).toMatch(/already been approved/i);
  });

  it('refuses a date behind interest already paid', async () => {
    const a = await admin();
    const appId = await activeInvestment('Date Change Backwards', '9571000006');
    // Pay a period, so the watermark moves.
    await ctx.db.query(
      `UPDATE disbursement_schedule SET status = 'Paid', paid_at = due_date
        WHERE application_id = $1 AND due_type = 'Interest' AND due_date <= '2026-08-28'`, [appId]);
    const r = await raise(a, appId, '2026-09-10');
    const res = await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-08-01', reason: 'behind the paid period' });
    expect(res.status).toBe(422);
    expect(String(res.json.error?.message ?? res.json.message)).toMatch(/already paid up to/i);
  });

  it('needs a reason, and rejects a junk date', async () => {
    const a = await admin();
    const r = await raise(a, await activeInvestment('Date Change Guards', '9571000007'), '2026-09-10');
    expect((await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'x' })).status).toBe(400);
    expect((await a.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '20-09-2026', reason: 'wrong format' })).status).toBe(400);
  });

  it('is an approver action, not a maker one', async () => {
    const a = await admin();
    const r = await raise(a, await activeInvestment('Date Change Perm', '9571000008'), '2026-09-10');
    const maker = await as('staff@demo.local');
    const res = await maker.post(`/api/redemptions/${r.redemption_id}/redemption-date`,
      { redemption_date: '2026-09-20', reason: 'not my call' });
    expect([401, 403]).toContain(res.status);
  });
});
