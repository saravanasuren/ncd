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
import { toISODate } from '../../lib/dates.js';
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


/** Total already pledged to one locker, across every NCD backing it. */
export async function pledgedToLocker(db: Db, lockerApplicationId: string): Promise<{ total: number; count: number }> {
  const r = (await db.query<{ v: string; n: string }>(
    "SELECT COALESCE(sum(linked_amount),0) AS v, count(*)::int AS n FROM locker_deposit_links WHERE lockerhub_application_id = $1 AND status = 'active'",
    [lockerApplicationId])).rows[0]!;
  return { total: Number(r.v), count: Number(r.n) };
}

/** Configurable cap — how many NCDs may jointly back one deposit (Settings). */
export async function maxNcdsPerDeposit(db: Db): Promise<number> {
  const { getSettingsMap } = await import('../settings/service.js');
  const raw = (await getSettingsMap(db))['lockers.max_ncds_per_deposit'];
  const n = Number(raw ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
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

  // Our OWN guards first — they're local and cheap, and a caller shouldn't get a
  // LockerHub connectivity error when the real problem is on our side (this
  // investment is fully pledged, or the locker already has its maximum NCDs).
  const [outstanding, alreadyLinked, onLocker, maxNcds] = await Promise.all([
    outstandingOf(db, input.applicationId),
    linkedAmount(db, input.applicationId),
    pledgedToLocker(db, input.lockerApplicationId),
    maxNcdsPerDeposit(db),
  ]);
  const dupNow = (await db.query(
    "SELECT 1 FROM locker_deposit_links WHERE lockerhub_application_id = $1 AND application_id = $2 AND status = 'active'",
    [input.lockerApplicationId, input.applicationId])).rowCount;
  if (dupNow) throw errors.conflict('That investment is already backing this locker deposit');
  if (onLocker.count >= maxNcds) {
    throw errors.unprocessable(
      `This locker deposit is already backed by ${onLocker.count} investment(s) — the limit is ${maxNcds}. Raise it in Settings → Lockers, or release a link first.`
    );
  }
  const free = outstanding - alreadyLinked;
  if (free <= 0) {
    throw errors.unprocessable(
      `${app.application_no} has nothing free to pledge (₹${outstanding.toLocaleString('en-IN')} outstanding, all of it already linked).`
    );
  }

  // LockerHub is the source of truth for the deposit amount + locker identity.
  const locker = await lh.getLockerApplication(input.lockerApplicationId) as Record<string, any>;
  const depositLeg = locker?.legs?.deposit;
  const depositAmount = Number(depositLeg?.amount ?? 0);
  if (!(depositAmount > 0)) throw errors.unprocessable('LockerHub reports no deposit amount for that locker application');

  // More than one NCD may jointly back a deposit (cap is configurable), so we
  // pledge what THIS investment can cover toward the shortfall rather than
  // demanding one NCD cover the whole thing.
  const shortfall = Number((depositAmount - onLocker.total).toFixed(2));
  if (shortfall <= 0) throw errors.conflict('That locker deposit is already fully backed by NCD investments');
  // Pledge the smaller of what's free here and what's still owed.
  const pledgeAmount = Math.min(free, shortfall);
  const remainingAfter = Number((shortfall - pledgeAmount).toFixed(2));
  // If this NCD can't finish it, the remainder must still fit within the cap.
  if (remainingAfter > 0 && onLocker.count + 1 >= maxNcds) {
    throw errors.unprocessable(
      `${app.application_no} covers ₹${pledgeAmount.toLocaleString('en-IN')} of the ₹${shortfall.toLocaleString('en-IN')} still needed, but the ${maxNcds}-investment limit would be reached with ₹${remainingAfter.toLocaleString('en-IN')} unbacked. Use a larger investment, or raise the limit in Settings → Lockers.`
    );
  }

  const link = await db.withTx(async (tx) => {
    // Additional NCDs are allowed (up to the cap); the SAME investment twice is not.
    const dup = (await tx.query(
      "SELECT 1 FROM locker_deposit_links WHERE lockerhub_application_id = $1 AND application_id = $2 AND status = 'active'",
      [input.lockerApplicationId, input.applicationId])).rowCount;
    if (dup) throw errors.conflict('That investment is already backing this locker deposit');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO locker_deposit_links
         (application_id, lockerhub_application_id, locker_no, locker_size, linked_amount, linked_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.applicationId, input.lockerApplicationId,
       locker?.allotment?.locker_number ?? null, locker?.locker_size ?? null, pledgeAmount, actor.id]);
    // NB: we deliberately do NOT touch applications.is_locker_deposit here.
    // LockerHub's queue is the single writer of that flag — it calls our
    // inbound B19a /ncd/:id/link-locker after allocation (Prem, 2026-07-22).
    // Two writers would race, and their call is the one carrying the
    // deposit_reference. Live pledges are counted from locker_deposit_links.
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.deposit.link', entityType: 'applications', entityId: input.applicationId,
      after: { lockerhub_application_id: input.lockerApplicationId, linked_amount: pledgeAmount, application_no: app.application_no, deposit_amount: depositAmount, pledged_total: onLocker.total + pledgeAmount },
    });
    return { id: Number(rows[0]!.id) };
  });

  // Settle the deposit leg in LockerHub as NCD-BACKED (A12 link-ncd — never a
  // payment row). Done AFTER the commit (network I/O outside the transaction).
  // If it fails the link still stands — staff can retry; A12 is idempotent.
  //
  // A12 settles the WHOLE leg and takes a single ncd_id, so we only call it once
  // the pledged total actually covers the deposit. Calling it on a partial
  // pledge would tell LockerHub the deposit is secured when it isn't — and
  // could trip auto-allotment for an under-secured locker.
  const pledgedTotal = Number((onLocker.total + pledgeAmount).toFixed(2));
  const fullyBacked = pledgedTotal >= depositAmount;
  let settled = false; let settleError: string | null = null; let lockerStatus: string | null = null;
  if (fullyBacked) {
    try {
      const r = await lh.linkNcd(
        { id: actor.id, name: actor.fullName, email: actor.email },
        input.lockerApplicationId,
        // The NCD that completes the deposit is the one we name to LockerHub;
        // NCD holds the full multi-investment breakdown in locker_deposit_links.
        { ncd_id: app.application_no }
      );
      settled = true;
      lockerStatus = (r?.application_status ?? r?.status ?? null) as string | null;
    } catch (e) {
      settleError = (e as Error).message;
      console.warn(`[locker] deposit leg link-ncd failed for locker ${input.lockerApplicationId}: ${settleError}`);
    }
  }

  return {
    ok: true,
    link_id: link.id,
    linked_amount: pledgeAmount,
    deposit_amount: depositAmount,
    pledged_total: pledgedTotal,
    shortfall_remaining: Math.max(0, Number((depositAmount - pledgedTotal).toFixed(2))),
    ncds_linked: onLocker.count + 1,
    max_ncds: maxNcds,
    fully_backed: fullyBacked,
    lockerhub_settled: settled,
    settle_error: settleError,
    locker_status: lockerStatus,
  };
}

/** Release a link (locker closed) so the pledged amount becomes redeemable. */
export async function releaseLink(db: Db, actor: AuthUser, linkId: number, reason: string) {
  return db.withTx(async (tx) => {
    const l = (await tx.query<{ id: string; application_id: string; status: string; linked_amount: string; lockerhub_application_id: string }>(
      'SELECT id, application_id, status, linked_amount, lockerhub_application_id FROM locker_deposit_links WHERE id = $1', [linkId])).rows[0];
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
    // A deposit can be backed by several NCDs, so releasing ONE may leave the
    // locker partly secured. Report what's still pledged rather than returning a
    // bare ok — staff (and the UI) need to see that a shortfall has opened up.
    const remaining = (await tx.query<{ v: string; n: string }>(
      "SELECT COALESCE(sum(linked_amount),0) AS v, count(*)::int AS n FROM locker_deposit_links WHERE lockerhub_application_id = $1 AND status = 'active'",
      [l.lockerhub_application_id])).rows[0]!;
    return {
      ok: true,
      released_amount: Number(l.linked_amount),
      locker_still_pledged: Number(remaining.v),
      locker_ncds_remaining: Number(remaining.n),
      locker_now_unbacked: Number(remaining.n) === 0,
    };
  });
}

/**
 * The customer's investments that could back a locker deposit, with how much of
 * each is still free to pledge. Powers the picker on locker enrolment — without
 * it staff had no way to reach linkDeposit from the app.
 */
export async function linkCandidates(db: Db, customerId: number) {
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.status, s.code AS series_code,
            COALESCE((SELECT sum(al.outstanding_amount) FROM application_lines al
                       WHERE al.application_id = a.id AND al.status = 'Active'), a.total_amount) AS outstanding,
            COALESCE((SELECT sum(l.linked_amount) FROM locker_deposit_links l
                       WHERE l.application_id = a.id AND l.status = 'active'), 0) AS linked
       FROM applications a JOIN series s ON s.id = a.series_id
      WHERE a.customer_id = $1 AND a.archived_at IS NULL AND a.status = 'Active'
      ORDER BY a.id DESC`, [customerId])).rows;
  return rows.map((r) => {
    const outstanding = Number(r.outstanding), linked = Number(r.linked);
    return {
      id: Number(r.id), application_no: r.application_no, series_code: r.series_code, status: r.status,
      outstanding, linked, free: Math.max(0, Number((outstanding - linked).toFixed(2))),
    };
  });
}

/**
 * Everything NCD knows about one customer's lockers, for the customer 360:
 * LockerHub's own record (best-effort — a hiccup there must not blank the page)
 * plus OUR pledges and cheques, which are ours alone and always shown.
 */
export async function customerLockers(db: Db, customerId: number) {
  const c = (await db.query<{ phone: string | null }>(
    'SELECT phone FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!c) throw errors.notFound('Customer not found');

  const pledges = (await db.query<Record<string, unknown>>(
    `SELECT l.id, l.lockerhub_application_id, l.locker_no, l.locker_size, l.linked_amount, l.status,
            l.linked_at, a.application_no, a.id AS application_id
       FROM locker_deposit_links l JOIN applications a ON a.id = l.application_id
      WHERE a.customer_id = $1 ORDER BY (l.status = 'active') DESC, l.id DESC`, [customerId])).rows;
  const cheques = (await db.query<Record<string, unknown>>(
    `SELECT id, lockerhub_application_id, leg, amount, cheque_no, bank_name, status, received_on, cleared_on
       FROM locker_cheques WHERE customer_id = $1 ORDER BY (status = 'Pending') DESC, id DESC`, [customerId])).rows;

  let lockerhub: Record<string, unknown> | null = null;
  let lockerhub_error: string | null = null;
  if (c.phone) {
    try { lockerhub = await lh.getCustomer(String(c.phone)) as Record<string, unknown>; }
    catch (e) { lockerhub_error = (e as Error).message; }
  }

  return {
    lockerhub,        // their tenant/locker record (null if unknown or unreachable)
    lockerhub_error,  // surfaced so staff know it's a fetch failure, not "no lockers"
    pledges: pledges.map((p) => ({
      id: Number(p.id), application_id: Number(p.application_id), application_no: p.application_no,
      lockerhub_application_id: p.lockerhub_application_id, locker_no: p.locker_no, locker_size: p.locker_size,
      linked_amount: Number(p.linked_amount), status: p.status, linked_at: p.linked_at,
    })),
    cheques: cheques.map((q) => ({
      id: Number(q.id), lockerhub_application_id: q.lockerhub_application_id, leg: q.leg,
      amount: Number(q.amount), cheque_no: q.cheque_no, bank_name: q.bank_name, status: q.status,
      received_on: toISODate(q.received_on as string | null), cleared_on: toISODate(q.cleared_on as string | null),
    })),
  };
}

/**
 * Locker tenants, branch-wise — EVERY tenant, not just the ones NCD backs.
 *
 * The spine is LockerHub's GET /locker-tenants, which returns every occupied
 * locker with the tenant's identity, locker number, size and lease dates.
 * (Their /lockers is the opposite view — vacant lockers only — which is why
 * this screen used to be NCD-backed lockers alone.) Omitting branch_id returns
 * all branches in ONE call; pass it to scope to a branch.
 *
 * Identity is `tenant_id`: their tenancy primary key, immutable, 1:1 with the
 * allotment, present on every row. Do NOT key on application_id — most
 * tenancies never had an application (staff create tenants directly), so it is
 * empty by design rather than by failure.
 *
 * Their query already filters to occupied + open tenancies, so `status` is
 * always "occupied" and Closed/Cancelled never appear — a tenancy vanishing
 * from the roster IS the closure signal. `account_status` (Active | Closure
 * Requested) is the one that varies; lease state comes from lease_expires_on.
 *
 * Two things are layered on top:
 *   1. NCD involvement — a deposit pledge or a recorded cheque. NCD can only be
 *      involved through a locker APPLICATION, and a tenancy created from an
 *      application does carry application_id, so that is the join. There is no
 *      phone fallback: a roster row with no application_id cannot be ours.
 *   2. The lockers NCD is involved in that are NOT occupied yet (payment_pending,
 *      awaiting allotment). Those can never appear in a roster of occupied
 *      lockers, but staff still need them on this screen, so they're appended.
 */
export async function lockerTenants(db: Db, opts: { branchId?: string } = {}) {
  const last10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);
  let lockerhub_error: string | null = null;

  // One call, whether that's a single branch or all of them.
  let roster: Array<Record<string, any>> = [];
  let rosterRead = false;
  try {
    roster = ((await lh.lockerTenants(opts.branchId)).tenants ?? []) as Array<Record<string, any>>;
    rosterRead = true;
  } catch (e) { lockerhub_error = (e as Error).message; }

  const ours = (await db.query<Record<string, unknown>>(
    `SELECT x.lockerhub_application_id,
            max(x.customer_id) AS customer_id,
            sum(x.pledged)::numeric AS pledged,
            max(x.cheque_pending)::int AS cheque_pending
       FROM (
         SELECT l.lockerhub_application_id, a.customer_id,
                CASE WHEN l.status = 'active' THEN l.linked_amount ELSE 0 END AS pledged,
                0 AS cheque_pending
           FROM locker_deposit_links l JOIN applications a ON a.id = l.application_id
         UNION ALL
         SELECT q.lockerhub_application_id, q.customer_id, 0 AS pledged,
                CASE WHEN q.status = 'Pending' THEN 1 ELSE 0 END AS cheque_pending
           FROM locker_cheques q
       ) x
      GROUP BY x.lockerhub_application_id
      ORDER BY x.lockerhub_application_id
      LIMIT 300`)).rows;

  // Resolve each against LockerHub (they hold branch + tenant + allotment).
  // Bounded concurrency: this is a staff screen, not a hot path.
  const CHUNK = 6;
  const resolved: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ours.length; i += CHUNK) {
    const slice = ours.slice(i, i + CHUNK);
    const out = await Promise.all(slice.map(async (r) => {
      const id = String(r.lockerhub_application_id);
      try {
        const a = await lh.getLockerApplication(id) as Record<string, any>;
        return { row: r, app: a, error: null as string | null };
      } catch (e) {
        if (!lockerhub_error) lockerhub_error = (e as Error).message;
        return { row: r, app: null, error: (e as Error).message };
      }
    }));
    resolved.push(...out as Array<Record<string, unknown>>);
  }

  const custIds = ours.map((r) => Number(r.customer_id)).filter((n) => Number.isFinite(n) && n > 0);
  const custs = custIds.length
    ? (await db.query<Record<string, unknown>>(
        'SELECT id, full_name, customer_code, phone FROM customers WHERE id = ANY($1)', [custIds])).rows
    : [];
  const custById = new Map(custs.map((c) => [Number(c.id), c]));

  // NCD's own involvement, keyed for matching against the roster.
  const oursRows = resolved.map((x: any) => {
    const r = x.row as Record<string, unknown>;
    const a = x.app as Record<string, any> | null;
    const c = custById.get(Number(r.customer_id));
    return {
      tenant_id: null as string | null, // not yet allotted — no tenancy exists
      lockerhub_application_id: String(r.lockerhub_application_id),
      application_no: a?.application_no ?? null,
      branch_id: a?.branch_id ?? null,
      branch_name: null as string | null,
      locker_size: a?.locker_size ?? null,
      status: a?.status ?? a?.application_status ?? null,
      account_status: null as string | null,
      locker_no: a?.allotment?.locker_number ?? a?.allotment?.locker_no ?? null,
      tenant_name: a?.name ?? (c?.full_name ?? null),
      tenant_phone: a?.phone ?? (c?.phone ?? null),
      tenant_email: a?.email ?? null,
      allotted_on: a?.allotment?.allotted_on ?? null,
      lease_expires_on: a?.allotment?.lease_expires_on ?? null,
      customer_id: c ? Number(c.id) : null,
      customer_code: c?.customer_code ?? null,
      pledged_amount: Number(r.pledged ?? 0),
      cheque_pending: Number(r.cheque_pending ?? 0) > 0,
      ncd_backed: true,
      unresolved: !a,
    };
  });

  // Link roster tenants to NCD customers so a tenant who IS one of our customers
  // clicks through. Phone alone is not enough to assert identity — shared family
  // numbers have produced real mismatches here before — so the surname/first
  // token must agree too. A disagreement shows the tenant unlinked, never wrong.
  const rosterPhones = [...new Set(roster.map((t) => last10(t.tenant?.phone)).filter((p) => p.length === 10))];
  const byPhone = rosterPhones.length
    ? (await db.query<Record<string, unknown>>(
        `SELECT id, full_name, customer_code, phone FROM customers
          WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = ANY($1)`, [rosterPhones])).rows
    : [];
  const custByPhone = new Map(byPhone.map((c) => [last10(c.phone), c]));
  const nameAgrees = (a: unknown, b: unknown) => {
    const toks = (v: unknown) => new Set(String(v ?? '').toLowerCase().split(/[^a-z]+/i).filter((t) => t.length > 2));
    const x = toks(a); const y = toks(b);
    for (const t of x) if (y.has(t)) return true;
    return false;
  };

  // Merge. A roster row wins on identity (it is the allotted truth); NCD's
  // pledge/cheque is layered onto it. Anything of ours the roster doesn't cover
  // — not allotted yet — is appended so it can't silently disappear.
  const oursByAppId = new Map(oursRows.map((r) => [r.lockerhub_application_id, r]));
  const consumed = new Set<string>();

  const rosterRows = roster.map((t) => {
    // application_id is empty for tenancies staff created directly, and that is
    // a fact about the tenancy, not a failed lookup. NCD can only be involved
    // via an application, so no application_id means it cannot be ours.
    const appId = String(t.application_id ?? '').trim();
    const mine = appId ? oursByAppId.get(appId) : undefined;
    if (mine) consumed.add(mine.lockerhub_application_id);
    const phone = last10(t.tenant?.phone);
    const viaPhone = custByPhone.get(phone);
    const c = mine?.customer_id
      ? custById.get(mine.customer_id)
      : (viaPhone && nameAgrees(viaPhone.full_name, t.tenant?.name) ? viaPhone : undefined);
    return {
      tenant_id: String(t.tenant_id ?? ''),
      lockerhub_application_id: appId || null,
      application_no: mine?.application_no ?? null,
      branch_id: t.branch_id ?? null,
      branch_name: t.branch_name ?? null,
      locker_size: t.size ?? null,
      status: t.status ?? 'occupied',
      account_status: t.account_status ?? null,
      locker_no: t.locker_number ?? null,
      tenant_name: t.tenant?.name ?? null,
      tenant_phone: t.tenant?.phone ?? null,
      tenant_email: t.tenant?.email || null,
      allotted_on: t.allotted_on ?? null,
      lease_expires_on: t.lease_expires_on ?? null,
      customer_id: c ? Number(c.id) : null,
      customer_code: c?.customer_code ?? null,
      pledged_amount: mine?.pledged_amount ?? 0,
      cheque_pending: mine?.cheque_pending ?? false,
      ncd_backed: !!mine,
      unresolved: false,
    };
  });

  const leftover = oursRows
    .filter((r) => !consumed.has(r.lockerhub_application_id))
    .filter((r) => (opts.branchId ? r.branch_id === opts.branchId : true));

  const rows = [...rosterRows, ...leftover];

  return {
    rows,
    // The roster is all-or-nothing now — one call, so either we have it or we
    // don't. False means the page is showing NCD's own rows only.
    roster_complete: rosterRead,
    lockerhub_error,
  };
}
