/**
 * NCD-side overrides on LockerHub's tenant roster (owner 2026-07-24).
 *
 *  · LINK — automatic matching needs phone AND a full name agreement, so a
 *    tenant recorded as "SEENU RAJAPPA" never matches our customer "SEENU".
 *    PAN would settle it, but LockerHub exposes none (their customer `profile`
 *    is null for these tenants; where a profile exists the PAN is masked), so
 *    the mechanism is an explicit human choice.
 *  · REMOVE — super_admin only, and NCD-side only: LockerHub owns the tenancy
 *    and offers no close/delete endpoint, so the locker stays allotted there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let custId = 0, custCode = '';
const TENANT = 'tn_override_1';

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await admin();
  const c = await a.post('/api/customers', { full_name: 'SEENU', phone: '9660000001' });
  custId = c.json.id; custCode = c.json.customer_code;
  // A tenancy NCD knows about only through a cheque, so it appears on the
  // roster even though LockerHub is unreachable under test.
  await a.post('/api/lockers/cheques', {
    lockerhub_application_id: 'la_override_1', customer_id: custId, leg: 'rent',
    amount: 7080, cheque_no: 'CHQ-OV1', received_on: '2026-07-22',
  });
});
afterAll(async () => { await ctx.close(); });

const rosterRow = async (c: Client, tenantId: string) =>
  ((await c.get('/api/lockers/tenants')).json.rows as any[]).find((r) => r.tenant_id === tenantId);

describe('locker tenant — manual link', () => {
  it('branch staff cannot link; NCD manager can, and the roster carries the customer through', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.post(`/api/lockers/tenants/${TENANT}/link`, { customer_id: custId })).status).toBe(403);

    const ncd = await as('ncd@demo.local');
    const r = await ncd.post(`/api/lockers/tenants/${TENANT}/link`, {
      customer_id: custId, tenant_name: 'SEENU RAJAPPA', locker_no: 'L6-4', branch_id: 'br_test',
    });
    expect(r.status).toBe(200);

    // The link surfaces as a waiver-style overlay row would: it is an override,
    // so it must reach the roster even though the tenancy is not in the feed.
    const stored = (await ctx.db.query(
      'SELECT customer_id, tenant_name, locker_no FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1', [TENANT])).rows[0]!;
    expect(Number(stored.customer_id)).toBe(custId);
    expect(stored.tenant_name).toBe('SEENU RAJAPPA');
  });

  it('a link to a non-existent customer is refused, and the link can be cleared', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/lockers/tenants/${TENANT}/link`, { customer_id: 999999 })).status).toBe(404);

    expect((await ncd.post(`/api/lockers/tenants/${TENANT}/link`, { customer_id: null })).status).toBe(200);
    const cleared = (await ctx.db.query(
      'SELECT customer_id, linked_at FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1', [TENANT])).rows[0]!;
    expect(cleared.customer_id).toBeNull();
    expect(cleared.linked_at).toBeNull();

    // Re-link for the next test.
    await ncd.post(`/api/lockers/tenants/${TENANT}/link`, { customer_id: custId, tenant_name: 'SEENU RAJAPPA' });
  });

  it('a hand-made link beats automatic matching, including on a not-yet-allotted row', async () => {
    // A cheque-only row has NO tenant_id (LockerHub mints one at allotment), so
    // it keys on our lockerhub_application_id via override_key. Without that
    // fallback these rows could never be linked or removed at all.
    const a = await admin();
    const other = await a.post('/api/customers', { full_name: 'Override Target', phone: '9660000002' });
    const rows = (await a.get('/api/lockers/tenants')).json.rows as any[];
    const cheque = rows.find((r) => r.lockerhub_application_id === 'la_override_1');
    expect(cheque).toBeTruthy();
    expect(cheque.tenant_id).toBeFalsy();                    // not allotted → no tenant_id
    expect(cheque.override_key).toBe('la_override_1');       // …but still addressable

    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/lockers/tenants/${encodeURIComponent(cheque.override_key)}/link`,
      { customer_id: other.json.id })).status).toBe(200);

    const after = ((await a.get('/api/lockers/tenants')).json.rows as any[])
      .find((r) => r.lockerhub_application_id === 'la_override_1');
    expect(after).toBeTruthy();
    expect(after.customer_id).toBe(other.json.id);           // overrides the cheque's own customer
    expect(after.linked_manually).toBe(true);
  });
});

describe('locker tenant — remove from the NCD roster', () => {
  it('only super_admin may remove, and a reason is required', async () => {
    const ncd = await as('ncd@demo.local');   // holds lockers:waive, not remove-tenant
    expect((await ncd.post(`/api/lockers/tenants/${TENANT}/remove`, { reason: 'ended' })).status).toBe(403);

    const a = await admin();                   // super_admin
    expect((await a.post(`/api/lockers/tenants/${TENANT}/remove`, { reason: '' })).status).toBe(400);
    expect((await a.post(`/api/lockers/tenants/${TENANT}/remove`, { reason: 'tenancy closed at the branch' })).status).toBe(200);
  });

  it('a removed tenancy leaves the roster and can be restored', async () => {
    const a = await admin();
    expect(await rosterRow(a, TENANT)).toBeFalsy();

    const stored = (await ctx.db.query(
      'SELECT removed_at, removed_reason FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1', [TENANT])).rows[0]!;
    expect(stored.removed_at).toBeTruthy();
    expect(stored.removed_reason).toBe('tenancy closed at the branch');

    expect((await a.post(`/api/lockers/tenants/${TENANT}/restore`, {})).status).toBe(200);
    const back = (await ctx.db.query(
      'SELECT removed_at FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1', [TENANT])).rows[0]!;
    expect(back.removed_at).toBeNull();
    // Restoring something that isn't removed is a 404, not a silent success.
    expect((await a.post(`/api/lockers/tenants/${TENANT}/restore`, {})).status).toBe(404);
  });

  it('removing a tenancy that has an open waiver keeps it off the roster', async () => {
    const ncd = await as('ncd@demo.local');
    const w = await ncd.post('/api/lockers/waivers', {
      lockerhub_tenant_id: 'tn_override_2', reason: 'exception case, no NCD backing',
      tenant_name: 'Waived And Removed', locker_no: 'L6-9',
    });
    expect(w.status).toBe(201);
    const a = await admin();
    expect(await rosterRow(a, 'tn_override_2')).toBeTruthy();   // waiver puts it on the roster

    expect((await a.post('/api/lockers/tenants/tn_override_2/remove', { reason: 'duplicate row' })).status).toBe(200);
    // The waiver overlay must not resurrect a removed tenancy.
    expect(await rosterRow(a, 'tn_override_2')).toBeFalsy();
  });
});
