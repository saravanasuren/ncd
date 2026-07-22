/**
 * Locker deposit links (owner spec 2026-07-22).
 *
 * A locker customer is enrolled as an NCD customer, the deposit is booked as an
 * NCD investment, the tenant is created in LockerHub, and then the investment is
 * LINKED to the locker's deposit — which settles that deposit leg in LockerHub.
 *
 * The investment is never split. A ₹25L NCD backing a ₹3L XL locker stays ONE
 * ₹25L investment carrying a ₹3L claim:
 *   linked   = SUM(active links)        → what the locker agreement shows (₹3L)
 *   free     = outstanding − linked     → plain NCD (₹22L)
 *   redeemable = free                   → the locker's security can't be redeemed
 *                                          until the link is released.
 * One investment may back several lockers; the sum of active links can never
 * exceed the investment's outstanding.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import * as lh from '../../integrations/lockerhub/client.js';

export interface LockerLink {
  id: number;
  lockerhub_application_id: string;
  locker_no: string | null;
  locker_size: string | null;
  linked_amount: number;
  status: string;
  linked_at: string;
}

/** Live outstanding of an investment (partial withdrawals reduce it). */
async function outstandingOf(db: Db, applicationId: number): Promise<number> {
  const r = (await db.query<{ v: string }>(
    `SELECT COALESCE(
       (SELECT sum(outstanding_amount) FROM application_lines WHERE application_id = $1 AND status = 'Active'),
       (SELECT total_amount FROM applications WHERE id = $1), 0) AS v`, [applicationId])).rows[0];
  return Number(r?.v ?? 0);
}

/** Total currently claimed by live locker links. */
export async function linkedAmount(db: Db, applicationId: number): Promise<number> {
  const r = (await db.query<{ v: string }>(
    "SELECT COALESCE(sum(linked_amount),0) AS v FROM locker_deposit_links WHERE application_id = $1 AND status = 'active'",
    [applicationId])).rows[0];
  return Number(r?.v ?? 0);
}

/** The three numbers the investment page shows. */
export async function depositSummary(db: Db, applicationId: number) {
  const [outstanding, linked] = await Promise.all([
    outstandingOf(db, applicationId),
    linkedAmount(db, applicationId),
  ]);
  const { rows } = await db.query<LockerLink>(
    `SELECT id, lockerhub_application_id, locker_no, locker_size, linked_amount, status, linked_at
       FROM locker_deposit_links WHERE application_id = $1 ORDER BY status, id`, [applicationId]);
  return {
    outstanding,
    linked_to_lockers: linked,
    free_ncd: Math.max(0, Number((outstanding - linked).toFixed(2))),
    redeemable: Math.max(0, Number((outstanding - linked).toFixed(2))),
    links: rows.map((r) => ({ ...r, linked_amount: Number(r.linked_amount) })),
  };
}

/**
 * Link an investment to a locker's deposit and settle that leg in LockerHub.
 * The amount is LockerHub's own deposit figure for that locker — never typed by
 * staff — so it can never disagree with the locker agreement.
 */
export async function linkDeposit(
  db: Db, actor: AuthUser, input: { applicationId: number; lockerApplicationId: string }
) {
  const app = (await db.query<{ id: string; application_no: string; status: string }>(
    'SELECT id, application_no, status FROM applications WHERE id = $1', [input.applicationId])).rows[0];
  if (!app) throw errors.notFound('Investment not found');
  if (['Rejected', 'Cancelled'].includes(app.status)) throw errors.unprocessable('This investment is not live');

  // LockerHub is the source of truth for the deposit amount + locker identity.
  const locker = await lh.getLockerApplication(input.lockerApplicationId) as Record<string, any>;
  const depositLeg = locker?.legs?.deposit;
  const depositAmount = Number(depositLeg?.amount ?? 0);
  if (!(depositAmount > 0)) throw errors.unprocessable('LockerHub reports no deposit amount for that locker application');

  const [outstanding, alreadyLinked] = await Promise.all([
    outstandingOf(db, input.applicationId),
    linkedAmount(db, input.applicationId),
  ]);
  const free = outstanding - alreadyLinked;
  if (depositAmount > free) {
    throw errors.unprocessable(
      `This investment has only ₹${free.toLocaleString('en-IN')} free to pledge (₹${outstanding.toLocaleString('en-IN')} outstanding, ₹${alreadyLinked.toLocaleString('en-IN')} already linked) — the locker deposit is ₹${depositAmount.toLocaleString('en-IN')}.`
    );
  }

  const link = await db.withTx(async (tx) => {
    const dup = (await tx.query(
      "SELECT 1 FROM locker_deposit_links WHERE lockerhub_application_id = $1 AND status = 'active'",
      [input.lockerApplicationId])).rowCount;
    if (dup) throw errors.conflict('That locker is already backed by an investment');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO locker_deposit_links
         (application_id, lockerhub_application_id, locker_no, locker_size, linked_amount, linked_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.applicationId, input.lockerApplicationId,
       locker?.allotment?.locker_number ?? null, locker?.locker_size ?? null, depositAmount, actor.id]);
    // NB: we deliberately do NOT touch applications.is_locker_deposit here.
    // LockerHub's queue is the single writer of that flag — it calls our
    // inbound B19a /ncd/:id/link-locker after allocation (Prem, 2026-07-22).
    // Two writers would race, and their call is the one carrying the
    // deposit_reference. Live pledges are counted from locker_deposit_links.
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.deposit.link', entityType: 'applications', entityId: input.applicationId,
      after: { lockerhub_application_id: input.lockerApplicationId, linked_amount: depositAmount, application_no: app.application_no },
    });
    return { id: Number(rows[0]!.id) };
  });

  // Settle the deposit leg in LockerHub as NCD-BACKED (A12 link-ncd — never a
  // payment row). Done AFTER the commit (network I/O outside the transaction).
  // If it fails the link still stands — staff can retry; A12 is idempotent.
  let settled = false; let settleError: string | null = null; let lockerStatus: string | null = null;
  try {
    const r = await lh.linkNcd(
      { id: actor.id, name: actor.fullName, email: actor.email },
      input.lockerApplicationId,
      { ncd_id: app.application_no }
    );
    settled = true;
    lockerStatus = (r?.application_status ?? r?.status ?? null) as string | null;
  } catch (e) {
    settleError = (e as Error).message;
    console.warn(`[locker] deposit leg link-ncd failed for locker ${input.lockerApplicationId}: ${settleError}`);
  }

  return { ok: true, link_id: link.id, linked_amount: depositAmount, lockerhub_settled: settled, settle_error: settleError, locker_status: lockerStatus };
}

/** Release a link (locker closed) so the pledged amount becomes redeemable. */
export async function releaseLink(db: Db, actor: AuthUser, linkId: number, reason: string) {
  return db.withTx(async (tx) => {
    const l = (await tx.query<{ id: string; application_id: string; status: string; linked_amount: string }>(
      'SELECT id, application_id, status, linked_amount FROM locker_deposit_links WHERE id = $1', [linkId])).rows[0];
    if (!l) throw errors.notFound('Link not found');
    if (l.status !== 'active') throw errors.unprocessable('That link is already released');
    await tx.query(
      "UPDATE locker_deposit_links SET status='released', released_by_user_id=$2, released_at=now(), released_reason=$3 WHERE id=$1",
      [linkId, actor.id, reason]);
    // As on the link side, is_locker_deposit is LockerHub's to write — their
    // A12 /ncd/:id/release-locker call clears it when the deposit refund
    // actually settles. Releasing the link row here is what frees the pledged
    // money for redemption; the flag follows from their side.
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.deposit.release', entityType: 'applications', entityId: Number(l.application_id),
      after: { link_id: linkId, released_amount: Number(l.linked_amount), reason },
    });
    return { ok: true };
  });
}
