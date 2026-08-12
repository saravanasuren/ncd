/**
 * Locker fee waivers — waiving RENT or DEPOSIT owed on an application (§A21).
 *
 * Not to be confused with `waivers.ts` (036), which records that an EXISTING
 * TENANCY holds a locker without NCD backing and settles nothing anywhere.
 * This one moves real money: approving it reduces or clears what the customer
 * has to pay before the locker can be allotted.
 *
 * ─── Why the checker matters more here than usual ────────────────────────────
 * LockerHub applies our §A21 call **approved-on-arrival** — they do not
 * second-guess it, and they attribute it to the approver we name. So OUR
 * checker is the only control standing between a maker and a written-off fee.
 * The call therefore fires on final approval and never on the request.
 *
 * ─── Approve first, apply second ─────────────────────────────────────────────
 * The approval is an internal decision and stands on its own; LockerHub being
 * unreachable must not undo it. So a refused apply leaves the waiver Approved
 * with the error recorded, visible as "approved, not yet in force", and
 * retryable — §A21 is idempotent.
 *
 * The apply runs inside the approval transaction, which is a deliberate
 * trade-off: it costs a row lock for up to the client's 12s timeout, but it
 * makes approval one click instead of two, and waivers are rare exceptions
 * rather than a hot path. The catch is what keeps a slow LockerHub from
 * rolling back a decision someone genuinely made.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import * as lh from '../../integrations/lockerhub/client.js';

export type WaiverLeg = 'rent' | 'deposit';

export interface CreateFeeWaiverInput {
  lockerhub_application_id: string;
  leg: WaiverLeg;
  waiver_pct?: number | null;
  waiver_amount?: number | null;
  reason: string;
  customer_id?: number | null;
  applicant_name?: string | null;
}

const shape = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  lockerhub_application_id: r.lockerhub_application_id,
  leg: r.leg,
  waiver_pct: r.waiver_pct == null ? null : Number(r.waiver_pct),
  waiver_amount: r.waiver_amount == null ? null : Number(r.waiver_amount),
  reason: r.reason,
  status: r.status,
  customer_id: r.customer_id == null ? null : Number(r.customer_id),
  applicant_name: r.applicant_name ?? null,
  /** Set once LockerHub has it. Approved + NULL = decided but not in force. */
  lockerhub_applied_at: r.lockerhub_applied_at ?? null,
  lockerhub_error: r.lockerhub_error ?? null,
  created_at: r.created_at ?? null,
});

/** Ask for a waiver. Nothing reaches LockerHub until a checker approves. */
export async function requestFeeWaiver(db: Db, actor: AuthUser, input: CreateFeeWaiverInput) {
  const appId = String(input.lockerhub_application_id ?? '').trim();
  if (!appId) throw errors.badRequest('lockerhub_application_id is required');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw errors.badRequest('A reason is required');

  const pct = input.waiver_pct == null ? null : Number(input.waiver_pct);
  const amt = input.waiver_amount == null ? null : Number(input.waiver_amount);
  // Exactly one — sending both would leave it to LockerHub to pick, and the two
  // can disagree.
  if ((pct == null) === (amt == null)) {
    throw errors.badRequest('Give either a percentage or an amount, not both.');
  }
  if (pct != null && !(pct > 0 && pct <= 100)) throw errors.badRequest('Percentage must be above 0 and at most 100.');
  if (amt != null && !(amt > 0)) throw errors.badRequest('Amount must be greater than zero.');

  return db.withTx(async (tx) => {
    const open = (await tx.query(
      `SELECT 1 FROM locker_fee_waivers
        WHERE lockerhub_application_id = $1 AND leg = $2 AND status IN ('PendingApproval','Approved')`,
      [appId, input.leg])).rowCount;
    if (open) throw errors.conflict(`A waiver is already open for the ${input.leg} leg of this application.`);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO locker_fee_waivers
         (lockerhub_application_id, leg, waiver_pct, waiver_amount, reason, customer_id, applicant_name, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [appId, input.leg, pct, amt, reason, input.customer_id ?? null, input.applicant_name?.trim() || null, actor.id]);
    const id = Number(rows[0]!.id);

    const req = await createApprovalRequest(tx, {
      type: 'locker_fee_waiver', entityType: 'locker_fee_waivers', entityId: id, makerUserId: actor.id,
      metadata: {
        waiver_id: id, lockerhub_application_id: appId, leg: input.leg,
        waiver_pct: pct, waiver_amount: amt, reason,
        applicant_name: input.applicant_name ?? null,
      },
    });
    await tx.query('UPDATE locker_fee_waivers SET approval_request_id = $1 WHERE id = $2', [req.id, id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.fee_waiver.request', entityType: 'locker_fee_waivers', entityId: id,
      after: { application: appId, leg: input.leg, waiver_pct: pct, waiver_amount: amt, reason },
    });
    return { id, request_id: req.id, request_no: req.request_no, status: 'PendingApproval' };
  });
}

/**
 * Send an approved waiver to LockerHub. Never throws for a their-side failure:
 * the approval already happened and reporting it as a failure would be wrong.
 */
async function applyToLockerHub(db: Db, approver: { id: number; fullName: string; email: string; role: string }, row: Record<string, unknown>) {
  const w = shape(row);
  const staff: lh.ActingStaff = { id: approver.id, name: approver.fullName, email: approver.email, staff_role: approver.role };
  try {
    await lh.applyWaiver(staff, String(w.lockerhub_application_id), {
      leg: w.leg as WaiverLeg,
      ...(w.waiver_pct != null ? { waiver_pct: w.waiver_pct } : { waiver_amount: w.waiver_amount! }),
      reason: String(w.reason),
      // Who authorised it, in their words — this is the whole basis on which
      // they accept it approved-on-arrival.
      approved_by: approver.fullName,
    });
    await db.query('UPDATE locker_fee_waivers SET lockerhub_applied_at = now(), lockerhub_error = NULL, updated_at = now() WHERE id = $1', [w.id]);
    return { applied: true as const };
  } catch (e) {
    const msg = (e as Error).message || 'LockerHub did not accept the waiver';
    await db.query('UPDATE locker_fee_waivers SET lockerhub_error = $1, updated_at = now() WHERE id = $2', [msg.slice(0, 500), w.id]);
    return { applied: false as const, error: msg };
  }
}

/**
 * NCD lockers are RENT-ONLY (owner 2026-08-12): no deposit is ever collected.
 * At enrolment we auto-apply a 100% deposit waiver so LockerHub allots on the
 * rent leg alone (Prem 2026-08-12: effectiveDeposit<=0 satisfies the leg — no
 * A20 override, nothing in the audit about outstanding money; and there IS a
 * deposit to waive because LockerHub still prices its per-size deposit, so A21
 * never 400s). This is POLICY, not a per-case decision, so it deliberately
 * SKIPS the maker-checker the discretionary waiver uses — the row is written
 * approved-on-creation and pushed straight to LockerHub.
 *
 * Must run AFTER A7 create and BEFORE A11 allocate / any deposit payment (A21's
 * ordering rule) — the create handler calls this immediately after create.
 * Failure-tolerant: a LockerHub reject is recorded on the row (retryable) and
 * never throws, so it can't break enrolment; the standard retry re-applies it.
 */
export async function autoWaiveDeposit(db: Db, actor: AuthUser, lockerhubApplicationId: string) {
  const appId = String(lockerhubApplicationId ?? '').trim();
  if (!appId) return null;
  const REASON = 'NCD locker — rent-only, no deposit collected (policy)';
  const row = await db.withTx(async (tx) => {
    const open = (await tx.query(
      `SELECT 1 FROM locker_fee_waivers
        WHERE lockerhub_application_id = $1 AND leg = 'deposit' AND status IN ('PendingApproval','Approved')`,
      [appId])).rowCount;
    if (open) return null; // already waived / in flight — don't duplicate
    const { rows } = await tx.query<Record<string, unknown>>(
      `INSERT INTO locker_fee_waivers
         (lockerhub_application_id, leg, waiver_pct, reason, created_by_user_id, status, approved_by_user_id)
       VALUES ($1,'deposit',100,$2,$3,'Approved',$3) RETURNING *`,
      [appId, REASON, actor.id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.fee_waiver.auto-deposit', entityType: 'locker_fee_waivers', entityId: Number(rows[0]!.id),
      after: { application: appId, leg: 'deposit', waiver_pct: 100, reason: REASON, policy: 'rent-only' },
    });
    return rows[0]!;
  });
  if (!row) return null;
  // Push to LockerHub outside the tx (network); a failure is recorded, not thrown.
  const r = await applyToLockerHub(db, { id: actor.id, fullName: actor.fullName, email: actor.email, role: actor.role }, row);
  return { id: Number(row.id), ...r };
}

registerOnFinalApprove('locker_fee_waiver', async (tx, req) => {
  const id = req.metadata.waiver_id ? Number(req.metadata.waiver_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  // ApprovalRow carries the maker, not the checker — the approver is in
  // approval_actions, written a few lines before this hook fires. Take the
  // LATEST approve, which on a single-level chain is the only one.
  const act = (await tx.query<{ approver_user_id: string }>(
    `SELECT approver_user_id FROM approval_actions
      WHERE approval_request_id = $1 AND action = 'approve'
      ORDER BY id DESC LIMIT 1`, [req.id])).rows[0];

  const row = (await tx.query<Record<string, unknown>>(
    "UPDATE locker_fee_waivers SET status = 'Approved', approved_by_user_id = $1, updated_at = now() WHERE id = $2 AND status = 'PendingApproval' RETURNING *",
    [act?.approver_user_id ?? null, id])).rows[0];
  if (!row) return;   // already approved / cancelled — nothing to send twice
  const u = (await tx.query<{ id: string; full_name: string; email: string; role: string }>(
    `SELECT u.id, u.full_name, u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [row.approved_by_user_id])).rows[0];
  await applyToLockerHub(tx, {
    id: Number(u?.id ?? 0), fullName: u?.full_name ?? 'NCD checker',
    email: u?.email ?? '', role: u?.role ?? 'admin',
  }, row);
});

registerOnReject('locker_fee_waiver', async (tx, req) => {
  const id = req.metadata.waiver_id ? Number(req.metadata.waiver_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query("UPDATE locker_fee_waivers SET status = 'Rejected', updated_at = now() WHERE id = $1 AND status = 'PendingApproval'", [id]);
});

/** Retry an approved waiver LockerHub refused. Idempotent on their side. */
export async function retryFeeWaiver(db: Db, actor: AuthUser, id: number) {
  const row = (await db.query<Record<string, unknown>>('SELECT * FROM locker_fee_waivers WHERE id = $1', [id])).rows[0];
  if (!row) throw errors.notFound('Waiver not found');
  if (row.status !== 'Approved') throw errors.conflict('Only an approved waiver can be applied.');
  if (row.lockerhub_applied_at) return { waiver: shape(row), applied: true };
  const r = await applyToLockerHub(db, { id: actor.id, fullName: actor.fullName, email: actor.email, role: actor.role }, row);
  const fresh = (await db.query<Record<string, unknown>>('SELECT * FROM locker_fee_waivers WHERE id = $1', [id])).rows[0]!;
  return { waiver: shape(fresh), ...r };
}

/** Waivers on one application — what the enrolment screen shows. */
export async function listFeeWaivers(db: Db, applicationId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM locker_fee_waivers
      WHERE lockerhub_application_id = $1 AND status IN ('PendingApproval','Approved')
      ORDER BY id DESC`, [applicationId]);
  return rows.map(shape);
}
