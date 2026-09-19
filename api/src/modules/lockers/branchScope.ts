/**
 * Which LockerHub branches a user may view on the Locker Tenants page
 * (owner 2026-07-24): "only those staffs who are assigned to those specific
 * branch gets to look only that particular branch portfolio."
 *
 * branch_staff ONLY. branch_manager stays unrestricted — the owner explicitly
 * declined extending this to them, and every other role that can reach this
 * page (admin/super_admin/ncd_manager) already sees everything.
 *
 * NCD's own `branches` table and LockerHub's branch list are two separate
 * systems with no shared id, so the match is by NAME — live, RS Puram, Erode,
 * Hosur, Salem and Tiruppur all match exactly. Fails OPEN to full access
 * whenever the match can't be made: no branch assigned, a name with no
 * LockerHub counterpart (HO — head office — is the live case), or LockerHub
 * itself unreachable. This is a viewing-only page; locking someone out of it
 * entirely over a naming mismatch is worse than the over-permissive default.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import * as lh from '../../integrations/lockerhub/client.js';

export interface LockerBranchScope {
  restricted: boolean;
  /** LockerHub branch ids the caller may see. Empty/meaningless unless restricted. */
  branchIds: string[];
  /** The same branches, id+name, for the UI to render as the only choices. */
  branches: Array<{ id: string; name: string }>;
}

const UNRESTRICTED: LockerBranchScope = { restricted: false, branchIds: [], branches: [] };

/** Pure name-matching, standalone so it's unit-testable with no DB or network:
 *  case/whitespace-insensitive, and the caller decides what an empty result
 *  means (here, always "fail open"). */
export function matchBranchesByName(
  ncdNames: string[], lhBranches: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const norm = (s: string) => s.trim().toLowerCase();
  const ncdSet = new Set(ncdNames.map(norm));
  return lhBranches.filter((b) => ncdSet.has(norm(b.name)));
}

export async function lockerBranchScopeFor(db: Db, actor: AuthUser): Promise<LockerBranchScope> {
  if (actor.role !== 'branch_staff') return UNRESTRICTED;

  // Branch assignment lives in either users.branch_id (the common case today)
  // or user_branches (the multi-branch mechanism branch_manager uses) — a
  // staff member could in principle carry both, so union rather than pick one.
  const rows = (await db.query<{ branch_id: string }>(
    `SELECT branch_id FROM users WHERE id = $1 AND branch_id IS NOT NULL
     UNION SELECT branch_id FROM user_branches WHERE user_id = $1`, [actor.id])).rows;
  if (!rows.length) return UNRESTRICTED;

  const ncdNames = (await db.query<{ name: string }>(
    'SELECT name FROM branches WHERE id = ANY($1)', [rows.map((r) => Number(r.branch_id))])).rows.map((r) => r.name);
  if (!ncdNames.length) return UNRESTRICTED;

  let lhBranches: Array<{ id: string; name: string }>;
  try {
    lhBranches = (await lh.branches()).branches;
  } catch {
    return UNRESTRICTED; // LockerHub down — don't compound that by locking staff out too
  }

  const matched = matchBranchesByName(ncdNames, lhBranches);
  if (!matched.length) return UNRESTRICTED; // e.g. HO — not a physical locker branch

  return { restricted: true, branchIds: matched.map((b) => b.id), branches: matched };
}

/**
 * May this user open THIS locker's documents?
 *
 * The scope above governs the list pages. A single locker's signed agreement is
 * a different question and a stricter one: it carries the hirers' PAN, address,
 * phone and nominee, and it is a legally binding contract. Restricting the
 * roster while leaving the by-id document open meant a branch_staff user at one
 * branch could fetch another branch's agreement by id (LOCKER-AUDIT-2026-09 P1).
 *
 * Unrestricted roles pass, as everywhere else. For a restricted user the
 * locker's branch is read from OUR index first (no upstream call), and only from
 * LockerHub when the index has none. Unlike the list pages this FAILS CLOSED
 * when the branch cannot be determined: a missing tenants row is an
 * inconvenience, a contract handed to the wrong branch is not.
 */
export async function assertLockerApplicationVisible(db: Db, actor: AuthUser, applicationId: string): Promise<void> {
  const scope = await lockerBranchScopeFor(db, actor);
  if (!scope.restricted) return;

  let branchId: string | null = (await db.query<{ branch_id: string | null }>(
    'SELECT branch_id FROM locker_applications WHERE lockerhub_application_id = $1', [applicationId])).rows[0]?.branch_id ?? null;
  if (!branchId) {
    try {
      const a = await lh.getLockerApplication(applicationId) as Record<string, unknown>;
      branchId = a?.branch_id != null ? String(a.branch_id) : null;
    } catch { /* falls through to the refusal below */ }
  }
  if (!branchId) {
    throw errors.forbidden("Couldn't confirm which branch this locker belongs to, so its agreement can't be opened from your login.");
  }
  if (!scope.branchIds.includes(String(branchId))) {
    throw errors.forbidden("This locker belongs to another branch, so its agreement can't be opened from your login.");
  }
}
