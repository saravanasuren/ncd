/**
 * Staff and customers share the DHN#### code space.
 *
 * Staff carry codes like DHN1056 in users.code, and customers carry them in
 * customers.customer_code. The two sequences run independently, so one code can
 * name two different people.
 *
 * Every DHN code actually used as a referrer in this book belongs to a STAFF
 * member — all twelve of them, held by 142 customers. Staff refer customers,
 * and whoever enrolled them wrote the referring colleague's code down. The data
 * was never wrong.
 *
 * The resolver asked the customers table first. For months that was harmless,
 * because no customer held any of those codes: the lookup missed and fell
 * through to the staff match, which was right. Then the customer counter
 * reached DHN1056 and handed it to a new customer, and 26 customers going back
 * to July stopped showing the staff member who referred them and started
 * showing a stranger enrolled that morning.
 *
 * So the order is the fix, and these tests pin it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { resolveReferredBy } from '../src/modules/customers/service.js';

let ctx: TestCtx;

async function customer(code: string, name: string, referredBy?: string) {
  const id = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone, referred_by_text)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, code, '95500' + Math.floor(Math.random() * 100000), referredBy ?? null])).rows[0]!.id);
  return id;
}

async function staff(code: string, name: string) {
  await ctx.db.query(
    `INSERT INTO users (full_name, email, password_hash, role_id, code, is_active)
     VALUES ($1, $2, 'x', (SELECT id FROM roles WHERE name = 'branch_staff'), $3, TRUE)`,
    [name, `${code.toLowerCase()}@dhanam.finance`, code]);
}

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('a DHN code on "referred by" means the STAFF member who holds it', () => {
  it('resolves to the staff member even when a customer has the same code', async () => {
    // The exact collision: staff DHN1056 is the real referrer; a customer was
    // later handed the same code by the independent customer counter.
    await staff('DHN1056', 'S Ashokkumar');
    await customer('DHN1056', 'Unrelated Customer');

    const r = await resolveReferredBy(ctx.db, 'DHN1056');
    expect(r?.kind, 'staff hold these codes; the customer must not win').toBe('staff');
    expect(r?.name).toBe('S Ashokkumar');
  });

  it('resolved correctly BEFORE the collision too, and still does', async () => {
    // No customer holds this one yet — the state the other 11 codes are in.
    await staff('DHN1084', 'Bindhu R');
    const r = await resolveReferredBy(ctx.db, 'DHN1084');
    expect(r?.kind).toBe('staff');
    expect(r?.name).toBe('Bindhu R');
  });

  it('still resolves a genuine customer-referred-a-customer', async () => {
    // No staff member holds this code, so the customer is the only candidate.
    await customer('DHN0100', 'A Real Customer Referrer');
    const r = await resolveReferredBy(ctx.db, 'DHN0100');
    expect(r?.kind).toBe('customer');
    expect(r?.name).toBe('A Real Customer Referrer');
  });

  it('reaches the customer page, not just the helper', async () => {
    await staff('DHN1204', 'Venkateswari S');
    await customer('DHN1204', 'Collided Customer');
    const id = await customer('DHN0330', 'Yasotha', 'DHN1204');

    const { getCustomerDetail } = await import('../src/modules/customers/service.js');
    const actor = { id: 1, permissions: ['*'], role: 'super_admin' } as never;
    const page = await getCustomerDetail(ctx.db, actor, id) as { referredBy: { kind: string; name: string | null } | null };
    expect(page.referredBy?.kind).toBe('staff');
    expect(page.referredBy?.name).toBe('Venkateswari S');
  });

  it('leaves a name-based referrer alone', async () => {
    // 504 customers carry a NAME rather than a code; none of this touches them.
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, source, commission_status)
       VALUES ('AG-9001','Viswanath','manual','Approved')`);
    const r = await resolveReferredBy(ctx.db, 'Viswanath');
    expect(r?.kind).toBe('agent');
    expect(r?.name).toBe('Viswanath');
  });

  it('prints the raw text when nobody holds the code', async () => {
    const r = await resolveReferredBy(ctx.db, 'DHN9999');
    expect(r?.kind).toBe('text');
    expect(r?.text).toBe('DHN9999');
  });
});
