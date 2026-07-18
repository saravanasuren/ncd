/**
 * Shared "book" queries (docs/06 §1). The dashboard, the segments explorer,
 * and the 9-tab Excel export ALL read these functions with the same filters
 * + scope — so an export always equals what's on screen. This is the single
 * source of truth for portfolio numbers.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { round2 } from '../../lib/dates.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

/** SQL list literal for the outstanding-book status set, e.g. 'Active','PendingAllotment',… */
const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');

export interface BookFilters {
  from?: string;
  to?: string;
  seriesIds?: number[];
  districts?: string[];
  status?: 'active' | 'redeemed' | 'all';
}

const APP_SCOPE = { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id' };

/** Build the shared WHERE for application-based queries (scope + filters). */
function appWhere(actor: AuthUser, filters: BookFilters, extra: string[] = []): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scopeFor(actor), APP_SCOPE, 0);
  conds.push(sc.sql); params.push(...sc.params);
  if (filters.status === 'active') conds.push(`a.status IN (${OUTSTANDING_SQL_LIST})`);
  else if (filters.status === 'redeemed') conds.push("a.status = 'Redeemed'");
  if (filters.seriesIds?.length) { params.push(filters.seriesIds); conds.push(`a.series_id = ANY($${params.length})`); }
  if (filters.districts?.length) { params.push(filters.districts); conds.push(`c.district = ANY($${params.length})`); }
  // Optional money-in date window (flow metrics). Snapshot callers pass no dates.
  if (filters.from) { params.push(filters.from); conds.push(`a.date_money_received >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); conds.push(`a.date_money_received <= $${params.length}`); }
  conds.push(...extra);
  return { sql: conds.join(' AND '), params };
}

const FROM = `FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
  LEFT JOIN LATERAL (
    SELECT sum(al.outstanding_amount) FILTER (WHERE al.status = 'Active') AS live
    FROM application_lines al WHERE al.application_id = a.id
  ) bk ON TRUE`;

/**
 * Book amount of one application: the LIVE line-level outstanding (partial
 * premature withdrawals reduce it), falling back to the subscribed amount when
 * no line has been touched. Wealth's book nets partials the same way — summing
 * a.total_amount overstated the book by every partial withdrawal (₹25L found
 * 2026-07-18: three part-redeemed investments).
 */
const AMT = 'COALESCE(bk.live, a.total_amount)';

/**
 * Attribution (docs/06 §1). Who REFERRED the customer lives in the free-text
 * `referred_by_text` (imported from wealth) — NOT the structured enroller
 * columns. `sref.full_name` is the referrer matched to a STAFF user (a
 * non-customer `users` row, by name): such referrers show Staff-wise; every
 * other non-blank referrer shows Agent-wise by their typed name; blank → Direct.
 * (Phase 2 replaces the name match with a code + is_staff lookup.)
 */
const FROM_ATTR = `${FROM}
  LEFT JOIN LATERAL (
    SELECT u.full_name FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name <> 'customer' AND u.is_staff = TRUE
      AND (lower(btrim(u.full_name)) = lower(btrim(a.referred_by_text))
           OR upper(btrim(u.code)) = upper(btrim(a.referred_by_text)))
    LIMIT 1
  ) sref ON TRUE`;
const REFERRER = "NULLIF(btrim(a.referred_by_text), '')";

export async function kpis(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const active = appWhere(actor, { ...filters, status: 'active' });
  const outstanding = await db.query<{ v: string; n: string; inv: string }>(
    `SELECT COALESCE(sum(${AMT}),0) AS v, count(a.id)::int AS n, count(DISTINCT a.customer_id)::int AS inv ${FROM} WHERE ${active.sql}`, active.params);
  // interest paid (net) and due, over the schedule for in-scope apps
  const scopeAll = appWhere(actor, {});
  const paid = await db.query<{ v: string }>(
    `SELECT COALESCE(sum(ds.net_amount),0) AS v FROM disbursement_schedule ds
     WHERE ds.status = 'Paid' AND ds.due_type IN ('Interest','BrokenInterest')
       AND ds.application_id IN (SELECT a.id ${FROM} WHERE ${scopeAll.sql})`, scopeAll.params);
  const due = await db.query<{ v: string }>(
    `SELECT COALESCE(sum(ds.net_amount),0) AS v FROM disbursement_schedule ds
     WHERE ds.status = 'Scheduled' AND ds.due_type IN ('Interest','BrokenInterest')
       AND ds.application_id IN (SELECT a.id ${FROM} WHERE ${scopeAll.sql})`, scopeAll.params);
  const r = outstanding.rows[0]!;
  return {
    outstanding_book: round2(Number(r.v)),
    active_investments: Number(r.n),
    active_investors: Number(r.inv),
    interest_paid: round2(Number(paid.rows[0]!.v)),
    interest_scheduled: round2(Number(due.rows[0]!.v)),
  };
}

export async function seriesSummary(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, filters);
  const { rows } = await db.query(
    `SELECT s.id AS series_id, s.code, s.status,
            count(a.id)::int AS investments,
            count(DISTINCT a.customer_id)::int AS investors,
            COALESCE(sum(${AMT}) FILTER (WHERE a.status IN (${OUTSTANDING_SQL_LIST})),0) AS outstanding,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status = 'Redeemed'),0) AS redeemed,
            COALESCE(sum(a.total_amount),0) AS issued
     ${FROM} WHERE ${w.sql} GROUP BY s.id, s.code, s.status ORDER BY s.code`, w.params);
  return rows;
}

export async function depositorwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT c.full_name AS name, COALESCE(sum(${AMT}),0) AS amount
     ${FROM} WHERE ${w.sql} GROUP BY c.full_name ORDER BY c.full_name`, w.params);
  return rows;
}

export async function districtwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT COALESCE(c.district,'Unassigned') AS district, count(DISTINCT a.customer_id)::int AS investors,
            COALESCE(sum(${AMT}),0) AS amount
     ${FROM} WHERE ${w.sql} GROUP BY COALESCE(c.district,'Unassigned') ORDER BY amount DESC`, w.params);
  return rows;
}

export async function agentwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT COALESCE(${REFERRER},'Direct') AS agent, c.full_name AS customer, COALESCE(sum(${AMT}),0) AS amount
     ${FROM_ATTR}
     WHERE ${w.sql} AND sref.full_name IS NULL
     GROUP BY COALESCE(${REFERRER},'Direct'), c.full_name ORDER BY agent, customer`, w.params);
  return rows;
}

export async function staffwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT sref.full_name AS staff, c.full_name AS customer, COALESCE(sum(${AMT}),0) AS amount
     ${FROM_ATTR}
     WHERE ${w.sql} AND sref.full_name IS NOT NULL
     GROUP BY sref.full_name, c.full_name ORDER BY staff, customer`, w.params);
  return rows;
}

export async function customerwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT c.customer_code, c.full_name AS customer, c.district,
            COALESCE(sref.full_name, ${REFERRER}, '—') AS sourced_by,
            count(a.id)::int AS ncds, COALESCE(sum(${AMT}),0) AS outstanding
     ${FROM_ATTR}
     WHERE ${w.sql} GROUP BY c.customer_code, c.full_name, c.district, COALESCE(sref.full_name, ${REFERRER}, '—') ORDER BY customer`, w.params);
  return rows;
}

/** Lead pipeline funnel — count + Σ expected amount per lead status (scoped). */
export async function leadFunnel(db: Db, actor: AuthUser) {
  const sc = scopeWhere(scopeFor(actor), { userCol: 'l.created_by_user_id', agentCol: 'l.created_by_agent_id', branchCol: 'l.branch_id' }, 0);
  const { rows } = await db.query<{ status: string; n: string; expected: string }>(
    `SELECT COALESCE(l.status,'New') AS status, count(*)::int AS n, COALESCE(sum(l.expected_amount),0) AS expected
       FROM investor_leads l WHERE ${sc.sql} GROUP BY COALESCE(l.status,'New') ORDER BY n DESC`, sc.params);
  return rows.map((r) => ({ status: r.status, count: Number(r.n), expected: round2(Number(r.expected)) }));
}

/** ALM tiles — asset-liability timing of the interest/redemption schedule.
 *   net_due_this_month : Scheduled payouts due in the current calendar month
 *   overdue            : Scheduled payouts whose due_date is already past
 *   paid_fy            : Paid payouts in the current Indian financial year (Apr–Mar)
 * All net amounts, scoped to the actor's applications. */
export async function alm(db: Db, actor: AuthUser, asOf: string) {
  const scopeAll = appWhere(actor, {});
  const inScope = `ds.application_id IN (SELECT a.id ${FROM} WHERE ${scopeAll.sql})`;
  const d = new Date(`${asOf}T00:00:00Z`);
  const monthStart = `${asOf.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const fyStartYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const fyStart = `${fyStartYear}-04-01`;
  const fyEnd = `${fyStartYear + 1}-03-31`;

  const q = async (cond: string, params: unknown[]) =>
    Number((await db.query<{ v: string }>(`SELECT COALESCE(sum(ds.net_amount),0) AS v FROM disbursement_schedule ds WHERE ${cond} AND ${inScope}`, params)).rows[0]!.v);

  const p = scopeAll.params;
  const [netDueThisMonth, overdue, paidFy] = await Promise.all([
    q(`ds.status = 'Scheduled' AND ds.due_date >= $${p.length + 1}::date AND ds.due_date <= $${p.length + 2}::date`, [...p, monthStart, monthEnd]),
    q(`ds.status = 'Scheduled' AND ds.due_date < $${p.length + 1}::date`, [...p, asOf]),
    q(`ds.status = 'Paid' AND ds.due_date >= $${p.length + 1}::date AND ds.due_date <= $${p.length + 2}::date`, [...p, fyStart, fyEnd]),
  ]);
  return { net_due_this_month: round2(netDueThisMonth), overdue: round2(overdue), paid_fy: round2(paidFy), fy_label: `FY${String(fyStartYear).slice(2)}-${String(fyStartYear + 1).slice(2)}` };
}

/** Cost-of-funds rate mix — outstanding principal grouped by coupon rate, so
 * the weighted average cost of the book is visible. Uses application_lines. */
export async function rateMix(db: Db, actor: AuthUser) {
  const w = appWhere(actor, { status: 'active' });
  const { rows } = await db.query<{ rate: string; outstanding: string; investments: string }>(
    `SELECT al.coupon_rate_pct AS rate, COALESCE(sum(al.outstanding_amount),0) AS outstanding, count(DISTINCT a.id)::int AS investments
       ${FROM} JOIN application_lines al ON al.application_id = a.id
      WHERE ${w.sql} GROUP BY al.coupon_rate_pct ORDER BY al.coupon_rate_pct`, w.params);
  const mix = rows.map((r) => ({ rate: Number(r.rate), outstanding: round2(Number(r.outstanding)), investments: Number(r.investments) }));
  const total = mix.reduce((s, m) => s + m.outstanding, 0);
  const weightedAvg = total > 0 ? round2(mix.reduce((s, m) => s + m.rate * m.outstanding, 0) / total) : 0;
  return { mix, weighted_avg_rate: weightedAvg, total_outstanding: round2(total) };
}

/** Today's book — money in / out that landed today (independent of the range). */
export async function todayBook(db: Db, actor: AuthUser, today: string) {
  // additions: new investments funded today
  const addScope = appWhere(actor, {});
  const additions = await db.query<{ n: string; amt: string }>(
    `SELECT count(a.id)::int AS n, COALESCE(sum(a.total_amount),0) AS amt ${FROM}
      WHERE ${addScope.sql} AND a.date_money_received = $${addScope.params.length + 1}::date`, [...addScope.params, today]);
  // deletions: redemptions created today (scoped via their application)
  const redScope = appWhere(actor, {});
  const deletions = await db.query<{ n: string; amt: string }>(
    `SELECT count(r.id)::int AS n, COALESCE(sum(r.net_payment),0) AS amt FROM redemptions r
      WHERE r.created_at::date = $${redScope.params.length + 1}::date
        AND r.application_id IN (SELECT a.id ${FROM} WHERE ${redScope.sql})`, [...redScope.params, today]);
  return {
    additions: { count: Number(additions.rows[0]!.n), amount: round2(Number(additions.rows[0]!.amt)) },
    deletions: { count: Number(deletions.rows[0]!.n), amount: round2(Number(deletions.rows[0]!.amt)) },
  };
}

/** Flat application register — one row per investment line (allotment/maturity
 * dates, coupon, tenure). For the NCD Book "Applications" sheet + data backup. */
export async function applicationsFlat(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, filters);
  const { rows } = await db.query(
    `SELECT a.application_no, c.customer_code, c.full_name AS customer, s.code AS series_code,
            a.status, a.total_amount, a.date_money_received, a.allotment_date, a.maturity_date, a.redemption_date,
            l.coupon_rate_pct, l.tenure_months, l.payout_frequency
     ${FROM} LEFT JOIN application_lines l ON l.application_id = a.id
     WHERE ${w.sql} ORDER BY a.application_no`, w.params);
  return rows;
}

/** Full disbursement ledger (interest / broken-interest / redemption rows) for
 * in-scope applications — gross/TDS/net, status, paid date, UTR. For the NCD Book
 * "Interest Payouts" sheet + data backup. */
export async function interestLedger(db: Db, actor: AuthUser) {
  const w = appWhere(actor, {});
  const { rows } = await db.query(
    `SELECT ds.due_date, a.application_no, c.customer_code, c.full_name AS customer, s.code AS series_code,
            ds.due_type, ds.gross_amount, ds.tds_amount, ds.net_amount, ds.status, ds.paid_at, ds.utr
     FROM disbursement_schedule ds
     JOIN applications a ON a.id = ds.application_id
     JOIN customers c ON c.id = a.customer_id
     JOIN series s ON s.id = a.series_id
     WHERE ${w.sql}
     ORDER BY ds.due_date, a.application_no`, w.params);
  return rows;
}

export type SegmentBy = 'series' | 'customer' | 'district' | 'agent' | 'staff';

export interface SegmentChild {
  application_no: string;
  customer: string;
  customer_code: string;
  series_code: string;
  amount: number;
  status: string;
  allotment_date: string | null;
}
export interface SegmentGroup {
  key: string;
  label: string;
  sublabel: string | null;
  district: string | null;
  sourced_by: string | null;
  investors: number;
  investments: number;
  outstanding: number;
  children: SegmentChild[];
}

/**
 * Grouped view for the Segments explorer: one summary row per dimension value,
 * each carrying its individual NCD investments as `children` (so the UI can
 * expand a group to show every deposit under it). Same scope + filters as the
 * flat segment functions. Fetches once, groups in JS.
 */
export async function segmentGrouped(db: Db, actor: AuthUser, by: SegmentBy, filters: BookFilters = {}): Promise<SegmentGroup[]> {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query<any>(
    `SELECT a.application_no, ${AMT} AS amount, a.status, a.allotment_date,
            c.customer_code, c.full_name AS customer, COALESCE(c.district,'Unassigned') AS district,
            s.code AS series_code, s.status AS series_status,
            sref.full_name AS staff_ref, ${REFERRER} AS referrer
     ${FROM_ATTR}
     WHERE ${w.sql}`, w.params);

  const groups = new Map<string, SegmentGroup>();
  const custSets = new Map<string, Set<string>>();
  // Attribution: referrer matched to a staff user → Staff-wise; else Agent-wise.
  const keyOf = (r: any): string =>
    by === 'series' ? r.series_code : by === 'customer' ? r.customer_code : by === 'district' ? r.district
    : by === 'agent' ? (r.referrer ?? 'Direct') : (r.staff_ref ?? '');

  for (const r of rows) {
    if (by === 'staff' && !r.staff_ref) continue;   // staff view = staff-referred only
    if (by === 'agent' && r.staff_ref) continue;    // agent view excludes staff-referred
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label: by === 'customer' ? r.customer : key,
        sublabel: by === 'customer' ? r.customer_code : by === 'series' ? r.series_status : null,
        district: by === 'customer' ? r.district : null,
        sourced_by: by === 'customer' ? (r.staff_ref ?? r.referrer ?? '—') : null,
        investors: 0, investments: 0, outstanding: 0, children: [],
      };
      groups.set(key, g);
      custSets.set(key, new Set());
    }
    g.investments += 1;
    g.outstanding = round2(g.outstanding + Number(r.amount));
    custSets.get(key)!.add(r.customer_code);
    g.children.push({
      application_no: r.application_no, customer: r.customer, customer_code: r.customer_code,
      series_code: r.series_code, amount: round2(Number(r.amount)), status: r.status,
      allotment_date: r.allotment_date ?? null,
    });
  }
  for (const [key, g] of groups) g.investors = custSets.get(key)!.size;
  const out = [...groups.values()].sort((a, b) => b.outstanding - a.outstanding);
  for (const g of out) g.children.sort((a, b) => b.amount - a.amount);
  return out;
}

export async function redemptions(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, {});
  const params = [...w.params];
  let dateCond = '';
  if (filters.from) { params.push(filters.from); dateCond += ` AND r.redemption_date >= $${params.length}`; }
  if (filters.to) { params.push(filters.to); dateCond += ` AND r.redemption_date <= $${params.length}`; }
  const { rows } = await db.query(
    `SELECT r.redemption_date, r.type, s.code AS series_code, c.full_name AS customer_name, r.net_payment
     FROM redemptions r JOIN applications a ON a.id = r.application_id
     JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE r.status = 'Approved' AND ${w.sql}${dateCond}
     ORDER BY r.redemption_date`, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Flow metrics (dashboard tiles). "Money in" = new investments whose
// date_money_received falls in the selected window (filters.from/to). All
// respect scope + series filter. Snapshot tiles (outstanding, active series)
// use the plain queries above with no dates.
// ─────────────────────────────────────────────────────────────────────────

/** New-money totals for the window, split by funding channel. */
export async function moneyInByChannel(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: 'active' });
  const { rows } = await db.query<{ total: string; locker: string; app: string; n: string }>(
    `SELECT COALESCE(sum(a.total_amount),0) AS total,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.is_locker_deposit),0) AS locker,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.source IN ('dhanamfin','lockerhub')),0) AS app,
            count(a.id)::int AS n
     ${FROM} WHERE ${w.sql} AND a.date_money_received IS NOT NULL`, w.params);
  const r = rows[0]!;
  return { total: round2(Number(r.total)), locker: round2(Number(r.locker)), app: round2(Number(r.app)), count: Number(r.n) };
}

/** New-investment list for the window; optional channel = 'locker' | 'app'. */
export async function newInvestmentsList(db: Db, actor: AuthUser, filters: BookFilters = {}, channel?: 'locker' | 'app') {
  const extra = ['a.date_money_received IS NOT NULL'];
  if (channel === 'locker') extra.push('a.is_locker_deposit');
  if (channel === 'app') extra.push(`a.source IN ('dhanamfin','lockerhub')`);
  const w = appWhere(actor, { ...filters, status: 'active' }, extra);
  const { rows } = await db.query(
    `SELECT a.application_no, c.full_name AS customer, c.customer_code, s.code AS series_code,
            a.total_amount AS amount, a.date_money_received, a.is_locker_deposit, a.source, a.status
     ${FROM} WHERE ${w.sql} ORDER BY a.date_money_received DESC, a.application_no`, w.params);
  return rows;
}

/** Interest whose payout date lands in the window (net). Total + rows. */
function interestWhere(actor: AuthUser, filters: BookFilters): { sql: string; params: unknown[] } {
  // Scope + optional series, but the date window applies to ds.due_date (added by caller).
  const scope = appWhere(actor, { seriesIds: filters.seriesIds });
  return scope;
}
export async function interestInRange(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const scope = interestWhere(actor, filters);
  const params = [...scope.params];
  let dcond = '';
  if (filters.from) { params.push(filters.from); dcond += ` AND ds.due_date >= $${params.length}`; }
  if (filters.to) { params.push(filters.to); dcond += ` AND ds.due_date <= $${params.length}`; }
  const { rows } = await db.query<{ total: string; n: string; paid: string }>(
    `SELECT COALESCE(sum(ds.net_amount),0) AS total, count(*)::int AS n,
            COALESCE(sum(ds.net_amount) FILTER (WHERE ds.status = 'Paid'),0) AS paid
     FROM disbursement_schedule ds
     WHERE ds.due_type IN ('Interest','BrokenInterest')
       AND ds.application_id IN (SELECT a.id ${FROM} WHERE ${scope.sql})${dcond}`, params);
  const r = rows[0]!;
  return { total: round2(Number(r.total)), paid: round2(Number(r.paid)), count: Number(r.n) };
}
export async function interestListInRange(db: Db, actor: AuthUser, filters: BookFilters = {}, onlyPaid = false) {
  const scope = interestWhere(actor, filters);
  const params = [...scope.params];
  let dcond = '';
  if (filters.from) { params.push(filters.from); dcond += ` AND ds.due_date >= $${params.length}`; }
  if (filters.to) { params.push(filters.to); dcond += ` AND ds.due_date <= $${params.length}`; }
  if (onlyPaid) dcond += ` AND ds.status = 'Paid'`;
  const { rows } = await db.query(
    `SELECT ds.due_date, a.application_no, c.full_name AS customer, s.code AS series_code,
            ds.due_type, ds.net_amount AS amount, ds.status, ds.paid_at
     FROM disbursement_schedule ds
     JOIN applications a ON a.id = ds.application_id
     JOIN customers c ON c.id = a.customer_id
     JOIN series s ON s.id = a.series_id
     WHERE ds.due_type IN ('Interest','BrokenInterest')
       AND ds.application_id IN (SELECT a.id ${FROM} WHERE ${scope.sql})${dcond}
     ORDER BY ds.due_date DESC, a.application_no`, params);
  return rows;
}

/** Interest accrued (since the last payout anchor up to asOf) across the live book.
 * accrued = Σ outstanding × coupon% ÷ 365 × days(anchor→asOf), never before interest_start_date. */
export async function interestAccrued(db: Db, actor: AuthUser, filters: BookFilters, anchor: string, asOf: string) {
  const w = appWhere(actor, { seriesIds: filters.seriesIds, status: 'active' });
  const p = [...w.params, anchor, asOf];
  const ai = p.length - 1, oi = p.length; // anchor=$ai, asOf=$oi
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(
        l.outstanding_amount * (l.coupon_rate_pct/100.0)
        * GREATEST(0, ($${oi}::date - GREATEST($${ai}::date, a.interest_start_date))) / 365.0
     ),0) AS total
     ${FROM} JOIN application_lines l ON l.application_id = a.id
     WHERE ${w.sql} AND l.status = 'Active' AND a.interest_start_date IS NOT NULL`, p);
  return { total: round2(Number(rows[0]!.total)) };
}
export async function accruedList(db: Db, actor: AuthUser, filters: BookFilters, anchor: string, asOf: string) {
  const w = appWhere(actor, { seriesIds: filters.seriesIds, status: 'active' });
  const p = [...w.params, anchor, asOf];
  const ai = p.length - 1, oi = p.length;
  const { rows } = await db.query(
    `SELECT a.application_no, c.full_name AS customer, s.code AS series_code,
            l.outstanding_amount AS principal, l.coupon_rate_pct,
            GREATEST(0, ($${oi}::date - GREATEST($${ai}::date, a.interest_start_date)))::int AS days,
            round(l.outstanding_amount * (l.coupon_rate_pct/100.0)
              * GREATEST(0, ($${oi}::date - GREATEST($${ai}::date, a.interest_start_date))) / 365.0, 2) AS amount
     ${FROM} JOIN application_lines l ON l.application_id = a.id
     WHERE ${w.sql} AND l.status = 'Active' AND a.interest_start_date IS NOT NULL
     ORDER BY amount DESC, a.application_no`, p);
  return rows;
}

export async function ongoingSeriesPivot(db: Db, actor: AuthUser, seriesId: number) {
  // Ongoing NCD tab: referrer → customer → amount for one series.
  const w = appWhere(actor, { seriesIds: [seriesId] });
  const { rows } = await db.query(
    `SELECT COALESCE(${REFERRER},'Direct') AS agent, c.full_name AS customer, COALESCE(sum(${AMT}),0) AS amount
     ${FROM}
     WHERE ${w.sql} GROUP BY COALESCE(${REFERRER},'Direct'), c.full_name ORDER BY agent, customer`, w.params);
  return rows;
}

export async function masterClient(db: Db, actor: AuthUser) {
  const w = appWhere(actor, {});
  const { rows } = await db.query(
    `SELECT DISTINCT c.pan, c.customer_code, COALESCE(${REFERRER}, '—') AS agent_code,
            c.full_name AS name, c.phone, c.district, c.address
     ${FROM}
     WHERE ${w.sql} ORDER BY c.full_name`, w.params);
  return rows;
}

export async function leadsByStatus(db: Db, actor: AuthUser) {
  if (actor.permissions.includes('leads:read-all')) {
    return (await db.query('SELECT status, full_name, phone, place, source, interested_scheme, expected_amount, follow_up_date FROM investor_leads ORDER BY status, full_name')).rows;
  }
  const sc = scopeWhere(scopeFor(actor), { userCol: 'created_by_user_id', agentCol: 'created_by_agent_id', branchCol: 'branch_id' }, 0);
  return (await db.query(`SELECT status, full_name, phone, place, source, interested_scheme, expected_amount, follow_up_date FROM investor_leads WHERE ${sc.sql} ORDER BY status, full_name`, sc.params)).rows;
}
