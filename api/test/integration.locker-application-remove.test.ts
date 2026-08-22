/**
 * Deleting a locker application entered by mistake (owner 2026-08-20).
 *
 * Super-Admin only. It HIDES the application from NCD — it does not delete it on
 * LockerHub, which exposes no delete for an application. The hide is what makes
 * both the customer's profile note and the tenants roster stop showing it, so
 * the row it writes (keyed on the LockerHub application id) is what those screens
 * filter on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('removing a locker application', () => {
  it('a Super Admin cancels it on LockerHub — reason on the audit trail, and an override row to filter on', async () => {
    // Since A23 (2026-08-22) this is a REAL cancel, not a local hide: the call
    // goes to LockerHub first and we only record it here if they accepted.
    // LockerHub is not reachable from the test server, so stand in for it.
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication')
      .mockResolvedValue({ success: true, status: 'cancelled', locker_released: null });
    try {
    const appId = 'APP-2026-01122';
    const r = await (await superAdmin()).post(`/api/lockers/applications/${appId}/remove`, { reason: 'entered by mistake' });
    expect(r.status).toBe(200);
    expect(r.json.cancelled).toBe(true);
    expect(spy).toHaveBeenCalled();

    // The row every screen filters on: keyed by the LockerHub application id, marked removed.
    const ov = (await ctx.db.query(
      'SELECT removed_at, removed_reason FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1', [appId])).rows[0] as any;
    expect(ov?.removed_at).toBeTruthy();
    expect(ov.removed_reason).toBe('entered by mistake');

    const log = (await ctx.db.query(
      "SELECT after_data FROM audit_log WHERE action = 'locker.application.remove' AND entity_id = $1", [appId])).rows[0] as any;
    expect(log?.after_data?.reason).toBe('entered by mistake');
    expect(log?.after_data?.cancelled_on_lockerhub).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('a plain admin (not super) is refused', async () => {
    const r = await (await as('admin@demo.local')).post('/api/lockers/applications/APP-X/remove', { reason: 'nope' });
    expect(r.status).toBe(403);
  });

  it('a reason is required', async () => {
    const r = await (await superAdmin()).post('/api/lockers/applications/APP-Y/remove', { reason: 'no' });
    expect(r.status).toBe(400);
  });

  it('is not public', async () => {
    const r = await fetch(`${ctx.base}/api/lockers/applications/APP-Z/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'anon' }),
    });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.status).toBeLessThan(404);
  });
});
