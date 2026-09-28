/**
 * Renaming a VERIFIED beneficiary must not keep the verification (owner
 * 2026-09-28: "when im editing an bank account nenificery name after its been
 * verified - the name changes and no verification is made - this cannot and
 * should not happen").
 *
 * Verified meant: the bank confirmed THIS name holds THIS account. The penny
 * drop sends the name and matches on it, and nothing writes the bank's answer
 * back over ours — so a rename afterwards left the badge vouching for a name
 * that had been replaced. On the live book 128 accounts had been renamed while
 * Verified, some materially (PALANISAMY S → PALANISAMY SUBBARAYAN).
 *
 * holder_name is the beneficiary on the NEFT file, so this is the name money is
 * actually sent to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let customerId = 0;
beforeAll(async () => {
  ctx = await startTestServer();
  const a = await admin();
  const c = await a.post('/api/customers', { full_name: 'Bank Rename', phone: '9568000001' });
  customerId = Number(c.json.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

/** An account sitting at Verified, however the test env's penny drop behaves. */
async function verifiedAccount(a: Client, holder: string, acct: string): Promise<number> {
  const r = await a.post(`/api/customers/${customerId}/bank-accounts`, {
    account_number: acct, ifsc: 'SBIN0004236', holder_name: holder,
  });
  const id = Number(r.json.id ?? r.json.bank_account?.id
    ?? (await ctx.db.query('SELECT id FROM customer_bank_accounts WHERE account_number = $1', [acct])).rows[0]!.id);
  await ctx.db.query(
    "UPDATE customer_bank_accounts SET penny_drop_status = 'Verified', verified_at = now() WHERE id = $1", [id]);
  return id;
}
const state = async (id: number) => (await ctx.db.query<{ holder_name: string; penny_drop_status: string; verified_at: string | null }>(
  'SELECT holder_name, penny_drop_status, verified_at FROM customer_bank_accounts WHERE id = $1', [id])).rows[0]!;

describe('renaming a verified beneficiary', () => {
  it('clears the verification when the name really changes', async () => {
    const a = await admin();
    const id = await verifiedAccount(a, 'PALANISAMY S', '34439275001');
    expect((await state(id)).penny_drop_status).toBe('Verified');

    const r = await a.patch(`/api/customers/${customerId}/bank-accounts/${id}`, { holder_name: 'PALANISAMY SUBBARAYAN' });
    expect(r.status).toBe(200);
    expect(r.json.verification_cleared).toBe(true);

    const after = await state(id);
    expect(after.holder_name).toBe('PALANISAMY SUBBARAYAN');
    expect(after.penny_drop_status).toBe('Pending');   // NOT Verified
    expect(after.verified_at).toBeNull();
  });

  it('says why, on the record', async () => {
    const d = (await ctx.db.query<{ penny_drop_detail: string }>(
      `SELECT penny_drop_detail FROM customer_bank_accounts WHERE account_number = '34439275001'`)).rows[0]!;
    expect(d.penny_drop_detail).toContain('PALANISAMY S');
    expect(d.penny_drop_detail).toContain('PALANISAMY SUBBARAYAN');
  });

  it('adding a title counts as a change — that is what breaks the penny drop', async () => {
    const a = await admin();
    const id = await verifiedAccount(a, 'SAROJA J', '34439275002');
    await a.patch(`/api/customers/${customerId}/bank-accounts/${id}`, { holder_name: 'Mrs Saroja J' });
    expect((await state(id)).penny_drop_status).toBe('Pending');
  });

  it('a change of CASE or punctuation keeps it — the bank reads the same name', async () => {
    // Invalidating these would be noise, and noise teaches people to click past
    // the warning that matters.
    const a = await admin();
    const id = await verifiedAccount(a, 'SATHYA CHANDRASEKAR', '34439275003');
    const r = await a.patch(`/api/customers/${customerId}/bank-accounts/${id}`, { holder_name: 'Sathya Chandrasekar' });
    expect(r.json.verification_cleared).toBe(false);

    const after = await state(id);
    expect(after.holder_name).toBe('Sathya Chandrasekar');
    expect(after.penny_drop_status).toBe('Verified');
    expect(after.verified_at).not.toBeNull();
  });

  it('an account that was never verified is just renamed, so a failed drop can be retried', async () => {
    // The repair path this button exists for: Decentro rejects the "." in
    // "Mr.", staff fix the name, then re-verify.
    const a = await admin();
    const r0 = await a.post(`/api/customers/${customerId}/bank-accounts`, {
      account_number: '34439275004', ifsc: 'SBIN0004236', holder_name: 'Mr. Kumar V',
    });
    const id = Number((await ctx.db.query(
      `SELECT id FROM customer_bank_accounts WHERE account_number = '34439275004'`)).rows[0]!.id);
    await ctx.db.query("UPDATE customer_bank_accounts SET penny_drop_status = 'Failed' WHERE id = $1", [id]);
    expect(r0.status).toBeLessThan(300);

    const r = await a.patch(`/api/customers/${customerId}/bank-accounts/${id}`, { holder_name: 'Kumar V' });
    expect(r.status).toBe(200);
    expect(r.json.verification_cleared).toBe(false);   // nothing to clear
    expect((await state(id)).holder_name).toBe('Kumar V');
  });

  it('records the status change in the audit trail', async () => {
    const rows = (await ctx.db.query<{ before: string; after: string }>(
      `SELECT before_data::text AS before, after_data::text AS after FROM audit_log
        WHERE action = 'customer.bank.rename' AND after_data->>'verification_cleared' = 'true'
        ORDER BY id DESC LIMIT 1`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.before).toContain('Verified');
    expect(rows[0]!.after).toContain('Pending');
  });
});
