/**
 * Super-admin delete/archive of customers & investments (owner spec 2026-07-21).
 * - Only super_admin holds customers:delete / applications:delete; admin is 403.
 * - Archive hides a record from the applications list; unarchive restores it.
 * - Hard delete purges the application (and cascades a customer's apps).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123'); // seeded super_admin
const plainAdmin = () => as('admin@demo.local');                        // seeded admin (NOT super)

async function makeCustomerWithApp(sa: Client) {
  const cust = await sa.post('/api/customers', { full_name: 'Purge Target', phone: '9700055501' });
  const app = await sa.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
  });
  return { custId: Number(cust.json.id), appId: Number(app.json.id), app };
}

describe('super-admin delete/archive — permission boundary', () => {
  it('a plain admin cannot archive or delete a customer or an investment', async () => {
    const sa = await superAdmin();
    const admin = await plainAdmin();
    const { custId, appId } = await makeCustomerWithApp(sa);

    expect((await admin.post(`/api/customers/${custId}/archive`, {})).status).toBe(403);
    expect((await admin.del(`/api/customers/${custId}`, { confirm: true, reason: 'nope' })).status).toBe(403);
    expect((await admin.post(`/api/applications/${appId}/archive`, {})).status).toBe(403);
    expect((await admin.del(`/api/applications/${appId}`, { confirm: true, reason: 'nope' })).status).toBe(403);
  });
});

describe('super-admin archive — hides then restores', () => {
  it('archiving an investment removes it from the list; unarchive brings it back', async () => {
    const sa = await superAdmin();
    const { appId } = await makeCustomerWithApp(sa);

    const inList = async (showArchived = false) => {
      const r = await sa.get(`/api/applications${showArchived ? '?showArchived=true' : ''}`);
      return (r.json.rows as any[]).some((a) => Number(a.id) === appId);
    };

    expect(await inList()).toBe(true);
    expect((await sa.post(`/api/applications/${appId}/archive`, { reason: 'entered twice' })).status).toBe(200);
    expect(await inList()).toBe(false);          // hidden by default
    expect(await inList(true)).toBe(true);        // visible with the super-admin toggle
    expect((await sa.post(`/api/applications/${appId}/unarchive`, {})).status).toBe(200);
    expect(await inList()).toBe(true);            // restored
  });
});

describe('super-admin hard delete — purges the record', () => {
  it('deletes an investment (confirm + reason required) and it is gone', async () => {
    const sa = await superAdmin();
    const { appId } = await makeCustomerWithApp(sa);

    // Missing confirm/reason → 400, not a silent delete.
    expect((await sa.del(`/api/applications/${appId}`, {})).status).toBe(400);

    const del = await sa.del(`/api/applications/${appId}`, { confirm: true, reason: 'duplicate entry' });
    expect(del.status).toBe(200);
    expect((await sa.get(`/api/applications/${appId}`)).status).toBe(404);
    const rows = (await ctx.db.query('SELECT id FROM applications WHERE id = $1', [appId])).rows;
    expect(rows.length).toBe(0);
  });

  it('deleting a customer cascades their investments away', async () => {
    const sa = await superAdmin();
    const { custId, appId } = await makeCustomerWithApp(sa);

    const del = await sa.del(`/api/customers/${custId}`, { confirm: true, reason: 'test record' });
    expect(del.status).toBe(200);
    expect(Number(del.json.applications_deleted)).toBe(1);
    expect((await ctx.db.query('SELECT id FROM customers WHERE id = $1', [custId])).rows.length).toBe(0);
    expect((await ctx.db.query('SELECT id FROM applications WHERE id = $1', [appId])).rows.length).toBe(0);
  });
});
