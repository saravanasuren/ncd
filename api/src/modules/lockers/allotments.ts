/**
 * When a locker was really allotted, and the notice that one was (owner
 * 2026-09-04).
 *
 * Two things, and the second is what makes this safe to add to a live flow:
 *
 * 1. THE DATE. LockerHub's A11 allocate takes no date — they stamp "now". A
 *    locker handed over on 1 June and entered in September reads as September on
 *    their side. Staff can now state the real date; we keep it, and keep theirs
 *    beside it so the disagreement is visible.
 *
 * 2. THE NOTICE. Copied from `app_investment`: the allotment has ALREADY
 *    happened and the customer has the locker. The approval is a notice on the
 *    Approvals page, NOT a gate — there is no registerOnFinalApprove handler,
 *    so approving clears the notice and does nothing else. Allocation never
 *    waits on it.
 *
 * Recording is best-effort by design. The locker is already allotted on
 * LockerHub by the time this runs, and a bookkeeping failure must not turn a
 * completed allotment into an error on the operator's screen.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export interface AllotmentRecordInput {
  lockerhub_application_id: string;
  /** The date staff state. Defaults to today when omitted. */
  allotted_on?: string | null;
  backdate_reason?: string | null;
  /** What LockerHub reported back, for comparison. */
  lockerhub_allotted_on?: string | null;
  locker_no?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  customer_id?: number | null;
}

const iso = (v: unknown): string => String(v ?? '').slice(0, 10);
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Validate a stated allotment date. Exported so the route can refuse a bad one
 * BEFORE calling LockerHub — a date typo should not cost a real allotment.
 */
export function checkAllottedOn(allottedOn?: string | null, reason?: string | null): {
  allotted_on: string; backdated: boolean; backdate_reason: string | null;
} {
  const d = iso(allottedOn) || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw errors.badRequest('Enter the allotment date as a real date.');
  if (d > today()) throw errors.badRequest('The allotment date cannot be in the future.');
  const backdated = d < today();
  const r = String(reason ?? '').trim();
  // A backdate is a statement about the past that nothing else can corroborate
  // — LockerHub's own record will say today. Requiring the why is the only
  // thing that makes it reviewable on the notice.
  if (backdated && r.length < 3) {
    throw errors.badRequest('Say why this allotment is being backdated — the notice has to show a reason.');
  }
  return { allotted_on: d, backdated, backdate_reason: backdated ? r : null };
}

/**
 * Record the allotment and raise the notice. Never throws: the locker is
 * already allotted by the time this runs.
 */
export async function recordAllotment(
  db: Db, actor: AuthUser, input: AllotmentRecordInput,
): Promise<void> {
  try {
    const { allotted_on, backdated, backdate_reason } = checkAllottedOn(input.allotted_on, input.backdate_reason);
    await db.withTx(async (tx) => {
      const { createApprovalRequest } = await import('../approvals/service.js');
      const req = await createApprovalRequest(tx, {
        type: 'locker_allotment',
        entityType: 'locker_allotments',
        // entityId is OMITTED, not null: the key here is LockerHub's string
        // application id, which does not belong in a numeric entity_id. The
        // card is driven from metadata instead.
        makerUserId: actor.id,
        metadata: {
          lockerhub_application_id: input.lockerhub_application_id,
          locker_no: input.locker_no ?? null,
          branch: input.branch_name ?? input.branch_id ?? null,
          allotted_on,
          lockerhub_allotted_on: iso(input.lockerhub_allotted_on) || null,
          backdated,
          backdate_reason,
        },
      });
      await tx.query(
        `INSERT INTO locker_allotments
           (lockerhub_application_id, customer_id, locker_no, branch_id, branch_name,
            allotted_on, lockerhub_allotted_on, backdated, backdate_reason,
            approval_request_id, allotted_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6::date,NULLIF($7,'')::date,$8,$9,$10,$11)
         ON CONFLICT (lockerhub_application_id) DO UPDATE
            SET allotted_on = EXCLUDED.allotted_on,
                lockerhub_allotted_on = COALESCE(EXCLUDED.lockerhub_allotted_on, locker_allotments.lockerhub_allotted_on),
                backdated = EXCLUDED.backdated,
                backdate_reason = EXCLUDED.backdate_reason,
                locker_no = COALESCE(EXCLUDED.locker_no, locker_allotments.locker_no),
                updated_at = now()`,
        [input.lockerhub_application_id, input.customer_id ?? null, input.locker_no ?? null,
         input.branch_id ?? null, input.branch_name ?? null, allotted_on,
         iso(input.lockerhub_allotted_on), backdated, backdate_reason, req.id, actor.id]);
      await writeAudit(tx, {
        actorId: actor.id, action: 'locker.allotment.recorded',
        entityType: 'locker_allotments', entityId: null,
        after: {
          application: input.lockerhub_application_id, locker_no: input.locker_no ?? null,
          allotted_on, backdated, lockerhub_allotted_on: iso(input.lockerhub_allotted_on) || null,
        },
      });
    });
  } catch (e) {
    console.warn('[locker] allotment record failed (non-fatal — the locker IS allotted):', (e as Error).message);
  }
}

export interface AllotmentView {
  allotted_on: string;
  lockerhub_allotted_on: string | null;
  backdated: boolean;
  backdate_reason: string | null;
  /** True when our date and LockerHub's disagree — what the renewals screen flags. */
  date_differs: boolean;
}

const shape = (r: Record<string, unknown>): AllotmentView => {
  const ours = iso(r.allotted_on);
  const theirs = r.lockerhub_allotted_on ? iso(r.lockerhub_allotted_on) : null;
  return {
    allotted_on: ours,
    lockerhub_allotted_on: theirs,
    backdated: !!r.backdated,
    backdate_reason: (r.backdate_reason as string) ?? null,
    date_differs: !!theirs && theirs !== ours,
  };
};

/** Our recorded allotment for one locker application, or null. */
export async function getAllotment(db: Db, applicationId: string): Promise<AllotmentView | null> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT allotted_on, lockerhub_allotted_on, backdated, backdate_reason
       FROM locker_allotments WHERE lockerhub_application_id = $1`, [applicationId])).rows[0];
  return r ? shape(r) : null;
};

/**
 * Backdated allotments, by LockerHub application id — for the renewals screen.
 *
 * Renewals compute rent-due from LockerHub's lease_expires_on, which is keyed to
 * the date THEY stamped. A backdated locker will therefore come up for renewal
 * late, by exactly the amount it was backdated. Until they accept our date, the
 * honest answer is to show which rows are affected rather than quietly let them
 * drift.
 */
export async function backdatedByApplication(db: Db): Promise<Map<string, AllotmentView>> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT lockerhub_application_id, allotted_on, lockerhub_allotted_on, backdated, backdate_reason
       FROM locker_allotments WHERE backdated`);
  return new Map(rows.map((r) => [String(r.lockerhub_application_id), shape(r)]));
}
