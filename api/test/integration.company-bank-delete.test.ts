/**
 * Deleting a COMPANY bank account (Masters → Company bank accounts). The owner
 * asked for a delete option (2026-08-20) to clear out redundant/duplicate
 * labels. The only thing that pins to a company bank is an application's
 * collection bank — that's real history, so a bank used there is refused;
 * anything else deletes cleanly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function makeBank(label: string) {
  const r = await (await admin()).post('/api/banks',
    { account_label: label, bank_name: 'State Bank of India', account_number: '44886972753', ifsc: 'SBIN0012778', is_collection_account: true });
  expect(r.status).toBe(201);
  return Number(r.json.id);
}

describe('deleting a company bank account', () => {
  it('an unused account deletes cleanly and disappears from the list', async () => {
    const id = await makeBank('Delete Me — Test');
    const a = await admin();
    expect((await a.del(`/api/banks/${id}`)).status).toBe(200);
    const rows = (await a.get('/api/banks')).json.rows as any[];
    expect(rows.find((b) => Number(b.id) === id)).toBeUndefined();
    // and it's on the audit trail
    const log = await ctx.db.query("SELECT before_data FROM audit_log WHERE action='bank.delete' AND entity_id=$1", [String(id)]);
    expect((log.rows[0] as any).before_data.account_label).toBe('Delete Me — Test');
  });

  it('refuses when the account is an application’s collection bank', async () => {
    const id = await makeBank('In Use — Test');
    const a = await admin();
    // Create an application and pin this bank as its collection bank (real history).
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Coll Bank Holder', phone: '9701119999' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    const upd = await ctx.db.query('UPDATE applications SET collection_bank_id = $1 WHERE id = $2', [id, Number(app.json.id)]);
    expect(upd.rowCount).toBe(1);
    const r = await a.del(`/api/banks/${id}`);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/collection bank/i);
    // Still there.
    expect(((await a.get('/api/banks')).json.rows as any[]).find((b) => Number(b.id) === id)).toBeTruthy();
  });

  it('an unknown id 404s, and the route is not public', async () => {
    expect((await (await admin()).del('/api/banks/99999999')).status).toBe(404);
    const anon = await fetch(`${ctx.base}/api/banks/1`, { method: 'DELETE' });
    expect(anon.status).toBeGreaterThanOrEqual(401); // guarded (401/403), never allowed through
    expect(anon.status).toBeLessThan(404);
  });
});
