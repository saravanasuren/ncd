/**
 * A PAN collision on the LockerHub customer sync must not 500 the request
 * (owner 2026-09-13, from an error alert: "current transaction is aborted,
 * commands ignored until end of transaction block").
 *
 * THE TRAP. Postgres aborts the WHOLE transaction on any failed statement.
 * Catching the error in JavaScript does not undo that — every query afterwards
 * fails with "current transaction is aborted". So this, which reads like
 * "ignore a PAN that belongs to someone else":
 *
 *     try { await tx.query('UPDATE customers SET pan = ...') }
 *     catch { /* that PAN belongs to another customer *\/ }
 *
 * did the opposite: it hid the real error and broke everything after it. The
 * statement that actually threw was an unrelated aadhaar_last4 update further
 * down, so the alert named the wrong line and the cause was invisible.
 *
 * WHICH pan. The top-level `pan` is already vetted: if it points at a different
 * customer than the phone does, `panTrusted` goes false and it is never
 * written. The KYC block is the gap — it writes `kyc.pan`, a value that is
 * NEVER looked up first, so that is the one that can collide. A first version
 * of this test used the top-level pan, passed against the BUG, and proved
 * nothing.
 *
 * Measured on production: 9 failures in 3 days, the last four exactly ~6 hours
 * apart — LockerHub retrying one customer forever, emailing an alert each time.
 *
 * A SAVEPOINT is the only recovery. These pin the behaviour the code always
 * meant to have: keep the PAN we hold, apply everything else, return 200.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const KEY = 'dev-integration-key';

/** The façade is key-authed, not cookie-authed — same as LockerHub calls it. */
async function push(body: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/api/integration/customers/from-lockerhub`, {
    method: 'POST',
    headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

describe('LockerHub customer sync survives a PAN that belongs to someone else', () => {
  const TAKEN = 'ZZAPZ9999Z';

  beforeAll(async () => {
    // Customer A owns the PAN.
    await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone, pan)
       VALUES ('DHN-PAN-A', 'Pan Owner', '9711000001', $1)`, [TAKEN]);
    // Customer B has none, and is the one LockerHub will push.
    await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone)
       VALUES ('DHN-PAN-B', 'Pan Seeker', '9711000002')`);
  });

  it('returns 200 instead of 500 — the failure in the alert', async () => {
    // No top-level pan: the collision comes through the KYC block, which is
    // the path that has no lookup in front of it.
    const r = await push({
      phone: '9711000002', name: 'Pan Seeker',
      kyc: { pan: TAKEN, aadhaar_last4: '4321' }, source: 'test',
    });
    expect(r.status).toBe(200);
  });

  it('keeps the PAN it already had, and applies everything else', async () => {
    // The intent of the original catch: a collision leaves the record alone.
    // What it must NOT do is abandon the rest of the sync.
    const b = (await ctx.db.query<{ pan: string | null; aadhaar_last4: string | null }>(
      `SELECT pan, aadhaar_last4 FROM customers WHERE customer_code = 'DHN-PAN-B'`)).rows[0]!;
    expect(b.pan).toBeNull();          // not stolen from customer A
    // ...and the statement that used to be the victim went through.
    expect(b.aadhaar_last4).toBe('4321');

    // Customer A is untouched.
    const a = (await ctx.db.query<{ pan: string }>(
      `SELECT pan FROM customers WHERE customer_code = 'DHN-PAN-A'`)).rows[0]!;
    expect(a.pan).toBe(TAKEN);
  });

  it('a FREE pan is still applied — the guard did not disable the feature', async () => {
    // A savepoint that rolled back too eagerly would look identical on the
    // failing path while quietly breaking the normal one.
    await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone)
       VALUES ('DHN-PAN-C', 'Pan Free', '9711000003')`);
    const r = await push({ phone: '9711000003', name: 'Pan Free', kyc: { pan: 'AAAPF1234F' }, source: 'test' });
    expect(r.status).toBe(200);
    const c = (await ctx.db.query<{ pan: string }>(
      `SELECT pan FROM customers WHERE customer_code = 'DHN-PAN-C'`)).rows[0]!;
    expect(c.pan).toBe('AAAPF1234F');
  });
});
