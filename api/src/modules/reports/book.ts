/**
 * Shared "book" queries (docs/06 §1). The dashboard, the segments explorer,
 * and the 9-tab Excel export ALL read these functions with the same filters
 * + scope — so an export always equals what's on screen. This is the single
 * source of truth for portfolio numbers.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { round2, toISODate } from '../../lib/dates.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

/** SQL list literal for the outstanding-book status set, e.g. 'Active','PendingAllotment',… */
const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');
/** Exited (money-returned) statuses — shown in segment expansions alongside the
 * outstanding ones, so a group lists its redeemed customers too. */
const EXITED_STATUS_SQL_LIST = ['Redeemed', 'Matured', 'PrematureWithdrawn', 'RolledOver', 'Transferred'].map((s) => `'${s}'`).join(',');

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
 * Attribution (docs/06 §1). The referrer is resolved to a stable PAYEE:
 *
 *  1. Effective referrer text = the app's own referred_by_text, falling back to
 *     the CUSTOMER's referred_by_text. This makes attribution resilient to a
 *     legacy re-import wiping the app-level copy (the customer copy survives).
 *  2. That text is matched to a payee by CODE first (users.code / agents
 *     .agent_code — stable, rename-proof, spelling-proof), then by name as a
 *     legacy fallback for un-coded historical referrers.
 *  3. A match to an is_staff user → Staff-wise (display = the user's CURRENT
 *     name); a match to an agent → Agent-wise (agent's current name); an
 *     unmatched non-blank referrer → Agent-wise by its raw text; blank → Direct.
 *
 * Going forward the enrol form stores the payee CODE, so renames/spelling
 * variants never break attribution again.
 */
const EFF_REF = "COALESCE(NULLIF(btrim(a.referred_by_text), ''), NULLIF(btrim(c.referred_by_text), ''))";
const FROM_ATTR = `${FROM}
  LEFT JOIN LATERAL (
    SELECT u.full_name FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name <> 'customer' AND u.is_staff = TRUE
      AND (upper(btrim(u.code)) = upper(${EFF_REF})
           OR lower(btrim(u.full_name)) = lower(${EFF_REF}))
    ORDER BY (upper(btrim(u.code)) = upper(${EFF_REF})) DESC
    LIMIT 1
  ) sref ON TRUE
  LEFT JOIN LATERAL (
    SELECT ag.full_name FROM agents ag
    WHERE (upper(btrim(ag.agent_code)) = upper(${EFF_REF})
           OR lower(btrim(ag.full_name)) = lower(${EFF_REF}))
    ORDER BY (upper(btrim(ag.agent_code)) = upper(${EFF_REF})) DESC
    LIMIT 1
  ) aref ON TRUE`;
// Display referrer: resolved staff name → resolved agent name → raw text.
const REFERRER = `COALESCE(sref.full_name, aref.full_name, ${EFF_REF})`;

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
            -- "issued" = money that actually came in over the series' life. Must
            -- match the Segments series-register (segmentGrouped) exactly, so it
            -- excludes never-funded statuses (Rejected/Cancelled/Draft/PendingApproval).
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status NOT IN ('Rejected','Cancelled','Draft','PendingApproval')),0) AS issued
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
/**
 * Run-rate GROSS monthly interest cost of the outstanding book:
 * sum(live outstanding × coupon rate) / 12. Same basis as the cost-of-funds
 * rate mix — includes ALL outstanding (funded-but-not-yet-activated too),
 * unlike the schedule which only exists post-activation. This is the "if the
 * book stood still, what does a month of coupon cost" figure.
 */
export async function monthlyInterestRunRate(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: 'active' });
  const { rows } = await db.query<{ gross_monthly: string; annual: string }>(
    `SELECT COALESCE(sum(al.outstanding_amount * al.coupon_rate_pct/100.0) / 12.0, 0) AS gross_monthly,
            COALESCE(sum(al.outstanding_amount * al.coupon_rate_pct/100.0), 0) AS annual
       ${FROM} JOIN application_lines al ON al.application_id = a.id AND al.status = 'Active'
      WHERE ${w.sql}`, w.params);
  return { gross_monthly: round2(Number(rows[0]!.gross_monthly)), annual: round2(Number(rows[0]!.annual)) };
}

export async function rateMix(db: Db, actor: AuthUser) {
  const w = appWhere(actor, { status: 'active' });
  const { rows } = await db.query<{ rate: string; outstanding: string; investments: string; customers: string }>(
    `SELECT al.coupon_rate_pct AS rate, COALESCE(sum(al.outstanding_amount),0) AS outstanding,
            count(DISTINCT a.id)::int AS investments, count(DISTINCT a.customer_id)::int AS customers
       ${FROM} JOIN application_lines al ON al.application_id = a.id
      WHERE ${w.sql} GROUP BY al.coupon_rate_pct ORDER BY al.coupon_rate_pct`, w.params);
  const mix = rows.map((r) => ({ rate: Number(r.rate), outstanding: round2(Number(r.outstanding)), investments: Number(r.investments), customers: Number(r.customers) }));
  const total = mix.reduce((s, m) => s + m.outstanding, 0);
  const weightedAvg = total > 0 ? round2(mix.reduce((s, m) => s + m.rate * m.outstanding, 0) / total) : 0;
  // True distinct active customers across the whole book — NOT the sum of the
  // per-rate counts (a customer at two rates would be double-counted there).
  const totalCustomers = Number((await db.query<{ c: string }>(
    `SELECT count(DISTINCT a.customer_id)::int AS c ${FROM} WHERE ${w.sql}`, w.params)).rows[0]!.c);
  return { mix, weighted_avg_rate: weightedAvg, total_outstanding: round2(total), total_customers: totalCustomers };
}

/** Today's book — money in / out that landed today (independent of the range). */
export async function todayBook(db: Db, actor: AuthUser, today: string) {
  // additions: new investments funded today, with per-row detail + channel split.
  const addScope = appWhere(actor, {});
  const addRows = (await db.query<Record<string, unknown>>(
    `SELECT a.application_no, c.id AS customer_id, c.full_name AS customer, c.customer_code,
            s.code AS series_code, a.total_amount AS amount, a.date_money_received, a.status,
            NULLIF(btrim(a.referred_by_text), '') AS referred_by,
            CASE WHEN a.is_locker_deposit THEN 'Locker'
                 WHEN a.source IN ('dhanamfin','lockerhub') THEN 'DhanamFin app'
                 ELSE COALESCE(NULLIF(btrim(a.collection_method), ''), 'Physical') END AS received_via
     ${FROM} WHERE ${addScope.sql} AND a.date_money_received = $${addScope.params.length + 1}::date
     ORDER BY a.total_amount DESC, a.application_no`, [...addScope.params, today])).rows;

  // deletions: redemptions created today (scoped via their application), with detail + type split.
  const redScope = appWhere(actor, {});
  const delRows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, a.application_no, c.id AS customer_id, c.full_name AS customer, c.customer_code,
            s.code AS series_code, r.type, r.principal, r.penalty, r.net_payment, r.status, r.redemption_date
     FROM redemptions r JOIN applications a ON a.id = r.application_id
     JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE r.created_at::date = $${redScope.params.length + 1}::date
       AND r.application_id IN (SELECT a.id ${FROM} WHERE ${redScope.sql})
     ORDER BY r.net_payment DESC, r.redemption_no`, [...redScope.params, today])).rows;

  const sumBy = (rows: Record<string, unknown>[], key: string, pred: (r: Record<string, unknown>) => boolean) =>
    round2(rows.filter(pred).reduce((s, r) => s + Number(r[key] ?? 0), 0));

  return {
    additions: {
      count: addRows.length,
      amount: sumBy(addRows, 'amount', () => true),
      app: sumBy(addRows, 'amount', (r) => r.received_via === 'DhanamFin app'),
      locker: sumBy(addRows, 'amount', (r) => r.received_via === 'Locker'),
      physical: sumBy(addRows, 'amount', (r) => r.received_via !== 'DhanamFin app' && r.received_via !== 'Locker'),
      rows: addRows,
    },
    deletions: {
      count: delRows.length,
      amount: sumBy(delRows, 'net_payment', () => true),
      premature: sumBy(delRows, 'net_payment', (r) => r.type === 'premature'),
      maturity: sumBy(delRows, 'net_payment', (r) => r.type === 'maturity'),
      rows: delRows,
    },
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

export type SegmentBy = 'series' | 'customer' | 'district' | 'agent' | 'staff' | 'branch' | 'lockerhub' | 'dhanamfin';

export interface SegmentChild {
  application_no: string;
  customer_id: number;
  customer: string;
  customer_code: string;
  series_code: string;
  amount: number;       // legacy: live outstanding (active) or original (exited)
  outstanding: number;  // current live outstanding — 0 once exited
  redeemed: number;     // amount redeemed/exited — 0 while live
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
  // Series-register extras (populated for the series view only): the collection
  // window (min/max money-received), gross issued, and redeemed to date.
  window_from?: string | null;
  window_to?: string | null;
  issued?: number;
  redeemed?: number;
  children: SegmentChild[];
}

/**
 * Grouped view for the Segments explorer: one summary row per dimension value,
 * each carrying its individual NCD investments as `children` (so the UI can
 * expand a group to show every deposit under it). Same scope + filters as the
 * flat segment functions. Fetches once, groups in JS.
 */
export async function segmentGrouped(db: Db, actor: AuthUser, by: SegmentBy, filters: BookFilters = {}): Promise<SegmentGroup[]> {
  // Series/branch/channel views group series-code / branch / (channel→series).
  const seriesLike = by === 'series' || by === 'lockerhub' || by === 'dhanamfin';
  // Show REAL investments so the expansion lists redeemed customers too: the
  // exact OUTSTANDING set (so summary columns are unchanged) PLUS the exited
  // statuses (children only). Reusing OUTSTANDING_SQL_LIST keeps the outstanding
  // rows byte-identical to every other book query — never hardcode the set.
  // Funding-channel split — MUST reconcile with the Dashboard channel tiles
  // (the owner's source of truth), so the two screens never disagree:
  //  • Locker Hub    = locker deposits (is_locker_deposit) — the Dashboard
  //    "Locker Deposits" tile.
  //  • Dhanamfin App = app-sourced NCDs (dhanamfin/lockerhub), locker deposits
  //    excluded so an investment lands in exactly one channel — the Dashboard
  //    "DhanamFin App" tile.
  // The same channel filter is applied to the issued/redeemed register below so
  // its numbers are channel-specific too (Issued = Outstanding + Redeemed).
  const channelExtra: string[] = [];
  if (by === 'lockerhub') channelExtra.push('a.is_locker_deposit = TRUE');
  if (by === 'dhanamfin') channelExtra.push("(a.source IN ('dhanamfin','lockerhub') AND a.is_locker_deposit = FALSE)");
  // Show REAL investments so the expansion lists redeemed customers too: the
  // exact OUTSTANDING set (so summary columns are unchanged) PLUS the exited
  // statuses (children only). Reusing OUTSTANDING_SQL_LIST keeps the outstanding
  // rows byte-identical to every other book query — never hardcode the set.
  const extra: string[] = [`a.status IN (${OUTSTANDING_SQL_LIST}, ${EXITED_STATUS_SQL_LIST})`, ...channelExtra];
  const w = appWhere(actor, { ...filters, status: undefined }, extra);
  const { rows } = await db.query<any>(
    `SELECT a.application_no, ${AMT} AS amount, a.status, a.allotment_date,
            c.id AS customer_id, c.customer_code, c.full_name AS customer, COALESCE(c.district,'Unassigned') AS district,
            COALESCE(b.name,'Unassigned') AS branch,
            s.code AS series_code, s.status AS series_status,
            sref.full_name AS staff_ref, ${REFERRER} AS referrer
     ${FROM_ATTR}
     LEFT JOIN branches b ON b.id = c.branch_id
     WHERE ${w.sql}`, w.params);

  const outstandingStatus = new Set<string>(OUTSTANDING_APPLICATION_STATUSES);
  const groups = new Map<string, SegmentGroup>();
  const custSets = new Map<string, Set<string>>();
  // Attribution: referrer matched to a staff user → Staff-wise; else Agent-wise.
  const keyOf = (r: any): string =>
    seriesLike ? r.series_code : by === 'customer' ? r.customer_code : by === 'district' ? r.district
    : by === 'branch' ? r.branch
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
        sublabel: by === 'customer' ? r.customer_code : seriesLike ? r.series_status : null,
        district: by === 'customer' ? r.district : null,
        sourced_by: by === 'customer' ? (r.staff_ref ?? r.referrer ?? '—') : null,
        investors: 0, investments: 0, outstanding: 0, children: [],
      };
      groups.set(key, g);
      custSets.set(key, new Set());
    }
    if (outstandingStatus.has(r.status)) {          // summary counts live money only
      g.investments += 1;
      g.outstanding = round2(g.outstanding + Number(r.amount));
      custSets.get(key)!.add(r.customer_code);
    }
    // A child is either outstanding (live money) or exited (redeemed). AMT is the
    // live outstanding for active apps and the original amount for exited ones,
    // so split it into the two columns by status.
    const live = outstandingStatus.has(r.status);
    const amt = round2(Number(r.amount));
    g.children.push({
      application_no: r.application_no, customer_id: Number(r.customer_id), customer: r.customer, customer_code: r.customer_code,
      series_code: r.series_code, amount: amt,
      outstanding: live ? amt : 0, redeemed: live ? 0 : amt,
      status: r.status, allotment_date: toISODate(r.allotment_date ?? null),
    });
  }
  for (const [key, g] of groups) g.investors = custSets.get(key)!.size;

  // Series register: window (collection dates), gross issued and redeemed —
  // including exited statuses (Redeemed/Matured/…) so the register shows what
  // the series raised over its life, not just what is still outstanding.
  // PendingApproval is excluded: an unapproved subscription has no money in yet
  // (same rule as OUTSTANDING_APPLICATION_STATUSES), so it must not inflate
  // "issued" — since the go-live change that is where every new investment
  // waits, and it was making NCD_28 read ₹15L against ₹10L outstanding.
  if (seriesLike) {
    // Channel views (Locker Hub / Dhanamfin App) apply the SAME channel filter
    // so their Issued/Redeemed are channel-specific and reconcile with the tab's
    // Outstanding (Issued = Outstanding + Redeemed).
    const reg = appWhere(actor, { seriesIds: filters.seriesIds }, channelExtra);
    const { rows: regRows } = await db.query<any>(
      `SELECT s.code AS series_code,
              min(a.date_money_received) AS win_from, max(a.date_money_received) AS win_to,
              COALESCE(sum(a.total_amount) FILTER (WHERE a.status NOT IN ('Rejected','Cancelled','Draft','PendingApproval')),0) AS issued,
              COALESCE(sum(a.total_amount) FILTER (WHERE a.status IN ('Redeemed','Matured','PrematureWithdrawn','RolledOver','Transferred')),0) AS redeemed
       ${FROM} WHERE ${reg.sql} GROUP BY s.code`, reg.params);
    const regMap = new Map<string, any>(regRows.map((r: any) => [r.series_code, r]));
    for (const g of groups.values()) {
      const rr = regMap.get(g.key);
      // The driver hands back a JS Date for these aggregates, and
      // String(date).slice(0,10) yields "Sat Jul 18" — which the UI then parses
      // as Invalid Date. toISODate normalises Date | string → 'YYYY-MM-DD'.
      g.window_from = toISODate(rr?.win_from ?? null);
      g.window_to = toISODate(rr?.win_to ?? null);
      g.issued = round2(Number(rr?.issued ?? 0));
      g.redeemed = round2(Number(rr?.redeemed ?? 0));
    }
  }

  // Series/channel views list newest series first (NCD_28, 27, 26…); others by amount.
  const out = [...groups.values()].sort((a, b) =>
    seriesLike
      ? String(b.key).localeCompare(String(a.key), undefined, { numeric: true, sensitivity: 'base' })
      : b.outstanding - a.outstanding);
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
     WHERE r.status IN ('Approved','Paid') AND ${w.sql}${dateCond}
     ORDER BY r.redemption_date`, params);
  return rows;
}

/**
 * The active window of the given series: from the earliest open date to the
 * latest allotment date (or today, for a series not yet allotted). Open date
 * falls back to deemed_date then created_at for legacy series with no
 * opened_at. Returns null when no start date can be resolved.
 */
export async function seriesActiveWindow(db: Db, seriesIds: number[]): Promise<{ from: string; to: string } | null> {
  if (!seriesIds?.length) return null;
  // to_char forces a clean 'YYYY-MM-DD' TEXT result so it survives the driver's
  // date parsing: node-pg (prod) returns a DATE column as a JS Date, PGlite as a
  // string. The value is re-used as a date PARAMETER below, so a JS Date coerced
  // via String() ('Wed Jun 01 2026 …') would blow up real Postgres.
  const { rows } = await db.query<{ win_from: string | null; win_to: string | null }>(
    `SELECT to_char(min(COALESCE(opened_at::date, deemed_date, created_at::date)), 'YYYY-MM-DD') AS win_from,
            to_char(max(COALESCE(allotted_at::date, CURRENT_DATE)), 'YYYY-MM-DD') AS win_to
       FROM series WHERE id = ANY($1)`, [seriesIds]);
  const r = rows[0];
  if (!r?.win_from) return null;
  return { from: r.win_from, to: r.win_to ?? new Date().toISOString().slice(0, 10) };
}

/** Redemptions that BELONG to the selected series (by ownership), regardless of
 * when they were redeemed — the counterpart to the date-window view above. */
export async function redemptionsOfSeries(db: Db, actor: AuthUser, seriesIds: number[]) {
  if (!seriesIds?.length) return [];
  const w = appWhere(actor, { seriesIds });
  const { rows } = await db.query(
    `SELECT r.redemption_date, r.type, s.code AS series_code, c.full_name AS customer_name, r.net_payment
     FROM redemptions r JOIN applications a ON a.id = r.application_id
     JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE r.status IN ('Approved','Paid') AND ${w.sql}
     ORDER BY r.redemption_date`, w.params);
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

/** Money-in for the window split by attribution: referrer matched to a staff
 * user → staff; everything else (agents, Direct) → agent. staff+agent = total. */
export async function moneyInBySource(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: 'active' });
  const { rows } = await db.query<{ staff: string; agent: string }>(
    `SELECT COALESCE(sum(a.total_amount) FILTER (WHERE sref.full_name IS NOT NULL),0) AS staff,
            COALESCE(sum(a.total_amount) FILTER (WHERE sref.full_name IS NULL),0) AS agent
     ${FROM_ATTR} WHERE ${w.sql} AND a.date_money_received IS NOT NULL`, w.params);
  const r = rows[0]!;
  return { staff: round2(Number(r.staff)), agent: round2(Number(r.agent)) };
}

/** New-investment list for the window; optional channel = 'locker' | 'app'. */
export async function newInvestmentsList(db: Db, actor: AuthUser, filters: BookFilters = {}, channel?: 'locker' | 'app') {
  const extra = ['a.date_money_received IS NOT NULL'];
  if (channel === 'locker') extra.push('a.is_locker_deposit');
  if (channel === 'app') extra.push(`a.source IN ('dhanamfin','lockerhub')`);
  const w = appWhere(actor, { ...filters, status: 'active' }, extra);
  const { rows } = await db.query(
    `SELECT a.application_no, c.full_name AS customer, c.customer_code, s.code AS series_code,
            COALESCE(b.name,'—') AS branch,
            a.total_amount AS amount, a.date_money_received, a.is_locker_deposit, a.source, a.status
     ${FROM} LEFT JOIN branches b ON b.id = c.branch_id
     WHERE ${w.sql} ORDER BY a.date_money_received DESC, a.application_no`, w.params);
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
     ${FROM_ATTR}
     WHERE ${w.sql} GROUP BY COALESCE(${REFERRER},'Direct'), c.full_name ORDER BY agent, customer`, w.params);
  return rows;
}

export async function masterClient(db: Db, actor: AuthUser) {
  const w = appWhere(actor, {});
  const { rows } = await db.query(
    `SELECT DISTINCT c.pan, c.customer_code, COALESCE(${REFERRER}, '—') AS agent_code,
            c.full_name AS name, c.phone, c.district, c.address
     ${FROM_ATTR}
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
