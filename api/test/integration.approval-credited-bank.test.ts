/**
 * The approver can record which Dhanam bank account the money was credited to
 * (owner 2026-08-10). collection_bank_id joined the approver-correctable fields,
 * so approving with that edit stamps it on the investment — and the editable
 * payload/round-trips the current value.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let bankId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  bankId = Number((await ctx.db.query(
    `INSERT INTO banks (account_label, bank_name, account_number, is_collection_account, is_active)
     VALUES ('NCD Escrow SBI', 'State Bank of India', '44886972753', TRUE, TRUE) RETURNING id`)).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('approver records which Dhanam account the money was credited to', () => {
  it('approving with a collection_bank_id correction stamps it on the investment', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');

    const cust = await a.post('/api/customers', { full_name: 'Credited Cust', phone: '9700000456' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '77779700000456', ifsc: 'ICIC0001111' });
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-10',
    });
    const appId = Number(create.json.id);
    const reqId = create.json.subscription_request.id;

    // Starts unset — nobody chose an account at enrolment.
    const before = (await ctx.db.query('SELECT collection_bank_id FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(before.collection_bank_id).toBeNull();

    // The editable payload exposes the field (null now) so the form can render it.
    const detail = await ncd.get(`/api/approvals/${reqId}`);
    expect(detail.json.editable.fields).toHaveProperty('collection_bank_id');
    expect(detail.json.editable.fields.collection_bank_id).toBeNull();

    // Checker approves, choosing the credited account.
    const ok = await ncd.post(`/api/approvals/${reqId}/approve`, { extra: { edits: { collection_bank_id: bankId } } });
    expect(ok.status).toBe(200);

    const after = (await ctx.db.query('SELECT status, collection_bank_id FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(after.status).toBe('Active');
    expect(Number(after.collection_bank_id)).toBe(bankId);
  });
});
