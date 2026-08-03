/**
 * The repeat rate is for somebody ELSE'S customer (owner rule 2026-08-03).
 *
 * The engine used to decide "new vs repeat" from `customer_was_new_at_creation`
 * — whether the customer already had an application ROW when this one was keyed
 * in. That answers a question about row order, not about who brought the money,
 * so an agent's own customer reinvesting paid the agent 0.25% instead of 2%,
 * and a customer splitting one day's money across several debentures paid the
 * full rate on the first leg only.
 *
 * On the live book that was 36 of 37 repeat-rate rows: Rs 56,875 where the rule
 * says Rs 4,55,000, all of it unpaid. Exactly one row was a genuinely different
 * referrer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { accrueForApplication } from '../src/modules/incentives/accrual.js';
import { referrerIntroducedCustomer, originalReferrerFor } from '../src/modules/incentives/referrer.js';

let ctx: TestCtx;
let seriesId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

let n = 0;
/** A customer whose record names `referrer` as the person who brought them in. */
async function customer(referrer: string | null): Promise<number> {
  const i = ++n;
  return Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, referred_by_text, is_active)
     VALUES ($1,$2,$3,'Approved',$4,TRUE) RETURNING id`,
    [`REF${String(i).padStart(3, '0')}`, `Referral Case ${i}`, `93000000${String(i).padStart(2, '0')}`, referrer])).rows[0]!.id);
}

/**
 * One investment. `wasNew` is the OLD flag, set deliberately to false on repeat
 * legs — the point of these tests is that it no longer decides the referrer's
 * rate.
 */
async function invest(customerId: number, amount: number, referrer: string | null, wasNew: boolean) {
  const id = Number((await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                               customer_was_new_at_creation, referred_by_text)
     VALUES ($1,$2,$3,'Active',$4,$5,$6) RETURNING id`,
    [`APP-REF-${++n}`, customerId, seriesId, amount, wasNew, referrer])).rows[0]!.id);
  await accrueForApplication(ctx.db, id);
  return id;
}

const referrerRow = async (appId: number) => (await ctx.db.query(
  "SELECT rate_value, amount FROM incentive_accruals WHERE application_id = $1 AND matrix_cell = 'referrer'",
  [appId])).rows[0] as { rate_value: string; amount: string } | undefined;

describe('an agent keeps the full rate on their own customer', () => {
  it('a repeat investment from a customer they introduced still pays 2%', async () => {
    const c = await customer('Shivashanmugam');
    await invest(c, 1_500_000, 'Shivashanmugam', true);
    const repeat = await invest(c, 1_000_000, 'Shivashanmugam', false);   // flag says "existing"
    expect(Number((await referrerRow(repeat))!.rate_value)).toBe(2);
    expect(Number((await referrerRow(repeat))!.amount)).toBe(20000);
  });

  it('every leg of a same-day split pays 2%, not just the first', async () => {
    // J SINDHU on the live book: ₹35L + ₹35L through RAJU-P on one day, paid
    // ₹70,000 and ₹8,750.
    const c = await customer('RAJU-P');
    const first = await invest(c, 3_500_000, 'RAJU-P', true);
    const second = await invest(c, 3_500_000, 'RAJU-P', false);
    expect(Number((await referrerRow(first))!.amount)).toBe(70000);
    expect(Number((await referrerRow(second))!.amount)).toBe(70000);
  });

  it('typing the name differently is the same person, not an intruder', async () => {
    const c = await customer('Shivashanmugam');
    await invest(c, 1_000_000, 'Shivashanmugam', true);
    const repeat = await invest(c, 1_000_000, 'SHIVASHANMUGAM', false);   // caps on the live book
    expect(Number((await referrerRow(repeat))!.rate_value)).toBe(2);
  });

  it('a first-ever investment pays 2% — they are the introducer', async () => {
    const c = await customer(null);
    const first = await invest(c, 500_000, 'Brand New Agent', true);
    expect(Number((await referrerRow(first))!.amount)).toBe(10000);
  });

  it('nobody on record before means the first referrer earns the full rate', async () => {
    // A walk-in customer already holding an NCD, later referred by an agent.
    const c = await customer(null);
    await invest(c, 500_000, null, true);                 // self-sourced, no referrer
    const brought = await invest(c, 400_000, 'Late Arriving Agent', false);
    expect(Number((await referrerRow(brought))!.rate_value)).toBe(2);
  });
});

describe('a DIFFERENT referrer on an existing customer earns the repeat rate', () => {
  it('someone else bringing back another agent\'s customer gets 0.25%', async () => {
    const c = await customer('Viswanath');
    await invest(c, 1_000_000, 'Viswanath', true);
    const poached = await invest(c, 1_000_000, 'Someone Else', false);
    expect(Number((await referrerRow(poached))!.rate_value)).toBe(0.25);
    expect(Number((await referrerRow(poached))!.amount)).toBe(2500);
  });

  it('and the original agent is unaffected on their own later investment', async () => {
    const c = await customer('Viswanath');
    await invest(c, 1_000_000, 'Viswanath', true);
    await invest(c, 1_000_000, 'Someone Else', false);
    const back = await invest(c, 1_000_000, 'Viswanath', false);
    expect(Number((await referrerRow(back))!.rate_value)).toBe(2);
  });
});

describe('who counts as the introducer', () => {
  it('is the earliest application naming one — not the customer record, which a handover rewrites', async () => {
    const c = await customer('Original Agent');
    await invest(c, 1_000_000, 'Original Agent', true);
    // A handover repoints the customer record at the new agent.
    await ctx.db.query("UPDATE customers SET referred_by_text = 'New Agent' WHERE id = $1", [c]);
    expect(await originalReferrerFor(ctx.db, c)).toBe('Original Agent');
    const afterHandover = await invest(c, 1_000_000, 'New Agent', false);
    // Still the repeat rate: the new agent did not bring this customer in.
    expect(Number((await referrerRow(afterHandover))!.rate_value)).toBe(0.25);
  });

  it('falls back to the customer record when no application names a referrer', async () => {
    const c = await customer('Only On The Customer');
    await invest(c, 1_000_000, null, true);
    expect(await originalReferrerFor(ctx.db, c)).toBe('Only On The Customer');
    expect(await referrerIntroducedCustomer(ctx.db, c, 'Only On The Customer')).toBe(true);
    expect(await referrerIntroducedCustomer(ctx.db, c, 'Somebody Different')).toBe(false);
  });
});

describe('the staff side is untouched', () => {
  it('a self-sourced investment still pays the staff 2% on the old flag', async () => {
    const staffId = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'staff@demo.local'")).rows[0]!.id);
    const c = await customer(null);
    const id = Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                                 customer_was_new_at_creation, enrolled_by_user_id)
       VALUES ($1,$2,$3,'Active',1000000,TRUE,$4) RETURNING id`,
      [`APP-REF-STAFF-${++n}`, c, seriesId, staffId])).rows[0]!.id);
    await accrueForApplication(ctx.db, id);
    const row = (await ctx.db.query(
      "SELECT matrix_cell, amount FROM incentive_accruals WHERE application_id = $1 AND payee_type = 'staff'",
      [id])).rows[0] as any;
    expect(row.matrix_cell).toBe('staff_new');
    expect(Number(row.amount)).toBe(20000);
  });
});
