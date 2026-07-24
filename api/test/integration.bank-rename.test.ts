/**
 * Correcting a misspelt beneficiary name (owner report 2026-07-24).
 *
 * There was no way to edit a bank account at all. The operator's only route was
 * "add the same account again with the right name, then delete the old" — and
 * the add is refused as a duplicate while the delete is blocked by unpaid
 * payouts. So the typo was unfixable. The name is what prints in the Beneficiary
 * Name column of the bank file, so it has to be correctable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function customerWithBank(phone: string, holder: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: uniqueName('Rename', phone), phone });
  const cid = Number(cust.json.id);
  const bank = await a.post(`/api/customers/${cid}/bank-accounts`,
    { account_number: '11261150000' + phone.slice(-5), ifsc: 'KVBL0001126', holder_name: holder });
  return { cid, bankId: Number(bank.json.id) };
}

describe('correcting the beneficiary name', () => {
  it('renames in place, keeping the account and its penny-drop', async () => {
    const { cid, bankId } = await customerWithBank('9922000001', 'VDENKATACHALAM GOVINDARAJ');
    const a = await admin();
    const before = (await ctx.db.query('SELECT penny_drop_status, is_active FROM customer_bank_accounts WHERE id=$1', [bankId])).rows[0] as any;

    const r = await a.patch(`/api/customers/${cid}/bank-accounts/${bankId}`, { holder_name: 'V DENKATACHALAM GOVINDARAJ' });
    expect(r.status).toBe(200);

    const after = (await ctx.db.query('SELECT holder_name, penny_drop_status, is_active FROM customer_bank_accounts WHERE id=$1', [bankId])).rows[0] as any;
    expect(after.holder_name).toBe('V DENKATACHALAM GOVINDARAJ');
    // Identity + verification untouched — this is a name correction, not a new account.
    expect(after.penny_drop_status).toBe(before.penny_drop_status);
    expect(after.is_active).toBe(before.is_active);
    // Still exactly one account: no duplicate was created to achieve this.
    const n = await ctx.db.query('SELECT count(*) AS n FROM customer_bank_accounts WHERE customer_id=$1', [cid]);
    expect(Number((n.rows[0] as any).n)).toBe(1);
  });

  it('the rename is audited with the old and new name', async () => {
    const { cid, bankId } = await customerWithBank('9922000002', 'Wrong Speling');
    await (await admin()).patch(`/api/customers/${cid}/bank-accounts/${bankId}`, { holder_name: 'Correct Spelling' });
    const log = (await ctx.db.query(
      "SELECT before_data, after_data FROM audit_log WHERE action='customer.bank.rename' AND entity_id=$1", [String(bankId)])).rows[0] as any;
    expect(log.before_data.holder_name).toBe('Wrong Speling');
    expect(log.after_data.holder_name).toBe('Correct Spelling');
  });

  it('a blank name is refused, and an unknown account 404s', async () => {
    const { cid, bankId } = await customerWithBank('9922000003', 'Someone');
    const a = await admin();
    expect((await a.patch(`/api/customers/${cid}/bank-accounts/${bankId}`, { holder_name: ' ' })).status).toBe(400);
    expect((await a.patch(`/api/customers/${cid}/bank-accounts/999999`, { holder_name: 'Nobody' })).status).toBe(404);
  });

  it('re-adding the same account still refuses — but now says to edit instead', async () => {
    const { cid } = await customerWithBank('9922000004', 'Typo Name');
    const a = await admin();
    const dup = await a.post(`/api/customers/${cid}/bank-accounts`,
      { account_number: '1126115000000004', ifsc: 'KVBL0001126', holder_name: 'Fixed Name' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.message).toMatch(/Edit name/i);
  });
});

describe('a failed penny-drop must not strand the customer', () => {
  it('an unverified account can be retried, and force-activated with a reason', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Stranded', phone: '9933000001' });
    const cid = Number(cust.json.id);
    // Two accounts: one Active-but-unverified (as migrated rows really are),
    // and the CORRECT one whose penny-drop failed.
    const good = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '01701050007260', ifsc: 'HDFC0000178' });
    const goodId = Number(good.json.id);
    await ctx.db.query("UPDATE customer_bank_accounts SET penny_drop_status='Failed', is_active=FALSE WHERE id=$1", [goodId]);

    // Plain activation is refused, and says what to do about it.
    const refused = await a.post(`/api/customers/${cid}/bank-accounts/${goodId}/set-active`, {});
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/Retry the verification/i);

    // Forcing without a reason is refused too — the override must be explained.
    expect((await a.post(`/api/customers/${cid}/bank-accounts/${goodId}/set-active`, { force: true })).status).toBe(400);

    // Forced WITH a reason works, and the reason is on the audit trail.
    const ok = await a.post(`/api/customers/${cid}/bank-accounts/${goodId}/set-active`, { force: true, reason: 'confirmed on a bank statement' });
    expect(ok.status).toBe(200);
    expect((await ctx.db.query('SELECT is_active FROM customer_bank_accounts WHERE id=$1', [goodId])).rows[0].is_active).toBe(true);
    const log = (await ctx.db.query(
      "SELECT after_data FROM audit_log WHERE action='customer.bank.set-active' AND entity_id=$1 ORDER BY id DESC LIMIT 1", [String(goodId)])).rows[0] as any;
    expect(log.after_data.forced).toBe(true);
    expect(log.after_data.reason).toMatch(/bank statement/);
  });

  it('retrying re-runs the penny drop; an account with no IFSC says so', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Retry Me', phone: '9933000002' });
    const cid = Number(cust.json.id);
    const bank = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '12345678901', ifsc: 'HDFC0001234' });
    const bid = Number(bank.json.id);
    await ctx.db.query("UPDATE customer_bank_accounts SET penny_drop_status='Failed' WHERE id=$1", [bid]);

    const r = await a.post(`/api/customers/${cid}/bank-accounts/${bid}/reverify`, {});
    expect(r.status).toBe(200);
    expect(r.json.pennyDrop.status).toBe('Verified');   // stub verifies a good account
    expect((await ctx.db.query('SELECT penny_drop_status FROM customer_bank_accounts WHERE id=$1', [bid])).rows[0].penny_drop_status).toBe('Verified');

    // A migrated row with no IFSC cannot be verified — say that plainly.
    await ctx.db.query('UPDATE customer_bank_accounts SET ifsc = NULL WHERE id=$1', [bid]);
    const noIfsc = await a.post(`/api/customers/${cid}/bank-accounts/${bid}/reverify`, {});
    expect(noIfsc.status).toBe(422);
    expect(noIfsc.json.error.message).toMatch(/no IFSC/i);
  });
});
