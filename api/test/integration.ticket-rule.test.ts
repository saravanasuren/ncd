/**
 * Ticket rule end-to-end: NCDs are ISSUED in whole ₹1,00,000 units.
 *
 * The gate used to sit at BOTH create and approval. It now sits at approval
 * only (owner 2026-08-01): money arrives in parts and staff must be able to
 * record what the bank statement shows, so a part payment is accepted, held,
 * and clubbed. See integration.part-payment.test.ts for that flow.
 *
 * Approval is the one that matters and is unchanged — it is what takes an
 * investment live and starts interest, so an odd total must never get past it,
 * whatever created it (an inbound LockerHub write included).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
async function login(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const seriesId = () => ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'").then((r: any) => Number(r.rows[0].id));
const schemeId = () => ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'").then((r: any) => Number(r.rows[0].id));

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function customer(staff: Client, phone: string) {
  const c = await staff.post('/api/customers', { full_name: uniqueName('Ticket Cust', phone), phone });
  return Number(c.json.id);
}

describe('investment ticket rule (whole ₹1,00,000 units)', () => {
  it('create ACCEPTS an odd amount now — the gate moved to approval', async () => {
    // Previously 400 at the door. A part payment is a real thing that lands in
    // the bank, and refusing it forced staff to record a figure the statement
    // does not show. It is recorded and held instead; approval still refuses it.
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const cid = await customer(staff, '9895000001');
    const base = { customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), date_money_received: '2026-07-01' };

    for (const amount of [2580369, 50000, 250000, 2600000]) {
      const r = await staff.post('/api/applications', { ...requiredInvestmentFields(), ...base, amount });
      expect({ amount, status: r.status }).toEqual({ amount, status: 201 });
      // …and none of them is live. Nothing earns interest on a create.
      expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(r.json.id)])).rows[0].status)
        .toBe('PendingApproval');
    }
  });

  it('an odd amount is still refused where it counts — at approval', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9895000002');
    const app = await staff.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 250000,
    });
    expect(app.status).toBe(201);

    const blocked = await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toMatch(/₹1,00,000/);
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(app.json.id)])).rows[0].status)
      .toBe('PendingApproval');
  });

  it('blocks approval of an off-denomination amount, and lets the checker fix it inline', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9895000003');
    const app = await staff.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 600000, date_money_received: '2026-07-01',
    });
    const appId = Number(app.json.id);
    const reqId = app.json.subscription_request.id;

    // Simulate what an inbound/legacy write can still leave behind: an amount
    // that never passed the create-time gate.
    await ctx.db.query('UPDATE applications SET total_amount = 2580369 WHERE id = $1', [appId]);
    await ctx.db.query('UPDATE application_lines SET amount = 2580369, outstanding_amount = 2580369 WHERE application_id = $1', [appId]);

    const blocked = await ncd.post(`/api/approvals/${reqId}/approve`);
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toMatch(/units of ₹1,00,000/);
    // Still pending — the block must not half-apply the approval.
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0].status).toBe('PendingApproval');

    // The checker corrects the amount on the approval form and it goes through.
    const fixed = await ncd.post(`/api/approvals/${reqId}/approve`, { extra: { edits: { total_amount: 2600000 } } });
    expect(fixed.status).toBe(200);
    const after = (await ctx.db.query('SELECT status, total_amount FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(after.status).toBe('Active');
    expect(Number(after.total_amount)).toBe(2600000);
  });

  it('a clean investment still approves normally', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const ncd = await login('ncd@demo.local');
    const cid = await customer(staff, '9895000004');
    const app = await staff.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(), amount: 500000, date_money_received: '2026-07-01',
    });
    const ok = await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await ctx.db.query('SELECT status FROM applications WHERE id = $1', [Number(app.json.id)])).rows[0].status).toBe('Active');
  });
});
