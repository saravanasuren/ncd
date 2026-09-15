/**
 * An incentive is a PERCENTAGE OF THE INVESTMENT, so it has to follow the
 * investment when money is clubbed into it.
 *
 * It did not. The accrual was written once with `ON CONFLICT DO NOTHING`, so the
 * first figure stood forever. APP-2026-001105 was approved at ₹4,00,000 (2% =
 * ₹8,000), then ₹26,00,000 was clubbed in the same afternoon, taking it to
 * ₹30,00,000 — and the accrual still said ₹8,000 while its own stored rate said
 * 2%. Three applications on the book were short by ₹64,000 between them.
 *
 * The other half of the rule matters just as much: a PAID accrual must never be
 * restated by a later edit. Both are pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number; let schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** The accrual row for an application, whoever it is payable to. */
async function accrual(appId: number) {
  return (await ctx.db.query(
    `SELECT payee_type, payee_id, matrix_cell, rate_mode, rate_value::float8 AS rate_value,
            amount::float8 AS amount, accrual_date, paid_at
       FROM incentive_accruals WHERE application_id = $1 ORDER BY id`, [appId])).rows as Array<{
    payee_type: string; payee_id: string; matrix_cell: string; rate_mode: string;
    rate_value: number; amount: number; accrual_date: string; paid_at: string | null;
  }>;
}

/** Create an application with a referrer, take it live, and club `add` into it. */
async function liveWithReferrer(a: Client, name: string, phone: string, amount: number) {
  // The referrer lives on the CUSTOMER; applications/service.ts copies it onto
  // the application at creation. Setting it on the POST body here would be
  // silently ignored, and the accrual would land on the staff cell instead.
  const cust = await a.post('/api/customers', { full_name: name, phone, referred_by_text: 'AG-TESTREF' });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId,
    scheme_id: schemeId, amount, referred_by_text: 'AG-TESTREF',
  });
  expect(create.status).toBe(201);
  expect((await approveInvestment(await as('ncd@demo.local'), create)).status).toBe(200);
  return { appId: Number(create.json.id), customerId: Number(cust.json.id) };
}

describe('an incentive follows the investment it is a percentage of', () => {
  it('recomputes when money is clubbed into an application that already accrued', async () => {
    const a = await admin();
    const { appId, customerId } = await liveWithReferrer(a, 'Club Incentive', '9701240001', 400000);

    // Accrued at the ORIGINAL amount — the starting point of the bug.
    const before = await accrual(appId);
    expect(before.length).toBeGreaterThan(0);
    const ref = before.find((r) => r.matrix_cell === 'referrer')!;
    expect(ref.rate_mode).toBe('pct');
    expect(ref.amount).toBeCloseTo(400000 * ref.rate_value / 100, 2);
    const firstAmount = ref.amount;
    const firstDate = ref.accrual_date;

    // Club ₹26,00,000 in — the shape of APP-2026-001105.
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: customerId, series_id: seriesId, scheme_id: schemeId,
      amount: 2600000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.status).toBe(201);
    expect(club.json.clubbed).toBe(true);
    if (club.json.pending_approval) {
      expect((await (await as('cxo@demo.local')).post(`/api/approvals/${club.json.approval_request.id}/approve`)).status).toBe(200);
    }

    const total = Number((await ctx.db.query('SELECT total_amount FROM applications WHERE id=$1', [appId])).rows[0]!.total_amount);
    expect(total).toBe(3000000);

    // THE FIX: the incentive is now a percentage of the WHOLE investment.
    const after = await accrual(appId);
    const ref2 = after.find((r) => r.matrix_cell === 'referrer')!;
    expect(ref2.amount).toBeCloseTo(total * ref2.rate_value / 100, 2);
    expect(ref2.amount).toBeGreaterThan(firstAmount);
    // Still ONE row for that payee — refreshed, not duplicated.
    expect(after.filter((r) => r.matrix_cell === 'referrer')).toHaveLength(1);
    // The month it belongs to does NOT move. My Earnings groups by accrual_date,
    // so restamping it would shift the incentive into the month of the edit.
    expect(ref2.accrual_date).toEqual(firstDate);
  });

  it('never restates an accrual that has already been paid', async () => {
    const a = await admin();
    const { appId, customerId } = await liveWithReferrer(a, 'Paid Incentive', '9701240002', 400000);

    const paidRow = (await accrual(appId)).find((r) => r.matrix_cell === 'referrer')!;
    const paidAmount = paidRow.amount;
    await ctx.db.query(
      `UPDATE incentive_accruals SET paid_at = now()
        WHERE application_id = $1 AND matrix_cell = 'referrer'`, [appId]);

    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: customerId, series_id: seriesId, scheme_id: schemeId,
      amount: 2600000, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.status).toBe(201);
    if (club.json.pending_approval) {
      expect((await (await as('cxo@demo.local')).post(`/api/approvals/${club.json.approval_request.id}/approve`)).status).toBe(200);
    }
    // The investment grew...
    expect(Number((await ctx.db.query('SELECT total_amount FROM applications WHERE id=$1', [appId])).rows[0]!.total_amount)).toBe(3000000);
    // ...and the SETTLED incentive did not move. Money already out of the door is
    // not restated by a later edit.
    const after = (await accrual(appId)).find((r) => r.matrix_cell === 'referrer')!;
    expect(after.amount).toBe(paidAmount);
    expect(after.paid_at).not.toBeNull();
  });
});
