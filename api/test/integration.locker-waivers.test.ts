/**
 * Locker deposit waivers (owner 2026-07-24).
 *
 * A tenant can hold a locker with NO NCD backing by deliberate exception. NCD
 * Manager+ records the waiver with a mandatory reason; Admin/CXO approves it;
 * the Locker Tenants roster tags the tenancy. Purely informational.
 *
 * LockerHub is unreachable under test, so the roster is empty — which also
 * pins the resilience rule: an open waiver whose tenancy isn't in the roster
 * is appended from its snapshot rather than silently disappearing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const TENANT = {
  lockerhub_tenant_id: 'tn_waiver_1', reason: 'Deposit waived — long-standing HNI, owner instruction',
  locker_no: 'L6-99', branch_id: 'br_test', tenant_name: 'Waiver Tenant', tenant_phone: '9811110001',
};

describe('locker deposit waivers', () => {
  let waiverId = 0, reqId = 0;

  it('branch staff hold lockers:enroll but cannot waive', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.post('/api/lockers/waivers', TENANT)).status).toBe(403);
  });

  it('a reason is mandatory', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post('/api/lockers/waivers', { ...TENANT, reason: '' })).status).toBe(400);
  });

  it('NCD manager records → PendingApproval; the roster shows it as pending', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/lockers/waivers', TENANT);
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PendingApproval');
    waiverId = r.json.id; reqId = r.json.request_id;

    // Only one OPEN waiver per tenancy.
    expect((await ncd.post('/api/lockers/waivers', TENANT)).status).toBe(409);

    const roster = await ncd.get('/api/lockers/tenants');
    const row = (roster.json.rows as any[]).find((x) => x.tenant_id === TENANT.lockerhub_tenant_id);
    expect(row).toBeTruthy();
    expect(row.waiver_status).toBe('PendingApproval');
    expect(row.tenant_name).toBe('Waiver Tenant');
    expect(row.ncd_backed).toBe(false);
  });

  it('the maker cannot approve; CXO can — the roster row becomes waived with the reason', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/approvals/${reqId}/approve`)).status).toBe(403);

    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/approvals/${reqId}/approve`)).status).toBe(200);

    const roster = await ncd.get('/api/lockers/tenants');
    const row = (roster.json.rows as any[]).find((x) => x.tenant_id === TENANT.lockerhub_tenant_id);
    expect(row.waiver_status).toBe('Approved');
    expect(row.waiver_reason).toBe(TENANT.reason);
  });

  it('cancelling releases the tenancy for a fresh waiver, and withdraws a pending request', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/lockers/waivers/${waiverId}/cancel`, {})).status).toBe(200);
    const gone = await ncd.get('/api/lockers/tenants');
    expect((gone.json.rows as any[]).find((x) => x.tenant_id === TENANT.lockerhub_tenant_id)).toBeFalsy();

    // Fresh one on the same tenancy is allowed now; cancelling it while
    // PENDING also cancels its approval request.
    const again = await ncd.post('/api/lockers/waivers', { ...TENANT, reason: 'second attempt' });
    expect(again.status).toBe(201);
    expect((await ncd.post(`/api/lockers/waivers/${again.json.id}/cancel`, {})).status).toBe(200);
    const req = (await ctx.db.query('SELECT status FROM approval_requests WHERE id = $1', [again.json.request_id])).rows[0]!;
    expect(req.status).toBe('Cancelled');
  });

  it('a rejected waiver does not tag the roster', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/lockers/waivers', { ...TENANT, lockerhub_tenant_id: 'tn_waiver_2', reason: 'to be rejected' });
    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/approvals/${r.json.request_id}/reject`, { reason: 'not justified' })).status).toBe(200);
    const roster = await ncd.get('/api/lockers/tenants');
    expect((roster.json.rows as any[]).find((x) => x.tenant_id === 'tn_waiver_2')).toBeFalsy();
    const stored = (await ctx.db.query('SELECT status FROM locker_deposit_waivers WHERE id = $1', [r.json.id])).rows[0]!;
    expect(stored.status).toBe('Rejected');
  });
});
