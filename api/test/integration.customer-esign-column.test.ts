/**
 * The customer's investments list shows eSign state per application, so staff
 * can see at a glance which are signed without opening each one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('customer investments — eSign state', () => {
  it('reports esigned_at + has_signed_copy per investment', async () => {
    const a = new Client(ctx.base);
    await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Esign Column Cust', phone: '9660000001' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });

    // Unsigned → the column reads "not signed".
    let row = (await a.get(`/api/customers/${cust.json.id}`)).json.applications.find((x: any) => x.id === app.json.id);
    expect(row).toBeTruthy();
    expect(row.esigned_at).toBeNull();
    expect(row.has_signed_copy).toBe(false);

    // Signed → stamped, still no stored copy (stub mode stores none).
    await a.post(`/api/applications/${app.json.id}/mark-esigned`);
    row = (await a.get(`/api/customers/${cust.json.id}`)).json.applications.find((x: any) => x.id === app.json.id);
    expect(row.esigned_at).not.toBeNull();
    expect(row.has_signed_copy).toBe(false);
  });
});
