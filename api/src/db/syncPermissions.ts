/**
 * Grant newly-added permissions to their default roles, at every boot.
 *
 * WHY THIS EXISTS — a feature shipped invisible for a week.
 *
 * `role_permissions` is a DB table, seeded from DEFAULT_ROLE_PERMISSIONS. But
 * production never runs the seed: ops/deploy.sh runs `migrate` only (correctly
 * — the seed also writes users and settings). So a PR that added a permission
 * shipped its UI, its routes and its nav entry, while the permission itself
 * never reached the live table. requirePermission() and the nav both read the
 * DB, so the feature was hidden from EVERYONE, super_admin included.
 *
 * That is a bad failure mode because it is silent and it looks like something
 * else: the page is simply absent, so it reads as "not built yet" rather than
 * "built, deployed, and unreachable". Escrow (#151, 25 Jul) and the locker
 * allot-override (#217) both sat invisible this way — escrow for a week.
 *
 * ADDITIVE ONLY. It grants what is missing and never revokes. The seed's
 * DELETE-then-reinsert is right for a fresh database and wrong for a live one:
 * it would silently undo any hand-granted permission. If a permission should be
 * taken AWAY from a role, that is a deliberate act and belongs in a migration
 * where it can be reviewed, not a side effect of a restart.
 */
import type { Db } from './types.js';
import { ROLES, DEFAULT_ROLE_PERMISSIONS } from '@new-wealth/shared';

export async function syncRolePermissions(db: Db): Promise<string[]> {
  const granted: string[] = [];
  for (const role of ROLES) {
    const wanted = DEFAULT_ROLE_PERMISSIONS[role];
    if (!wanted?.length) continue;
    // One statement per role: INSERT ... SELECT against the role's own row, so
    // an unknown/renamed role simply matches nothing rather than throwing and
    // taking the boot down with it.
    const { rows } = await db.query<{ permission: string }>(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT r.id, p.perm
         FROM roles r
         CROSS JOIN unnest($2::text[]) AS p(perm)
        WHERE r.name = $1
       ON CONFLICT DO NOTHING
       RETURNING permission`,
      [role, wanted]
    );
    for (const r of rows) granted.push(`${role}:${r.permission}`);
  }
  return granted;
}
