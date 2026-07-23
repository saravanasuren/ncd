/**
 * Locker tenants, branch-wise (sidebar page).
 *
 * The roster comes from LockerHub's /locker-tenants; NCD's own pledges and
 * cheques are layered on, and lockers of ours that aren't allotted yet are
 * appended. LockerHub isn't configured under test, so these pin the degraded
 * path: the page still renders NCD's rows, and it must NOT claim a complete
 * roster when it couldn't read one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let custId: number, appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const c = await a.post('/api/customers', { full_name: 'Tenant Cust', phone: '9510000001' });
  custId = c.json.id;
  const app = await a.post('/api/applications', {
    customer_id: custId, series_id: seriesId, scheme_id: schemeId, amount: 300000, date_money_received: '2026-07-12',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  appId = Number(app.json.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('locker tenants (branch-wise)', () => {
  it('is empty but well-formed when NCD knows of no lockers', async () => {
    const r = await (await admin()).get('/api/lockers/tenants');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
    // LockerHub is unreachable under test, so the roster was never read —
    // the payload must say so rather than presenting itself as complete.
    expect(r.json.roster_complete).toBe(false);
    expect(r.json).toHaveProperty('branches_read');
    expect(r.json).toHaveProperty('branches_total');
  });

  it('marks NCD-backed rows, so the page can separate them from plain tenants', async () => {
    const r = await (await admin()).get('/api/lockers/tenants');
    // Every row we produce without a roster is one of ours, by definition.
    expect((r.json.rows as any[]).every((x) => x.ncd_backed === true)).toBe(true);
  });

  it('surfaces a locker NCD backs, carrying our customer through', async () => {
    await ctx.db.query(
      `INSERT INTO locker_deposit_links (application_id, lockerhub_application_id, linked_amount, linked_by_user_id)
       VALUES ($1, 'la_tenant_1', 300000, 1)`, [appId]);
    const r = await (await admin()).get('/api/lockers/tenants');
    expect(r.status).toBe(200);
    const row = (r.json.rows as any[]).find((x) => x.lockerhub_application_id === 'la_tenant_1');
    expect(row).toBeTruthy();
    expect(row.customer_id).toBe(custId);
    expect(row.tenant_name).toBeTruthy();
    expect(row.pledged_amount).toBe(300000);
  });

  it('includes a locker known only from a recorded cheque', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.post('/api/lockers/cheques', {
      lockerhub_application_id: 'la_tenant_cheque', customer_id: custId, leg: 'rent',
      amount: 7080, cheque_no: 'CHQ-T1', received_on: '2026-07-22',
    })).status).toBe(201);
    const r = await (await admin()).get('/api/lockers/tenants');
    const row = (r.json.rows as any[]).find((x) => x.lockerhub_application_id === 'la_tenant_cheque');
    expect(row).toBeTruthy();
    expect(row.cheque_pending).toBe(true);
  });

  it('degrades to unresolved rows when LockerHub cannot be reached', async () => {
    // LockerHub isn't configured under test, so every resolve fails — the page
    // must still render rows rather than 500.
    const r = await (await admin()).get('/api/lockers/tenants');
    expect(r.status).toBe(200);
    expect((r.json.rows as any[]).every((x) => typeof x.lockerhub_application_id === 'string')).toBe(true);
    expect(r.json).toHaveProperty('lockerhub_error');
  });

  it('needs lockers:enroll', async () => {
    const agent = await as('agent@demo.local');
    expect((await agent.get('/api/lockers/tenants')).status).toBe(403);
  });
});
