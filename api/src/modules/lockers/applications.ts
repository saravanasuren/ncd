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
import { errors } from '../../lib/errors.js';
import { lockerBranchScopeFor } from './branchScope.js';

export interface LockerApplicationRow {
  lockerhub_application_id: string;
  application_no: string | null;
  customer_id: number | null;
  customer_name: string | null;
  phone: string | null;
  branch_id: string | null;
  branch_name: string | null;
  locker_size: string | null;
  locker_number: string | null;
  operation_mandate: string | null;
  status: string | null;
  status_checked_at: string | null;
  created_at: string;
  created_by_name: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  /** TRUE cancelled upstream · FALSE LockerHub still holds it · null unknown. */
  lockerhub_cancelled: boolean | null;
  lockerhub_refusal: string | null;
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
  /** LockerHub's own "APP-2026-01261" — the reference a person recognises. */
  applicationNo?: string | null;
  customerId?: number | null;
  customerName?: string | null;
  phone?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  lockerSize?: string | null;
  lockerNumber?: string | null;
  /** Schedule §5 — who may operate the locker. */
  operationMandate?: string | null;
  status?: string | null;
  createdByUserId?: number | null;
}): Promise<void> {
  const id = String(input.applicationId ?? '').trim();
  if (!id) return;
  await db.query(
    `INSERT INTO locker_applications
       (lockerhub_application_id, application_no, customer_id, customer_name, phone, branch_id, branch_name,
        locker_size, locker_number, status, status_checked_at, created_by_user_id, operation_mandate)
     VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END, $10, $12)
     ON CONFLICT (lockerhub_application_id) DO UPDATE SET
       application_no = COALESCE(EXCLUDED.application_no, locker_applications.application_no),
       customer_id   = COALESCE(EXCLUDED.customer_id,   locker_applications.customer_id),
       customer_name = COALESCE(EXCLUDED.customer_name, locker_applications.customer_name),
       phone         = COALESCE(EXCLUDED.phone,         locker_applications.phone),
       branch_id     = COALESCE(EXCLUDED.branch_id,     locker_applications.branch_id),
       branch_name   = COALESCE(EXCLUDED.branch_name,   locker_applications.branch_name),
       locker_size   = COALESCE(EXCLUDED.locker_size,   locker_applications.locker_size),
       locker_number = COALESCE(EXCLUDED.locker_number, locker_applications.locker_number),
       status        = COALESCE(EXCLUDED.status,        locker_applications.status),
       operation_mandate = COALESCE(EXCLUDED.operation_mandate, locker_applications.operation_mandate),
       status_checked_at = COALESCE(EXCLUDED.status_checked_at, locker_applications.status_checked_at),
       updated_at    = now()`,
    [id, input.customerId ?? null, input.customerName ?? null, input.phone ?? null,
     input.branchId ?? null, input.branchName ?? null, input.lockerSize ?? null,
     input.lockerNumber ?? null, input.status ?? null, input.createdByUserId ?? null,
     input.applicationNo ?? null, input.operationMandate ?? null]);
}

/**
 * A7 does not always CREATE. When a customer still has an unfinished locker
 * application, `POST /locker-applications` answers with THAT one — same id,
 * same APP-number — instead of opening a second. Nothing in their response
 * says so; our own index is the only way to tell.
 *
 * Unchecked, the enrolment screen then dresses the earlier locker's
 * application up as the new one, carrying its rent state with it: its waiver,
 * its "★ Premium — rent free", its collected payment (owner 2026-09-10, on a
 * second locker for the same customer — "for each locker it has its own
 * payment collections"). Worse than a cosmetic tick: allot from there and TWO
 * lockers hang off ONE application, so one rent is collected for both, and
 * `locker_allotments` — keyed on the application — replaces the first locker
 * with the second. That is exactly what happened to APP-2026-01280, where
 * L10-1 became L10-10 with no trace but the audit log.
 *
 * A handed-back application is therefore let through only when NOTHING has
 * happened on it yet and it is for the same size — the shape of a retried or
 * double-clicked create, where carrying on is what the operator meant. The
 * automatic 100% deposit waiver every application is born with does not count
 * as something happening. Anything further along is refused, naming the
 * application so the operator can finish it or delete it and start again.
 */
export async function assertNotAReusedApplication(
  db: Db, applicationId: string, wantedSize?: string | null,
): Promise<{ reused: boolean }> {
  const id = String(applicationId ?? '').trim();
  if (!id) return { reused: false };

  // FAIL OPEN. By the time this runs LockerHub has already answered, and an
  // application we do not index is one nobody can reach again — they publish no
  // list endpoint. A bookkeeping query that cannot run must therefore not stop
  // the enrolment; the guard is a safety net, not something that outranks the
  // application itself.
  let prior: {
    application_no: string | null; locker_size: string | null; locker_number: string | null;
    status: string | null; removed_at: string | null;
  } | undefined;
  let busy: { allotted: string; rent_waiver: string; payment: string } | undefined;
  try {
    prior = (await db.query<NonNullable<typeof prior>>(
      `SELECT a.application_no, a.locker_size, a.locker_number, a.status, o.removed_at
         FROM locker_applications a
         LEFT JOIN locker_tenant_overrides o ON o.lockerhub_tenant_id = a.lockerhub_application_id
        WHERE a.lockerhub_application_id = $1`, [id])).rows[0];
    if (!prior) return { reused: false };   // genuinely a new application
    busy = (await db.query<NonNullable<typeof busy>>(
      `SELECT (SELECT count(*) FROM locker_allotments
                WHERE lockerhub_application_id = $1) AS allotted,
              (SELECT count(*) FROM locker_fee_waivers
                WHERE lockerhub_application_id = $1 AND leg = 'rent'
                  AND status IN ('PendingApproval','Approved')) AS rent_waiver,
              (SELECT count(*) FROM locker_offline_payments
                WHERE lockerhub_application_id = $1 AND status <> 'Rejected') AS payment`,
      [id])).rows[0]!;
  } catch (e) {
    console.warn('[locker] could not check for a reused application (allowing it through):', (e as Error).message);
    return { reused: false };
  }

  const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();
  const sameSize = !wantedSize || !prior.locker_size || norm(prior.locker_size) === norm(wantedSize);
  const untouched = !Number(busy.allotted) && !Number(busy.rent_waiver) && !Number(busy.payment)
    && !prior.removed_at;
  if (untouched && sameSize) return { reused: true };

  const ref = prior.application_no ?? id;
  const what = [
    Number(busy.allotted) ? `locker ${prior.locker_number ?? ''}`.trim() + ' is already allotted on it' : null,
    Number(busy.rent_waiver) ? 'its rent already carries a waiver' : null,
    Number(busy.payment) ? 'a rent payment is already recorded against it' : null,
    prior.removed_at ? 'it was removed from NCD but LockerHub still holds it' : null,
    !sameSize ? `it is a ${prior.locker_size} locker, not ${wantedSize}` : null,
  ].filter(Boolean).join(', ');
  throw errors.conflict(
    `LockerHub answered with ${ref}, the locker application this customer already has open — `
    + 'it will not open a second one while that is unfinished. '
    + `This enrolment cannot continue on it: ${what}. `
    + `Finish ${ref} or delete it, then start this locker again.`,
    {
      reused_application_id: id,
      application_no: prior.application_no,
      status: prior.status,
      locker_size: prior.locker_size,
      locker_number: prior.locker_number,
      allotted: !!Number(busy.allotted),
      rent_waiver: !!Number(busy.rent_waiver),
      rent_payment: !!Number(busy.payment),
      removed_from_ncd: !!prior.removed_at,
    });
}

const COLS = `
  a.lockerhub_application_id, a.application_no, a.customer_id, a.branch_id, a.branch_name,
  a.locker_size, a.locker_number, a.status, a.status_checked_at, a.created_at, a.operation_mandate,
  COALESCE(c.full_name, a.customer_name) AS customer_name,
  COALESCE(c.phone, a.phone)             AS phone,
  u.full_name                            AS created_by_name,
  o.removed_at, o.removed_reason, o.lockerhub_cancelled, o.lockerhub_refusal`;

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
             OR lower(COALESCE(a.application_no, ''))              LIKE ${p}
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
 * LockerHub's branch list, memoised. A refresh of 50 applications would
 * otherwise fetch the same handful of branches 50 times, and their GET on an
 * application returns `branch_id` but no branch NAME — which is the only part
 * of it a person can read.
 */
let branchCache: { at: number; byId: Map<string, string> } | null = null;
const BRANCH_TTL_MS = 5 * 60_000;
async function branchNameFor(branchId: string | null | undefined): Promise<string | null> {
  const id = String(branchId ?? '').trim();
  if (!id) return null;
  if (!branchCache || Date.now() - branchCache.at > BRANCH_TTL_MS) {
    try {
      const lh = await import('../../integrations/lockerhub/client.js');
      const r = await lh.branches();
      branchCache = { at: Date.now(), byId: new Map((r?.branches ?? []).map((b) => [String(b.id), String(b.name)])) };
    } catch {
      // A branch we cannot name is not a reason to lose the rest of the row.
      return null;
    }
  }
  return branchCache.byId.get(id) ?? null;
}

/**
 * Re-ask LockerHub about one application and update the cached row.
 *
 * The field names here are the ones they ACTUALLY send, confirmed against a
 * live response — not a guess. Their GET returns a flat object with `name`,
 * `phone`, `application_no`, `branch_id` and `locker_size` at the top level,
 * and the locker number nested under `allotment`. The first version of this
 * read `customer_name` / `customer.name` / `locker_no`, none of which exist,
 * so 42 of 50 rows refreshed to a blank Customer column.
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
    const allot = (a.allotment ?? {}) as Record<string, any>;
    const branchId = a.branch_id ?? null;
    await recordApplication(db, {
      applicationId: id,
      applicationNo: a.application_no ?? null,
      customerName: a.name ?? a.customer_name ?? a.customer?.name ?? null,
      phone: a.phone ?? a.customer?.phone ?? null,
      branchId,
      branchName: a.branch_name ?? a.branch ?? await branchNameFor(branchId),
      lockerSize: a.locker_size ?? allot.size ?? a.size ?? null,
      lockerNumber: allot.locker_number ?? a.locker_no ?? a.locker_number ?? null,
      status: String(a.status ?? '') || 'unknown',
    });
    return { ok: true, status: a.status ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message?.slice(0, 200) ?? 'LockerHub did not answer' };
  }
}
