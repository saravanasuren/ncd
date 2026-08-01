/**
 * Role-permission sync. Production never runs the seed — deploy.sh migrates
 * only — so without this a PR that adds a permission ships a feature that
 * NOBODY can reach, super_admin included. Escrow shipped invisible for a week
 * exactly this way (#151 → 2026-08-01).
 *
 * The two properties that matter, and the reason each is here:
 *   · it GRANTS what a role should have but doesn't → the feature appears;
 *   · it NEVER REVOKES → a live database is not a fresh one, and quietly
 *     undoing a hand-granted permission is its own outage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { syncRolePermissions } from '../src/db/syncPermissions.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const has = async (role: string, perm: string): Promise<boolean> => {
  const { rows } = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.name = $1 AND rp.permission = $2`, [role, perm]);
  return Number(rows[0]!.n) > 0;
};

describe('role-permission sync', () => {
  it('re-grants a permission that went missing from the live table', async () => {
    // Exactly what production looked like: the code knows about
    // escrow:reconcile, the DB does not, so the Escrow page is invisible.
    await ctx.db.query(
      `DELETE FROM role_permissions WHERE permission = 'escrow:reconcile'
         AND role_id IN (SELECT id FROM roles WHERE name = 'ncd_manager')`);
    expect(await has('ncd_manager', 'escrow:reconcile')).toBe(false);

    const granted = await syncRolePermissions(ctx.db);

    expect(await has('ncd_manager', 'escrow:reconcile')).toBe(true);
    expect(granted).toContain('ncd_manager:escrow:reconcile');
  });

  it('is idempotent — a second run grants nothing and changes nothing', async () => {
    const before = Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM role_permissions')).rows[0]!.n);
    const granted = await syncRolePermissions(ctx.db);
    const after = Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM role_permissions')).rows[0]!.n);
    expect(granted).toEqual([]);
    expect(after).toBe(before);
  });

  it('NEVER revokes — a hand-granted extra permission survives', async () => {
    // The seed's DELETE-then-reinsert would wipe this. A live database may
    // legitimately carry a permission granted by hand to unblock someone; a
    // restart silently taking it back would be an outage of its own making.
    await ctx.db.query(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT id, 'payouts:generate' FROM roles WHERE name = 'branch_staff'
       ON CONFLICT DO NOTHING`);
    expect(await has('branch_staff', 'payouts:generate')).toBe(true);

    await syncRolePermissions(ctx.db);

    expect(await has('branch_staff', 'payouts:generate')).toBe(true);
  });

  it('leaves every role holding at least its catalogue permissions', async () => {
    const { DEFAULT_ROLE_PERMISSIONS, ROLES } = await import('@new-wealth/shared');
    await syncRolePermissions(ctx.db);
    for (const role of ROLES) {
      for (const perm of DEFAULT_ROLE_PERMISSIONS[role] ?? []) {
        expect({ role, perm, held: await has(role, perm) }).toEqual({ role, perm, held: true });
      }
    }
  });
});
