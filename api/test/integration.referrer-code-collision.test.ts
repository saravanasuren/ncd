/**
 * A customer cannot be referred by someone who did not exist yet.
 *
 * `customers.referred_by_text` is free text, and for imported customers it
 * usually holds the OLD system's customer code — a code that means nothing in
 * this book. As this book's own counter climbs it eventually MINTS that same
 * code for an unrelated person, and every old customer carrying it as text
 * suddenly appears to have been referred by whoever just got it.
 *
 * That is not hypothetical. The counter reached DHN1056 on 2026-11-03 and 26
 * customers going back to July immediately began showing a man enrolled that
 * morning, with no investments, as their referrer. Across the whole book every
 * code-based match was of this kind: 26 impossible, 0 genuine. 11 more codes
 * are held by 116 customers and will break one by one as the counter passes
 * each of them.
 *
 * Same class as the application-number collision with the old system: two
 * systems minting into one code space.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { resolveReferredBy } from '../src/modules/customers/service.js';

let ctx: TestCtx;

/** A customer with an explicit creation time, so the ordering is the test. */
async function customer(code: string, name: string, createdAt: string, referredBy?: string) {
  const id = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone, created_at, referred_by_text)
     VALUES ($1,$2,$3,$4::timestamptz,$5) RETURNING id`,
    [name, code, '95500' + Math.floor(Math.random() * 100000), createdAt, referredBy ?? null])).rows[0]!.id);
  return { id, createdAt };
}

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('a referrer code that this book later minted for someone else', () => {
  it('is NOT shown as the referrer — the person did not exist yet', async () => {
    // The old customer, carrying a code inherited from the previous system.
    const old = await customer('DHN0634', 'Indira', '2026-07-18T10:00:00Z', 'DHN1056');
    // ...and the unrelated person this book handed that code to, months later.
    await customer('DHN1056', 'Someone Else Entirely', '2026-11-03T11:43:00Z');

    const r = await resolveReferredBy(ctx.db, 'DHN1056', old.createdAt);
    expect(r?.kind, 'a referrer born after the referee must not be claimed').toBe('text');
    expect(r?.name).toBeNull();
    // The raw code still shows, because that is genuinely all we know.
    expect(r?.text).toBe('DHN1056');
  });

  it('still resolves a genuine referral by an existing customer', async () => {
    // The feature must keep working: an older customer referring a newer one.
    await customer('DHN0100', 'The Real Referrer', '2026-01-10T09:00:00Z');
    const later = await customer('DHN0900', 'Referred Later', '2026-06-01T09:00:00Z', 'DHN0100');

    const r = await resolveReferredBy(ctx.db, 'DHN0100', later.createdAt);
    expect(r?.kind).toBe('customer');
    expect(r?.name).toBe('The Real Referrer');
    expect(r?.code).toBe('DHN0100');
  });

  it('accepts a referrer created on the same day', async () => {
    // Two people enrolled in one sitting, one referring the other. The guard is
    // about impossibility, not about being strict for its own sake.
    await customer('DHN0200', 'Same Day Referrer', '2026-03-05T09:00:00Z');
    const same = await customer('DHN0201', 'Same Day Referee', '2026-03-05T17:00:00Z', 'DHN0200');
    const r = await resolveReferredBy(ctx.db, 'DHN0200', same.createdAt);
    expect(r?.kind).toBe('customer');
  });

  it('reaches the customer page, not just the helper', async () => {
    const old = await customer('DHN0330', 'Yasotha', '2026-07-20T10:00:00Z', 'DHN1057');
    await customer('DHN1057', 'Minted Yesterday', '2026-11-03T12:00:00Z');
    const { getCustomerDetail } = await import('../src/modules/customers/service.js');
    const actor = { id: 1, permissions: ['*'], role: 'super_admin' } as never;
    const page = await getCustomerDetail(ctx.db, actor, old.id) as { referredBy: { kind: string; name: string | null } | null };
    expect(page.referredBy?.kind).toBe('text');
    expect(page.referredBy?.name).toBeNull();
  });

  it('leaves a referrer that is not a code alone', async () => {
    // 504 customers carry a NAME rather than a code; none of this touches them.
    await ctx.db.query(
      `INSERT INTO agents (agent_code, full_name, source, commission_status)
       VALUES ('AG-9001','Viswanath','manual','Approved')`);
    const r = await resolveReferredBy(ctx.db, 'Viswanath', '2026-01-01T00:00:00Z');
    expect(r?.kind).toBe('agent');
    expect(r?.name).toBe('Viswanath');
  });
});
