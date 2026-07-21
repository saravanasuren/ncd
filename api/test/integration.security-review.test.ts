/**
 * Security + lifecycle fixes from the 2026-07-21 code review:
 *  - IDOR: document/statement endpoints enforce scope/ownership.
 *  - Own-scope users don't see others' redemptions.
 *  - Agent role can no longer verify KYC (segregation of duties).
 *  - Rejecting a redemption / interest batch cleanly reverses it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Approved customer with one Active investment, enrolled by admin (out of a
 * branch_staff/agent's own-scope). */
async function activeInvestment(name: string, phone: string, amount = 500000) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id; // customers are created live now — no approval step
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  return { customerId: cid, appId: app.json.id };
}

describe('security review — access control', () => {
  it('IDOR: a branch_staff cannot download the SOA of a customer they do not own', async () => {
    const inv = await activeInvestment('IDOR Victim', '9722200001');
    const staff = await as('staff@demo.local');
    const r = await staff.raw(`/api/reports/soa/${inv.customerId}.pdf`);
    expect(r.status).toBe(404); // out of scope → not found (no confirmation it exists)
  });

  it('IDOR: an agent cannot pull another payee’s incentive statement', async () => {
    const agent = await as('agent@demo.local');
    // Requesting a staff payee (not the agent’s own payee) is refused.
    const r = await agent.raw('/api/incentives/payees/staff/1/statement.pdf');
    expect(r.status).toBe(403);
  });

  it('agent role can no longer verify KYC (segregation of duties)', async () => {
    const inv = await activeInvestment('KYC Sod', '9722200002');
    const agent = await as('agent@demo.local');
    const r = await agent.post(`/api/customers/${inv.customerId}/kyc/verify`, {});
    expect(r.status).toBe(403);
  });

  it('redemptions list is scoped — an own-scope agent does not see others’ redemptions', async () => {
    const inv = await activeInvestment('Scoped Redeem', '9722200003');
    const ncd = await as('ncd@demo.local');
    await ncd.post('/api/redemptions/premature', { application_id: inv.appId, reason: 'test scope' });
    // admin (scope: all) sees it; the agent (own-agent scope, didn’t enrol it) does
    // not — the agent has dashboard:view so it can reach the list, but scope filters.
    const adminList = await (await admin()).get('/api/redemptions');
    expect(adminList.json.rows.some((x: any) => x.application_no)).toBe(true);
    const agent = await as('agent@demo.local');
    const agentList = await agent.get('/api/redemptions');
    expect(agentList.status).toBe(200);
    expect(agentList.json.rows.length).toBe(0);
  });
});

describe('security review — lifecycle reject cleanup', () => {
  it('rejecting a premature redemption marks it Rejected and unblocks a new one', async () => {
    const inv = await activeInvestment('Reject Redeem', '9722200004');
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/premature', { application_id: inv.appId, reason: 'first try' });
    expect(init.status).toBe(201);
    const redId = init.json.redemption_id;
    const reqId = init.json.request.id;
    // A different checker rejects.
    const rej = await (await admin()).post(`/api/approvals/${reqId}/reject`, { reason: 'not now' });
    expect(rej.status).toBe(200);
    const red = (await ctx.db.query('SELECT status FROM redemptions WHERE id = $1', [redId])).rows[0] as any;
    expect(red.status).toBe('Rejected');
    // The investment is no longer locked — a fresh premature can be raised.
    const again = await ncd.post('/api/redemptions/premature', { application_id: inv.appId, reason: 'second try' });
    expect(again.status).toBe(201);
  });

  it('premature settlement now includes accrued broken-period interest', async () => {
    const inv = await activeInvestment('Broken Interest', '9722200006');
    const ncd = await as('ncd@demo.local');
    const init = await ncd.post('/api/redemptions/premature', { application_id: inv.appId, reason: 'exit' });
    expect(init.status).toBe(201);
    // Accrued interest is computed (>0 for a funded, days-elapsed investment)…
    expect(Number(init.json.brokenInterest)).toBeGreaterThan(0);
    // …and folded (net of TDS) into the payout — so net > principal − penalty.
    expect(Number(init.json.netPayment)).toBeGreaterThan(Number(init.json.principal) - Number(init.json.penalty));
  });

  it('rejecting an interest batch frees the period (rows released, batch Failed)', async () => {
    const inv = await activeInvestment('Reject Batch', '9722200005');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-09-28' });
    expect(batch.status).toBe(201);
    const batchId = batch.json.batch_id;
    const reqId = batch.json.request.id;
    // Rows were materialised + attached to the batch.
    const before = await ctx.db.query('SELECT count(*)::int AS n FROM disbursement_schedule WHERE batch_id = $1', [batchId]);
    expect(Number((before.rows[0] as any).n)).toBeGreaterThan(0);
    // Reject → rows released, batch Failed.
    const rej = await (await admin()).post(`/api/approvals/${reqId}/reject`, { reason: 'wrong date' });
    expect(rej.status).toBe(200);
    const stillScheduled = await ctx.db.query("SELECT count(*)::int AS n FROM disbursement_schedule WHERE batch_id = $1 AND status = 'Scheduled'", [batchId]);
    expect(Number((stillScheduled.rows[0] as any).n)).toBe(0);
    const b = (await ctx.db.query('SELECT status FROM payout_batches WHERE id = $1', [batchId])).rows[0] as any;
    expect(b.status).toBe('Failed');
    // And the interest is billable again on the next batch.
    const rebatch = await ncd.post('/api/payouts', { payout_date: '2026-09-28' });
    expect(rebatch.status).toBe(201);
  });
});
