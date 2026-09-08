/**
 * NCD's index of the locker applications it created — the list that did not
 * exist (owner 2026-09-08: "im not able to delete a locker application created
 * in ncd... i want the lockers to work just like how ncd is working").
 *
 * The delete had worked for weeks; what was missing was any way to REACH an
 * application again. `GET /applications/:id` needed an id like
 * `mts88mk6d0a6l7h`, LockerHub publishes no list endpoint, and NCD kept no
 * index — so 45 live applications were unreachable. This module is the index,
 * and the list page is what makes create/open/delete work the way the NCD
 * Applications screen does.
 *
 * `status` is a CACHE of LockerHub's answer, never authority. They own the
 * application; we record what they last said and when. `refreshOne` re-asks.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { lockerBranchScopeFor } from './branchScope.js';

export interface LockerApplicationRow {
  lockerhub_application_id: string;
  customer_id: number | null;
  customer_name: string | null;
  phone: string | null;
  branch_id: string | null;
  branch_name: string | null;
  locker_size: string | null;
  locker_number: string | null;
  status: string | null;
  status_checked_at: string | null;
  created_at: string;
  created_by_name: string | null;
  removed_at: string | null;
  removed_reason: string | null;
}

/**
 * Record an application NCD just created. Upsert, because re-creating for the
 * same customer can legitimately return an id we already hold, and because the
 * create handler calls this beside locker_intended_locker where a resume
 * re-runs the same path.
 *
 * COALESCE on update, never blind overwrite: the enrolment learns things in
 * stages (the locker number is chosen at step 1, the customer may resolve
 * later), so a later call carrying less must not erase what an earlier one knew.
 */
export async function recordApplication(db: Db, input: {
  applicationId: string;
  customerId?: number | null;
  customerName?: string | null;
  phone?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  lockerSize?: string | null;
  lockerNumber?: string | null;
  status?: string | null;
  createdByUserId?: number | null;
}): Promise<void> {
  const id = String(input.applicationId ?? '').trim();
  if (!id) return;
  await db.query(
    `INSERT INTO locker_applications
       (lockerhub_application_id, customer_id, customer_name, phone, branch_id, branch_name,
        locker_size, locker_number, status, status_checked_at, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END, $10)
     ON CONFLICT (lockerhub_application_id) DO UPDATE SET
       customer_id   = COALESCE(EXCLUDED.customer_id,   locker_applications.customer_id),
       customer_name = COALESCE(EXCLUDED.customer_name, locker_applications.customer_name),
       phone         = COALESCE(EXCLUDED.phone,         locker_applications.phone),
       branch_id     = COALESCE(EXCLUDED.branch_id,     locker_applications.branch_id),
       branch_name   = COALESCE(EXCLUDED.branch_name,   locker_applications.branch_name),
       locker_size   = COALESCE(EXCLUDED.locker_size,   locker_applications.locker_size),
       locker_number = COALESCE(EXCLUDED.locker_number, locker_applications.locker_number),
       status        = COALESCE(EXCLUDED.status,        locker_applications.status),
       status_checked_at = COALESCE(EXCLUDED.status_checked_at, locker_applications.status_checked_at),
       updated_at    = now()`,
    [id, input.customerId ?? null, input.customerName ?? null, input.phone ?? null,
     input.branchId ?? null, input.branchName ?? null, input.lockerSize ?? null,
     input.lockerNumber ?? null, input.status ?? null, input.createdByUserId ?? null]);
}

const COLS = `
  a.lockerhub_application_id, a.customer_id, a.branch_id, a.branch_name,
  a.locker_size, a.locker_number, a.status, a.status_checked_at, a.created_at,
  COALESCE(c.full_name, a.customer_name) AS customer_name,
  COALESCE(c.phone, a.phone)             AS phone,
  u.full_name                            AS created_by_name,
  o.removed_at, o.removed_reason`;

const FROM = `
  FROM locker_applications a
  LEFT JOIN customers c ON c.id = a.customer_id
  LEFT JOIN users u     ON u.id = a.created_by_user_id
  -- Removal lives in locker_tenant_overrides, keyed on the same id (085).
  LEFT JOIN locker_tenant_overrides o ON o.lockerhub_tenant_id = a.lockerhub_application_id`;

export interface ListFilters {
  q?: string;
  branchId?: string;
  /** 'live' (default) hides removed rows; 'removed' shows only those; 'all' both. */
  show?: 'live' | 'removed' | 'all';
  limit?: number;
}

/**
 * The list. Branch-scoped for branch_staff exactly as the Tenants page is —
 * same helper, same fail-open behaviour when a branch name has no LockerHub
 * counterpart, so the two pages can never disagree about who sees what.
 *
 * A row whose branch we have never learned (never opened, never allotted) is
 * NOT hidden from a restricted user: it would vanish with no way to ever find
 * it again, which is the exact problem this list exists to end. It is shown,
 * and refreshing it fills the branch in.
 */
export async function listApplications(
  db: Db, actor: AuthUser, f: ListFilters = {},
): Promise<{ rows: LockerApplicationRow[]; scope: { restricted: boolean; branches: Array<{ id: string; name: string }> } }> {
  const scope = await lockerBranchScopeFor(db, actor);
  const where: string[] = [];
  const vals: unknown[] = [];

  const show = f.show ?? 'live';
  if (show === 'live') where.push('o.removed_at IS NULL');
  else if (show === 'removed') where.push('o.removed_at IS NOT NULL');

  if (scope.restricted) {
    vals.push(scope.branchIds);
    where.push(`(a.branch_id IS NULL OR a.branch_id = ANY($${vals.length}::text[]))`);
  }
  if (f.branchId) {
    vals.push(f.branchId);
    where.push(`a.branch_id = $${vals.length}`);
  }
  if (f.q?.trim()) {
    vals.push(`%${f.q.trim().toLowerCase()}%`);
    const p = `$${vals.length}`;
    where.push(`(lower(COALESCE(c.full_name, a.customer_name, '')) LIKE ${p}
             OR lower(COALESCE(c.phone, a.phone, ''))              LIKE ${p}
             OR lower(COALESCE(a.locker_number, ''))               LIKE ${p}
             OR lower(a.lockerhub_application_id)                  LIKE ${p})`);
  }
  vals.push(Math.min(Math.max(Number(f.limit ?? 200), 1), 500));

  const { rows } = await db.query<LockerApplicationRow>(
    `SELECT ${COLS} ${FROM}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT $${vals.length}`, vals);
  return { rows, scope: { restricted: scope.restricted, branches: scope.branches } };
}

/**
 * Re-ask LockerHub about one application and update the cached row.
 *
 * Deliberately tolerant: an application LockerHub no longer recognises (404 on
 * a cancelled one) must not throw, or the list page would break on exactly the
 * rows the user is trying to tidy up. The error is returned for display.
 */
export async function refreshOne(db: Db, applicationId: string): Promise<{ ok: boolean; status?: string | null; error?: string }> {
  const id = String(applicationId ?? '').trim();
  if (!id) return { ok: false, error: 'application id required' };
  const lh = await import('../../integrations/lockerhub/client.js');
  try {
    const d = await lh.getLockerApplication(id) as Record<string, any>;
    const a = (d?.application ?? d ?? {}) as Record<string, any>;
    await recordApplication(db, {
      applicationId: id,
      customerName: a.customer_name ?? a.customer?.name ?? null,
      phone: a.phone ?? a.customer?.phone ?? null,
      branchId: a.branch_id ?? null,
      branchName: a.branch_name ?? a.branch ?? null,
      lockerSize: a.locker_size ?? a.size ?? null,
      lockerNumber: a.locker_no ?? a.locker_number ?? null,
      status: String(a.status ?? '') || 'unknown',
    });
    return { ok: true, status: a.status ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message?.slice(0, 200) ?? 'LockerHub did not answer' };
  }
}
