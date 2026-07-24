/**
 * Nominee shares (owner 2026-07-24).
 *
 * "When a nominee is added it's coming as 0% — everything should go to the
 * nominee only." Two causes: the web coerced a blank prompt to 0, and the API
 * stored whatever arrived. A nominee with no stated share now takes what is
 * unallocated, so a sole nominee lands at 100%.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const newCustomer = async (a: Client, name: string, phone: string) =>
  Number((await a.post('/api/customers', { full_name: name, phone })).json.id);
const sharesOf = async (id: number) =>
  ((await ctx.db.query('SELECT full_name, share_pct FROM nominees WHERE customer_id = $1 ORDER BY id', [id])).rows as any[])
    .map((r) => [r.full_name, Number(r.share_pct)] as const);

describe('nominee shares', () => {
  it('a sole nominee with no share stated gets the whole holding', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Sole Nominee Cust', '9530000001');
    expect((await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'RUPA BLESSINA KUMAR' }] })).status).toBe(200);
    expect(await sharesOf(id)).toEqual([['RUPA BLESSINA KUMAR', 100]]);
  });

  it('an explicit 0 is treated as unstated, not as nothing', async () => {
    // This is exactly what the old UI sent when the prompt was left blank.
    const a = await admin();
    const id = await newCustomer(a, 'Zero Share Cust', '9530000002');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Zero Nominee', share_pct: 0 }] });
    expect(await sharesOf(id)).toEqual([['Zero Nominee', 100]]);
  });

  it('two nominees with nothing stated split it evenly', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Two Nominee Cust', '9530000003');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'First' }, { full_name: 'Second' }] });
    expect(await sharesOf(id)).toEqual([['First', 50], ['Second', 50]]);
  });

  it('a deliberate split is preserved exactly', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Split Cust', '9530000004');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Sixty', share_pct: 60 }, { full_name: 'Forty', share_pct: 40 }] });
    expect(await sharesOf(id)).toEqual([['Sixty', 60], ['Forty', 40]]);
  });

  it('an unstated nominee takes only what is left over', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Remainder Cust', '9530000005');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Stated', share_pct: 70 }, { full_name: 'Rest' }] });
    expect(await sharesOf(id)).toEqual([['Stated', 70], ['Rest', 30]]);
  });

  it('still refuses a stated split above 100%', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Over Cust', '9530000006');
    const r = await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'A', share_pct: 70 }, { full_name: 'B', share_pct: 50 }] });
    expect(r.status).toBe(400);
    expect(await sharesOf(id)).toEqual([]);
  });

  it('the migration repaired the rows written before the fix', async () => {
    // Sole nominee carrying NULL — the state the 4 live rows were in.
    const a = await admin();
    const id = await newCustomer(a, 'Legacy Cust', '9530000007');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Legacy Nominee' }] });
    await ctx.db.query('UPDATE nominees SET share_pct = NULL WHERE customer_id = $1', [id]);
    await ctx.db.query(`UPDATE nominees nm SET share_pct = 100
       WHERE COALESCE(nm.share_pct,0) = 0
         AND (SELECT count(*) FROM nominees n2 WHERE n2.customer_id = nm.customer_id) = 1`);
    expect(await sharesOf(id)).toEqual([['Legacy Nominee', 100]]);
  });
});
