/**
 * Deleting a customer bank account. The guards are right — you must not orphan
 * unpaid payouts — but the refusal has to tell the operator something they can
 * actually DO. "Make another account active first" is a dead end when the
 * account being deleted is the only one on file (owner report 2026-07-24).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

/** A customer with one bank account and a live investment (⇒ unpaid payouts). */
async function customerWithPayouts(phone: string) {
  const a = await admin();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const cust = await a.post('/api/customers', { full_name: 'Bank Delete ' + phone, phone });
  const cid = Number(cust.json.id);
  const bank = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '112611500000' + phone.slice(-4), ifsc: 'KVBL0001126' });
  const app = await a.post('/api/applications', {
    customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-01',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return { cid, bankId: Number(bank.json.id) };
}

describe('deleting a bank account', () => {
  it('the ONLY account: refuses, and says to add the replacement first', async () => {
    const { cid, bankId } = await customerWithPayouts('9911000001');
    const sa = await admin();
    const r = await sa.del(`/api/customers/${cid}/bank-accounts/${bankId}`);
    expect(r.status).toBe(409);
    // Must NOT tell them to activate another account — there isn't one.
    expect(r.json.error.message).not.toMatch(/make one of the customer's other accounts active/i);
    expect(r.json.error.message).toMatch(/only one/i);
    expect(r.json.error.message).toMatch(/add the replacement account, click "Make active"/i);
    expect(r.json.error.message).toMatch(/unpaid payout/i);
  });

  it('adding the replacement unblocks the delete — the documented way out', async () => {
    const { cid, bankId } = await customerWithPayouts('9911000002');
    const sa = await admin();
    // Reproduce the reported case exactly: nothing PINNED to the account (that
    // is a separate guard with its own message), just active + unpaid payouts.
    await ctx.db.query('UPDATE applications SET payout_bank_account_id = NULL WHERE customer_id = $1', [cid]);
    // Follow the advice to the letter: add the replacement, THEN make it active
    // (adding alone does not activate — which is why the message says both).
    const fresh = await sa.post(`/api/customers/${cid}/bank-accounts`, { account_number: '999900001122', ifsc: 'HDFC0001234' });
    expect(fresh.status).toBe(201);
    expect((await sa.post(`/api/customers/${cid}/bank-accounts/${fresh.json.id}/set-active`)).status).toBe(200);
    // …then the old one deletes cleanly.
    expect((await sa.del(`/api/customers/${cid}/bank-accounts/${bankId}`)).status).toBe(200);
    const left = await ctx.db.query('SELECT count(*) AS n FROM customer_bank_accounts WHERE customer_id = $1', [cid]);
    expect(Number((left.rows[0] as any).n)).toBe(1);
  });

  it('with OTHER accounts present the message points at those instead', async () => {
    const { cid, bankId } = await customerWithPayouts('9911000003');
    const sa = await admin();
    // A second, INACTIVE account exists — so activating it is genuinely an option.
    await sa.post(`/api/customers/${cid}/bank-accounts`, { account_number: '888800001122', ifsc: 'HDFC0001234' });
    await sa.post(`/api/customers/${cid}/bank-accounts/${bankId}/set-active`);
    const r = await sa.del(`/api/customers/${cid}/bank-accounts/${bankId}`);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/other accounts active first/i);
  });
});
