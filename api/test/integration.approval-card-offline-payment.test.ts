/**
 * Whose locker rent is this? (owner 2026-09-07: "in this approval im not knowing
 * whose locker rent has been given for approval. so add the name.")
 *
 * There was no card definition for locker_offline_payment at all, so it fell
 * through to the raw-metadata fallback: the subject was the request number and
 * the facts were bare keys — Leg, Amount, Method, Reference, Payment id,
 * Lockerhub application id. Nothing said who.
 *
 * locker_offline_payments carries no customer of its own; it is keyed on
 * LockerHub's application id. The name is resolved from whichever locker record
 * knows it, preferring the allotment record — written at hand-over with the
 * customer resolved from LockerHub's own tenant phone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A pending offline-payment approval on a locker, and the id of its request. */
async function offlinePayment(appId: string, customerId: number | null, lockerNo: string): Promise<number> {
  if (customerId) {
    await ctx.db.query(
      `INSERT INTO locker_allotments (lockerhub_application_id, customer_id, locker_no, branch_name, allotted_on)
       VALUES ($1, $2, $3, 'Hosur', current_date)
       ON CONFLICT (lockerhub_application_id) DO NOTHING`, [appId, customerId, lockerNo]);
  }
  const pay = (await ctx.db.query<{ id: string }>(
    `INSERT INTO locker_offline_payments (lockerhub_application_id, leg, method, reference, amount, status)
     VALUES ($1, 'rent', 'cheque', '000130', 6000, 'PendingApproval') RETURNING id`, [appId])).rows[0]!;
  const req = (await ctx.db.query<{ id: string }>(
    `INSERT INTO approval_requests
       (request_no, request_type, entity_type, entity_id, level, max_levels, chain, status, maker_user_id, metadata)
     VALUES ($1, 'locker_offline_payment', 'locker_offline_payments', $2, 1, 1,
             '[{"level":1,"checkerPermission":"approvals:check"}]'::jsonb, 'Pending', 1, $3::jsonb)
     RETURNING id`,
    [`REQ-TEST-${appId}`, pay.id,
     JSON.stringify({ payment_id: Number(pay.id), lockerhub_application_id: appId, leg: 'rent', method: 'cheque', reference: '000130' })])).rows[0]!;
  return Number(req.id);
}

const card = async (a: Client, reqId: number) => (await a.get(`/api/approvals/${reqId}`)).json.detail;

describe('the locker rent approval says whose rent it is', () => {
  it('leads with the customer, not the request number', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Venkatesan R', phone: '9536000001' });
    const reqId = await offlinePayment('mtmjmpq0fvh7kqo', Number(cust.json.id), 'L6-22');

    const d = await card(a, reqId);
    // Before this the subject was the request number and nothing else.
    expect(d.subject).toContain('Venkatesan R');
    expect(d.subject).not.toMatch(/^REQ-/);

    const facts = JSON.stringify(d.facts);
    expect(facts).toContain('Venkatesan R');
    expect(facts).toContain('L6-22');
    expect(facts).toContain('Hosur');
    expect(facts).toContain('000130');
    // And it says what approving actually does.
    expect(facts).toContain('settled on LockerHub');
  });

  it('carries the amount, so the queue can show it', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Amount Cust', phone: '9536000002' });
    const reqId = await offlinePayment('mtm-amount-1', Number(cust.json.id), 'L6-23');
    expect(Number((await card(a, reqId)).amount)).toBe(6000);
  });

  it('is still readable when no customer can be resolved', async () => {
    // A locker we hold a payment for but cannot tie to an NCD customer must not
    // fall back to a bare request number again.
    const a = await admin();
    const reqId = await offlinePayment('mtm-nocust-1', null, 'L6-24');
    const d = await card(a, reqId);
    expect(d.subject).toContain('rent');
    expect(d.subject).not.toMatch(/^REQ-/);
    expect(JSON.stringify(d.facts)).toContain('mtm-nocust-1');
  });
});

describe('every approval says when it was raised', () => {
  it('the queue carries created_at, which is what the screen renders', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Stamp Cust', phone: '9536000003' });
    await offlinePayment('mtm-stamp-1', Number(cust.json.id), 'L6-25');

    const rows = (await a.get('/api/approvals/queue')).json.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Without this the page has nothing to print, which is why "who sent it
      // and when" was unanswerable from the queue.
      expect(r.created_at).toBeTruthy();
      expect(Number.isNaN(new Date(String(r.created_at)).getTime())).toBe(false);
    }
  });

  it('and the maker, so the pair reads as "who, and when"', async () => {
    const a = await admin();
    const rows = (await a.get('/api/approvals/queue')).json.rows as Array<Record<string, unknown>>;
    expect(rows.some((r) => r.maker_name)).toBe(true);
  });
});
