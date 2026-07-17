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
  conds.push(...extra);
  return { sql: conds.join(' AND '), params };
}

const FROM = 'FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id';

export async function kpis(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const active = appWhere(actor, { ...filters, status: 'active' });
  const outstanding = await db.query<{ v: string; n: string; inv: string }>(
    `SELECT COALESCE(sum(a.total_amount),0) AS v, count(a.id)::int AS n, count(DISTINCT a.customer_id)::int AS inv ${FROM} WHERE ${active.sql}`, active.params);
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
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status IN (${OUTSTANDING_SQL_LIST})),0) AS outstanding,
            COALESCE(sum(a.total_amount) FILTER (WHERE a.status = 'Redeemed'),0) AS redeemed,
            COALESCE(sum(a.total_amount),0) AS issued
     ${FROM} WHERE ${w.sql} GROUP BY s.id, s.code, s.status ORDER BY s.code`, w.params);
  return rows;
}

export async function depositorwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT c.full_name AS name, COALESCE(sum(a.total_amount),0) AS amount
     ${FROM} WHERE ${w.sql} GROUP BY c.full_name ORDER BY c.full_name`, w.params);
  return rows;
}

export async function districtwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT COALESCE(c.district,'Unassigned') AS district, count(DISTINCT a.customer_id)::int AS investors,
            COALESCE(sum(a.total_amount),0) AS amount
     ${FROM} WHERE ${w.sql} GROUP BY COALESCE(c.district,'Unassigned') ORDER BY amount DESC`, w.params);
  return rows;
}

export async function agentwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT COALESCE(ag.full_name,'Direct') AS agent, c.full_name AS customer, COALESCE(sum(a.total_amount),0) AS amount
     ${FROM} LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id
     WHERE ${w.sql} GROUP BY COALESCE(ag.full_name,'Direct'), c.full_name ORDER BY agent, customer`, w.params);
  return rows;
}

export async function staffwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT COALESCE(u.full_name,'—') AS staff, c.full_name AS customer, COALESCE(sum(a.total_amount),0) AS amount
     ${FROM} LEFT JOIN users u ON u.id = a.enrolled_by_user_id
     WHERE ${w.sql} AND a.enrolled_by_agent_id IS NULL GROUP BY COALESCE(u.full_name,'—'), c.full_name ORDER BY staff, customer`, w.params);
  return rows;
}

export async function customerwise(db: Db, actor: AuthUser, filters: BookFilters = {}) {
  const w = appWhere(actor, { ...filters, status: filters.status ?? 'active' });
  const { rows } = await db.query(
    `SELECT c.customer_code, c.full_name AS customer, c.district,
            COALESCE(ag.full_name, u.full_name, '—') AS sourced_by,
            count(a.id)::int AS ncds, COALESCE(sum(a.total_amount),0) AS outstanding
     ${FROM} LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id LEFT JOIN users u ON u.id = a.enrolled_by_user_id
     WHERE ${w.sql} GROUP BY c.customer_code, c.full_name, c.district, COALESCE(ag.full_name, u.full_name, '—') ORDER BY customer`, w.params);
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
    `SELECT a.application_no, a.total_amount AS amount, a.status, a.allotment_date, a.enrolled_by_agent_id,
            c.customer_code, c.full_name AS customer, COALESCE(c.district,'Unassigned') AS district,
            s.code AS series_code, s.status AS series_status,
            COALESCE(ag.full_name,'Direct') AS agent, COALESCE(u.full_name,'—') AS staff,
            COALESCE(ag.full_name, u.full_name, '—') AS sourced_by
     ${FROM} LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id LEFT JOIN users u ON u.id = a.enrolled_by_user_id
     WHERE ${w.sql}`, w.params);

  const groups = new Map<string, SegmentGroup>();
  const custSets = new Map<string, Set<string>>();
  const keyOf = (r: any): string =>
    by === 'series' ? r.series_code : by === 'customer' ? r.customer_code : by === 'district' ? r.district : by === 'agent' ? r.agent : r.staff;

  for (const r of rows) {
    if (by === 'staff' && r.enrolled_by_agent_id != null) continue; // staff view = directly-enrolled only
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label: by === 'customer' ? r.customer : key,
        sublabel: by === 'customer' ? r.customer_code : by === 'series' ? r.series_status : null,
        district: by === 'customer' ? r.district : null,
        sourced_by: by === 'customer' ? r.sourced_by : null,
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

export async function ongoingSeriesPivot(db: Db, actor: AuthUser, seriesId: number) {
  // Ongoing NCD tab: agent → customer → amount for one series.
  const w = appWhere(actor, { seriesIds: [seriesId] });
  const { rows } = await db.query(
    `SELECT COALESCE(ag.full_name,'Direct') AS agent, c.full_name AS customer, COALESCE(sum(a.total_amount),0) AS amount
     ${FROM} LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id
     WHERE ${w.sql} GROUP BY COALESCE(ag.full_name,'Direct'), c.full_name ORDER BY agent, customer`, w.params);
  return rows;
}

export async function masterClient(db: Db, actor: AuthUser) {
  const w = appWhere(actor, {});
  const { rows } = await db.query(
    `SELECT DISTINCT c.pan, c.customer_code, COALESCE(ag.full_name, u.full_name, '—') AS agent_code,
            c.full_name AS name, c.phone, c.district, c.address
     ${FROM} LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id LEFT JOIN users u ON u.id = a.enrolled_by_user_id
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
