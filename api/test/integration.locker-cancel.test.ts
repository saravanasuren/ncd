/**
 * Delete now actually deletes (owner 2026-08-22: "if i delete in here it should
 * get deleted so that while i make a new enrollement the old traces doesnt
 * affect in there").
 *
 * LockerHub shipped A23 at our request. The rule these tests protect is the
 * ORDER: their side is the source of truth, so the cancel goes there FIRST and
 * we only write our local hide if it succeeded. Writing the hide first — or
 * anyway — is what left the two systems disagreeing before, with NCD showing
 * the application gone while LockerHub still held it and its locker.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const superAdmin = async () => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
};
const hidden = async (id: string) => Number((await ctx.db.query(
  'SELECT count(*)::int AS n FROM locker_tenant_overrides WHERE lockerhub_tenant_id = $1 AND removed_at IS NOT NULL',
  [id])).rows[0]!.n);

describe('cancelling a locker application', () => {
  it('does NOT hide it here when LockerHub refuses — money already collected', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication').mockRejectedValue(new Error('409 payment_collected'));
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    await expect(removeLockerApplication(ctx.db, actor, 'lh-refuse-paid', 'test cancel'))
      .rejects.toThrow(/money already collected/i);
    // The whole point: nothing written locally, so the two cannot disagree.
    expect(await hidden('lh-refuse-paid')).toBe(0);
    spy.mockRestore();
  });

  it('says so plainly when it is already a live tenancy', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication').mockRejectedValue(new Error('409 live_tenancy'));
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    await expect(removeLockerApplication(ctx.db, actor, 'lh-refuse-live', 'test cancel'))
      .rejects.toThrow(/live tenancy/i);
    expect(await hidden('lh-refuse-live')).toBe(0);
    spy.mockRestore();
  });

  it('a Super Admin can force a NCD-view-only removal when LockerHub refuses a paid app', async () => {
    // Owner 2026-08-25: the money can be test data or settled with LockerHub
    // out-of-band, and it still has to leave NCD's screens. forceLocal writes the
    // local hide anyway — and reports honestly that LockerHub kept the record.
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication').mockRejectedValue(new Error('409 payment_collected'));
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    const r = await removeLockerApplication(ctx.db, actor, 'lh-force-local', 'test cancel', {}, { forceLocal: true });
    expect(r.cancelled).toBe(false);        // NOT cancelled on LockerHub
    expect(r.lockerhub_kept).toBe(true);    // said plainly
    expect(await hidden('lh-force-local')).toBe(1);   // but gone from NCD's view
    spy.mockRestore();
  });

  it('force local ONLY bypasses the paid / live-tenancy block, never a real upstream error', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication').mockRejectedValue(new Error('500 boom'));
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    await expect(removeLockerApplication(ctx.db, actor, 'lh-force-upstream', 'test', {}, { forceLocal: true }))
      .rejects.toThrow(/would not cancel/i);
    expect(await hidden('lh-force-upstream')).toBe(0);   // nothing hidden on a genuine error
    spy.mockRestore();
  });

  it('cancels on their side, reports the released locker, and hides it here', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication')
      .mockResolvedValue({ success: true, status: 'cancelled', locker_released: 'L6-16' });
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    const r = await removeLockerApplication(ctx.db, actor, 'lh-ok', 'entered by mistake');
    expect(r.cancelled).toBe(true);
    expect(r.locker_released).toBe('L6-16');
    expect(await hidden('lh-ok')).toBe(1);

    // The reason and the released locker are on the audit trail, not just the screen.
    const { rows } = await ctx.db.query(
      "SELECT after_data FROM audit_log WHERE action = 'locker.application.remove' AND entity_id = 'lh-ok'");
    expect((rows[0] as any).after_data.cancelled_on_lockerhub).toBe(true);
    expect((rows[0] as any).after_data.locker_released).toBe('L6-16');
    spy.mockRestore();
  });

  it('is still Super Admin only, and never calls LockerHub for anyone else', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication');
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 2, fullName: 'Staff', email: 's@x.com', role: 'branch_staff' } as never;

    await expect(removeLockerApplication(ctx.db, actor, 'lh-not-allowed', 'test'))
      .rejects.toThrow(/Super Admin/i);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still demands a reason before anything reaches LockerHub', async () => {
    const lh = await import('../src/integrations/lockerhub/client.js');
    const spy = vi.spyOn(lh, 'cancelLockerApplication');
    const { removeLockerApplication } = await import('../src/modules/lockers/tenantOverrides.js');
    const actor = { id: 1, fullName: 'Admin', email: 'admin@dhanam.finance', role: 'super_admin' } as never;

    await expect(removeLockerApplication(ctx.db, actor, 'lh-no-reason', '')).rejects.toThrow(/reason/i);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
