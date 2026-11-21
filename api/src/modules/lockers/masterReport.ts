/**
 * Locker Master Report (owner 2026-11-21) — the locker book in one place, the
 * way the NCD book is for investments.
 *
 * One row per PHYSICAL locker, vacant ones included, so this doubles as the
 * stock position: the existing Locker Rent Report and Locker Tenants only ever
 * list lockers somebody holds, and "how many Large are free at Hosur" is not a
 * question either of them can answer.
 *
 * Occupied lockers come from lockerRentReport(), not from a second query of our
 * own: that function already resolves the LockerHub roster, drops the removed /
 * cancelled / superseded applications, matches tenants to NCD customers and
 * applies the branch scope — and it decides rent through rentStatus.ts, so the
 * rent a locker shows here can never disagree with the Rent Report. Everything
 * below only ADDS to those rows.
 *
 * Degrades rather than fails. If LockerHub cannot be read the occupied side
 * comes back with whatever the rent report salvaged; if the per-branch vacant
 * call fails the report still renders, with `vacant_unavailable` set, because a
 * locker book missing its empty rows is worth more than an error page.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import type { RentStatus } from '@new-wealth/shared';
import * as lh from '../../integrations/lockerhub/client.js';
import { lockerRentReport, type LockerRentRow } from './report.js';
import { lockerBranchScopeFor } from './branchScope.js';

export interface LockerMasterRow {
  // ── the locker itself ──
  branch: string | null;
  locker_no: string | null;
  size: string | null;
  occupancy: 'Occupied' | 'Vacant';

  // ── who holds it (occupied only) ──
  lockerhub_application_id: string | null;
  application_no: string | null;
  customer_name: string | null;
  customer_code: string | null;
  phone: string | null;
  joint_hirers: string | null;
  authorised_users: string | null;

  // ── dates ──
  allotted_on: string | null;
  backdated: boolean;

  // ── agreement ──
  agreement_no: string | null;
  agreement_status: string | null;
  agreement_method: string | null;
  signed_on: string | null;

  // ── money ──
  rent_amount: number | null;
  rent_status: RentStatus | null;
  deposit_amount: number | null;
  deposit_ncd_app_no: string | null;
}

export interface LockerBranchSummary {
  branch: string;
  total: number;
  occupied: number;
  vacant: number;
  /**
   * NULL when the vacant side could not be read. Occupied ÷ (occupied + 0) is
   * 100%, which would report a full cabinet at every branch on the morning
   * LockerHub is down — the same trap the rent status avoids with "Unknown".
   * An unanswered question is not an answer.
   */
  occupancy_pct: number | null;
}

export interface LockerMasterReport {
  rows: LockerMasterRow[];
  branches: LockerBranchSummary[];
  totals: {
    lockers: number; occupied: number; vacant: number; occupancy_pct: number | null;
    agreement_signed: number; agreement_missing: number;
    rent_unpaid: number; deposit_linked: number;
  };
  /** LockerHub could not be reached at all — the occupied side may be short. */
  lockerhub_error: string | null;
  /** The vacant side could not be read; occupied rows are still complete. */
  vacant_unavailable: boolean;
  generated_at: string;
}

/** An agreement nobody has started leaves no signing row at all. */
const NOT_STARTED = 'Not started';

const pick = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
};

const iso = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 10));

/** Run `work` over `items` with at most `limit` in flight — a staff report, not a hot path. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(runners);
  return out;
}

interface Enrichment {
  /**
   * The locker and its hirer as NCD itself recorded them.
   *
   * The rent report reads all of this off the LockerHub application, and
   * resolves the customer by matching that application's PHONE to our book. So
   * when LockerHub cannot be reached, every row comes back with no locker
   * number AND no hirer — a master report that can name neither the locker nor
   * who holds it is no use at all. We hold the same facts ourselves on
   * locker_applications, locker_allotments and the linked customer, so they
   * stand in. LockerHub still wins wherever it answered.
   */
  identity: Map<string, {
    locker_no: string | null; branch: string | null; size: string | null;
    customer_name: string | null; customer_code: string | null; phone: string | null;
  }>;
  allotted: Map<string, { allotted_on: string | null; backdated: boolean }>;
  agreement: Map<string, { status: string; method: string | null; signed_on: string | null }>;
  agreementNo: Map<string, string | null>;
  hirers: Map<string, string>;
  authorised: Map<string, string>;
  deposit: Map<string, { amount: number; app_nos: string | null }>;
}

/** Everything NCD itself knows about these applications, keyed by LockerHub id. */
async function enrich(db: Db, ids: string[]): Promise<Enrichment> {
  const empty: Enrichment = {
    identity: new Map(), allotted: new Map(), agreement: new Map(), agreementNo: new Map(),
    hirers: new Map(), authorised: new Map(), deposit: new Map(),
  };
  if (!ids.length) return empty;

  const [ident, allot, agree, agreeNo, hirers, auth, dep] = await Promise.all([
    // The allotment is the later, more specific record, so it wins where both
    // carry a locker number.
    db.query<{
      id: string; locker_no: string | null; branch: string | null; size: string | null;
      customer_name: string | null; customer_code: string | null; phone: string | null;
    }>(
      `SELECT la.lockerhub_application_id AS id,
              COALESCE(al.locker_no, la.locker_number)   AS locker_no,
              COALESCE(al.branch_name, la.branch_name)   AS branch,
              la.locker_size                             AS size,
              -- The live customer record first; the name snapshotted on the
              -- application is the fallback for a walk-in with no NCD customer.
              COALESCE(c.full_name, la.customer_name)    AS customer_name,
              c.customer_code                            AS customer_code,
              COALESCE(c.phone, la.phone)                AS phone
         FROM locker_applications la
         LEFT JOIN locker_allotments al ON al.lockerhub_application_id = la.lockerhub_application_id
         LEFT JOIN customers c ON c.id = la.customer_id
        WHERE la.lockerhub_application_id = ANY($1)`, [ids]),
    db.query<{ id: string; allotted_on: string | null; backdated: boolean }>(
      `SELECT lockerhub_application_id AS id, allotted_on::text, backdated
         FROM locker_allotments WHERE lockerhub_application_id = ANY($1)`, [ids]),
    // A locker can collect several signing attempts. A Signed row is the answer
    // whenever one exists; otherwise the most recent attempt describes where it
    // has got to.
    db.query<{ id: string; status: string; method: string | null; signed_on: string | null }>(
      `SELECT DISTINCT ON (lockerhub_application_id)
              lockerhub_application_id AS id, status, method, signed_on::text
         FROM locker_agreement_signings
        WHERE lockerhub_application_id = ANY($1)
        ORDER BY lockerhub_application_id, (status = 'Signed') DESC, id DESC`, [ids]),
    db.query<{ id: string; agreement_no: string | null }>(
      `SELECT lockerhub_application_id AS id, agreement_no
         FROM locker_applications WHERE lockerhub_application_id = ANY($1)`, [ids]),
    db.query<{ id: string; names: string }>(
      `SELECT lockerhub_application_id AS id, string_agg(full_name, ', ' ORDER BY position) AS names
         FROM locker_application_hirers WHERE lockerhub_application_id = ANY($1)
        GROUP BY 1`, [ids]),
    // Revoked and still-pending consents are not people who may open the locker.
    db.query<{ id: string; names: string }>(
      `SELECT lockerhub_application_id AS id, string_agg(name, ', ' ORDER BY id) AS names
         FROM locker_authorised_users
        WHERE lockerhub_application_id = ANY($1) AND status = 'active'
        GROUP BY 1`, [ids]),
    // Only a live pledge backs the deposit; a released one is money returned.
    db.query<{ id: string; amount: string; app_nos: string | null }>(
      `SELECT dl.lockerhub_application_id AS id,
              sum(dl.linked_amount)::text AS amount,
              string_agg(DISTINCT a.application_no, ', ') AS app_nos
         FROM locker_deposit_links dl
         JOIN applications a ON a.id = dl.application_id
        WHERE dl.lockerhub_application_id = ANY($1) AND dl.status = 'active'
        GROUP BY 1`, [ids]),
  ]);

  const out = empty;
  for (const r of ident.rows) {
    out.identity.set(r.id, {
      locker_no: r.locker_no, branch: r.branch, size: r.size,
      customer_name: r.customer_name, customer_code: r.customer_code, phone: r.phone,
    });
  }
  for (const r of allot.rows) out.allotted.set(r.id, { allotted_on: iso(r.allotted_on), backdated: r.backdated === true });
  for (const r of agree.rows) out.agreement.set(r.id, { status: r.status, method: r.method, signed_on: iso(r.signed_on) });
  for (const r of agreeNo.rows) out.agreementNo.set(r.id, r.agreement_no);
  for (const r of hirers.rows) out.hirers.set(r.id, r.names);
  for (const r of auth.rows) out.authorised.set(r.id, r.names);
  for (const r of dep.rows) out.deposit.set(r.id, { amount: Number(r.amount), app_nos: r.app_nos });
  return out;
}

/** The vacant lockers, branch by branch. Empty (and flagged) if they can't be read. */
async function vacantRows(db: Db, actor?: AuthUser): Promise<{ rows: LockerMasterRow[]; unavailable: boolean }> {
  if (!lh.lockerHubConfigured()) return { rows: [], unavailable: true };

  let branches: Array<{ id: string; name: string }> = [];
  try { branches = (await lh.branches()).branches; } catch { return { rows: [], unavailable: true }; }

  if (actor) {
    const scope = await lockerBranchScopeFor(db, actor);
    if (scope.restricted) {
      const allowed = new Set(scope.branches.map((b) => b.name.trim().toLowerCase()));
      branches = branches.filter((b) => allowed.has(b.name.trim().toLowerCase()));
    }
  }

  let anyFailed = false;
  const perBranch = await mapLimit(branches, 4, async (b) => {
    try {
      const { lockers } = await lh.lockers(String(b.id));
      return (lockers ?? []).map((l): LockerMasterRow => ({
        branch: b.name,
        locker_no: pick(l, 'locker_number', 'locker_no', 'number', 'name'),
        size: pick(l, 'size', 'locker_size'),
        occupancy: 'Vacant',
        lockerhub_application_id: null, application_no: null,
        customer_name: null, customer_code: null, phone: null,
        joint_hirers: null, authorised_users: null,
        allotted_on: null, backdated: false,
        agreement_no: null, agreement_status: null, agreement_method: null, signed_on: null,
        rent_amount: null, rent_status: null, deposit_amount: null, deposit_ncd_app_no: null,
      }));
    } catch { anyFailed = true; return []; }
  });

  return { rows: perBranch.flat(), unavailable: anyFailed };
}

/** Build the whole report. */
export async function lockerMasterReport(db: Db, actor?: AuthUser): Promise<LockerMasterReport> {
  const rent = await lockerRentReport(db, actor);
  const ids = rent.rows.map((r) => r.lockerhub_application_id).filter(Boolean);
  const [extra, vacant] = await Promise.all([enrich(db, ids), vacantRows(db, actor)]);

  const occupied: LockerMasterRow[] = rent.rows.map((r: LockerRentRow) => {
    const id = r.lockerhub_application_id;
    const a = extra.allotted.get(id);
    const ag = extra.agreement.get(id);
    const dep = extra.deposit.get(id);
    // LockerHub first where it answered, our own record where it did not.
    const idn = extra.identity.get(id);
    return {
      branch: r.branch ?? idn?.branch ?? null,
      locker_no: r.locker_no ?? idn?.locker_no ?? null,
      size: r.size ?? idn?.size ?? null,
      occupancy: 'Occupied',
      lockerhub_application_id: id,
      application_no: r.application_no,
      customer_name: r.customer_name ?? idn?.customer_name ?? null,
      customer_code: r.customer_code ?? idn?.customer_code ?? null,
      phone: r.phone ?? idn?.phone ?? null,
      joint_hirers: extra.hirers.get(id) ?? null,
      authorised_users: extra.authorised.get(id) ?? null,
      allotted_on: a?.allotted_on ?? null,
      backdated: a?.backdated ?? false,
      agreement_no: extra.agreementNo.get(id) ?? null,
      // No signing row at all is itself the finding — ~63 allotted lockers had
      // no signed agreement in either system when this was written, and a blank
      // cell would read as "not loaded" rather than "never done".
      agreement_status: ag?.status ?? NOT_STARTED,
      agreement_method: ag?.method ?? null,
      signed_on: ag?.signed_on ?? null,
      rent_amount: r.rent_amount,
      rent_status: r.rent_status,
      deposit_amount: dep?.amount ?? null,
      deposit_ncd_app_no: dep?.app_nos ?? null,
    };
  });

  const rows = [...occupied, ...vacant.rows].sort((x, y) =>
    (x.branch ?? 'zzz').localeCompare(y.branch ?? 'zzz')
    || String(x.locker_no ?? 'zzz').localeCompare(String(y.locker_no ?? 'zzz'), undefined, { numeric: true }));

  // ── Per-branch stock ──
  const byBranch = new Map<string, LockerBranchSummary>();
  for (const r of rows) {
    const name = r.branch ?? '(branch not known)';
    const s = byBranch.get(name) ?? { branch: name, total: 0, occupied: 0, vacant: 0, occupancy_pct: 0 };
    s.total++;
    if (r.occupancy === 'Occupied') s.occupied++; else s.vacant++;
    byBranch.set(name, s);
  }
  // Occupancy is only meaningful when BOTH sides of the cabinet were counted.
  const pct = (occ: number, total: number): number | null =>
    (vacant.unavailable || !total) ? null : Math.round((occ / total) * 1000) / 10;
  const branches = [...byBranch.values()]
    .map((s) => ({ ...s, occupancy_pct: pct(s.occupied, s.total) }))
    .sort((a, b) => a.branch.localeCompare(b.branch));

  const occupiedCount = occupied.length;
  const vacantCount = vacant.rows.length;
  const total = occupiedCount + vacantCount;

  return {
    rows,
    branches,
    totals: {
      lockers: total,
      occupied: occupiedCount,
      vacant: vacantCount,
      occupancy_pct: pct(occupiedCount, total),
      agreement_signed: occupied.filter((r) => r.agreement_status === 'Signed').length,
      agreement_missing: occupied.filter((r) => r.agreement_status !== 'Signed').length,
      rent_unpaid: occupied.filter((r) => r.rent_status === 'unpaid').length,
      deposit_linked: occupied.reduce((s, r) => s + (r.deposit_amount ?? 0), 0),
    },
    lockerhub_error: rent.lockerhub_error,
    vacant_unavailable: vacant.unavailable,
    generated_at: new Date().toISOString(),
  };
}
