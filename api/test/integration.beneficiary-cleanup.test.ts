/**
 * Beneficiary-name cleanup (owner 2026-08-26): list every bank account whose
 * holder name carries a bank-hostile character (. , - /), fix it via the ordinary
 * rename, and it drops off the list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

async function custWithBank(a: Client, name: string, phone: string, account: string, holder: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: account, ifsc: 'ICIC0001234', holder_name: holder });
  const bank = (await ctx.db.query('SELECT id FROM customer_bank_accounts WHERE account_number = $1', [account])).rows[0]!;
  return { customerId: Number(cust.json.id), bankId: Number(bank.id) };
}
const flagged = async (a: Client) => (await a.get('/api/customers/beneficiary-cleanup')).json.rows as any[];

describe('beneficiary name cleanup', () => {
  it('lists only the accounts whose holder name has . , - /, and clearing it removes it', async () => {
    const a = await admin();
    const dotted = await custWithBank(a, 'Sathish B', '9707000001', '500000111', 'B.Sathish');   // dot → flagged
    await custWithBank(a, 'Clean Name', '9707000002', '500000222', 'Clean Name');                 // no special char → not flagged

    const list = await flagged(a);
    expect(list.some((r) => r.id === dotted.bankId && r.holder_name === 'B.Sathish')).toBe(true);
    expect(list.some((r) => r.holder_name === 'Clean Name')).toBe(false);

    // Fix it via the ordinary rename endpoint.
    const patch = await a.patch(`/api/customers/${dotted.customerId}/bank-accounts/${dotted.bankId}`, { holder_name: 'B Sathish' });
    expect(patch.status).toBe(200);

    // Gone from the cleanup list.
    expect((await flagged(a)).some((r) => r.id === dotted.bankId)).toBe(false);
    // And the name actually changed.
    expect(String((await ctx.db.query('SELECT holder_name FROM customer_bank_accounts WHERE id=$1', [dotted.bankId])).rows[0]!.holder_name)).toBe('B Sathish');
  });

  it('needs the customers:update permission', async () => {
    const viewer = new Client(ctx.base);
    // A read-only-ish role: CXO has customers:read but not customers:update.
    await viewer.post('/api/auth/login', { email: 'cxo@demo.local', password: 'Demo_1234' });
    const r = await viewer.get('/api/customers/beneficiary-cleanup');
    expect(r.status).toBe(403);
  });
});
