/** Dashboard read model (docs/06 §2). Delegates to the shared book queries
 * so the dashboard and the export never disagree. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';
import * as book from '../reports/book.js';

/** SQL list literal for the outstanding-book status set — matches reports/book.ts. */
const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');

export async function overview(db: Db, actor: AuthUser, filters: book.BookFilters = {}) {
  const [kpis, series, districts] = await Promise.all([
    book.kpis(db, actor, filters),
    book.seriesSummary(db, actor, filters),
    book.districtwise(db, actor, filters),
  ]);
  return { kpis, series, districts };
}

/** Universal search — customers (scoped) + agents + staff (docs/05 §2). */
export async function search(db: Db, actor: AuthUser, q: string) {
  if (!q || q.trim().length < 2) return { customers: [], agents: [], staff: [] };
  const like = `%${q.trim()}%`;
  const { scopeFor, scopeWhere } = await import('../../lib/scope.js');
  const sc = scopeWhere(scopeFor(actor), { userCol: 'c.enrolled_by_user_id', agentCol: 'c.enrolled_by_agent_id', branchCol: 'c.branch_id', selfIdCol: 'c.id' }, 1);
  const customers = (await db.query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone FROM customers c
     WHERE (c.full_name ILIKE $1 OR c.customer_code ILIKE $1 OR c.phone ILIKE $1 OR c.pan ILIKE $1 OR c.email ILIKE $1) AND ${sc.sql}
     ORDER BY c.full_name LIMIT 12`, [like, ...sc.params])).rows;
  // Agents + staff only for management roles.
  let agents: unknown[] = [], staff: unknown[] = [];
  if (actor.permissions.includes('dashboard:drilldown')) {
    agents = (await db.query('SELECT id, agent_code, full_name FROM agents WHERE full_name ILIKE $1 OR agent_code ILIKE $1 ORDER BY full_name LIMIT 8', [like])).rows;
    staff = (await db.query("SELECT u.id, u.full_name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.full_name ILIKE $1 AND r.name <> 'customer' ORDER BY u.full_name LIMIT 8", [like])).rows;
  }
  return { customers, agents, staff };
}

/** Drill-down for a dashboard widget → the underlying rows (docs/06 §2). */
export async function drill(db: Db, actor: AuthUser, widget: string, param: string) {
  const { scopeFor, scopeWhere } = await import('../../lib/scope.js');
  const sc = scopeWhere(scopeFor(actor), { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id' }, 1);
  const FROM = 'FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id';
  if (widget === 'series') {
    return (await db.query(`SELECT c.full_name AS customer, a.application_no, a.total_amount ${FROM} WHERE a.series_id = $1 AND a.status IN (${OUTSTANDING_SQL_LIST}) AND ${sc.sql} ORDER BY c.full_name`, [Number(param), ...sc.params])).rows;
  }
  if (widget === 'district') {
    return (await db.query(`SELECT c.full_name AS customer, a.application_no, a.total_amount ${FROM} WHERE COALESCE(c.district,'Unassigned') = $1 AND a.status IN (${OUTSTANDING_SQL_LIST}) AND ${sc.sql} ORDER BY c.full_name`, [param, ...sc.params])).rows;
  }
  if (widget === 'redemptions-month') {
    return (await db.query(
      `SELECT c.full_name AS customer, s.code AS series, r.type, r.net_payment, r.redemption_date
       FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
       WHERE r.status = 'Approved' AND to_char(r.redemption_date,'YYYY-MM') = $1 AND ${sc.sql} ORDER BY r.redemption_date`, [param, ...sc.params])).rows;
  }
  return [];
}

export async function monthlyRedemptions(db: Db, actor: AuthUser) {
  const rows = await book.redemptions(db, actor, {});
  const byMonth = new Map<string, { month: string; total: number; rows: unknown[] }>();
  for (const r of rows as Array<{ redemption_date: string; net_payment: string }>) {
    const month = String(r.redemption_date).slice(0, 7);
    const g = byMonth.get(month) ?? { month, total: 0, rows: [] };
    g.total -= Number(r.net_payment); // money out is negative
    g.rows.push(r);
    byMonth.set(month, g);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}
