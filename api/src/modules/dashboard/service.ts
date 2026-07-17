/** Dashboard read model (docs/06 §2). Delegates to the shared book queries
 * so the dashboard and the export never disagree.
 *
 * Two families of tiles:
 *  - snapshot (Outstanding book, Active series, Active investors) — ignore the
 *    date window, always "as it stands now".
 *  - flow (new money by channel, interest, redemptions, staff/agent) — count
 *    only what falls inside the selected window (quick-range or custom dates).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import * as book from '../reports/book.js';
import { getSettingsMap } from '../settings/service.js';

/** Most recent payout-day anchor (28th by default) on/before `asOf`. Accrual runs
 * from here to `asOf`. Config-driven via settings.interest.payout_day_of_month. */
function payoutAnchor(asOf: string, payoutDay: number): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const anchor = day >= payoutDay ? new Date(Date.UTC(y, m, payoutDay)) : new Date(Date.UTC(y, m - 1, payoutDay));
  return anchor.toISOString().slice(0, 10);
}

/** Today as an ISO date (UTC). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function overview(db: Db, actor: AuthUser, filters: book.BookFilters = {}) {
  const asOf = filters.to || todayISO();
  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
  const anchor = payoutAnchor(asOf, payoutDay);
  const seriesFilter: book.BookFilters = { seriesIds: filters.seriesIds };

  const [kpis, seriesRows, districts, moneyIn, interest, accrued, redemptionRows] = await Promise.all([
    book.kpis(db, actor, {}),                              // snapshot
    book.seriesSummary(db, actor, {}),                     // snapshot (pie + active-series pick)
    book.districtwise(db, actor, {}),                      // snapshot (pie)
    book.moneyInByChannel(db, actor, filters),             // flow
    book.interestInRange(db, actor, filters),              // flow
    book.interestAccrued(db, actor, seriesFilter, anchor, asOf), // snapshot-ish (series filter only)
    book.redemptions(db, actor, filters),                  // flow
  ]);

  // Active series = the Open series (latest code); Last series = latest non-Open.
  const openSeries = seriesRows.filter((r: any) => r.status === 'Open').sort(byCodeDesc);
  const closedSeries = seriesRows.filter((r: any) => r.status !== 'Open').sort(byCodeDesc);
  const activeSeries = openSeries[0] ?? null;
  const lastSeries = closedSeries[0] ?? null;

  const redemptionsTotal = (redemptionRows as Array<{ net_payment: string }>).reduce((s, r) => s + Number(r.net_payment), 0);

  return {
    range: { from: filters.from ?? null, to: filters.to ?? null, series: filters.seriesIds ?? null, anchor },
    active_series: activeSeries,
    last_series: lastSeries,
    kpis,                       // outstanding_book, active_investors, interest_paid, interest_scheduled
    flow: {
      money_in: moneyIn.total,
      money_in_locker: moneyIn.locker,
      money_in_app: moneyIn.app,
      new_investments: moneyIn.count,
      interest_month: interest.total,
      interest_paid_month: interest.paid,
      interest_accrued: accrued.total,
      redemptions_total: Math.round(redemptionsTotal * 100) / 100,
      redemptions_count: redemptionRows.length,
    },
    series: seriesRows,
    districts,
  };
}

const byCodeDesc = (a: any, b: any) =>
  String(b.code).localeCompare(String(a.code), undefined, { numeric: true, sensitivity: 'base' });

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
  let agents: unknown[] = [], staff: unknown[] = [];
  if (actor.permissions.includes('dashboard:drilldown')) {
    agents = (await db.query('SELECT id, agent_code, full_name FROM agents WHERE full_name ILIKE $1 OR agent_code ILIKE $1 ORDER BY full_name LIMIT 8', [like])).rows;
    staff = (await db.query("SELECT u.id, u.full_name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.full_name ILIKE $1 AND r.name <> 'customer' ORDER BY u.full_name LIMIT 8", [like])).rows;
  }
  return { customers, agents, staff };
}

/**
 * Tile drill-down. Grouped widgets return { groups } (summary rows carrying
 * their investments as `children`, so the modal can expand each). Flat widgets
 * return { rows }. Everything honours the same scope + window as the tiles.
 */
export async function drill(db: Db, actor: AuthUser, widget: string, filters: book.BookFilters, param: string) {
  const seriesFilter: book.BookFilters = { seriesIds: filters.seriesIds };
  switch (widget) {
    // ── grouped (expandable) ──
    case 'outstanding':
    case 'series':                 // snapshot: whole book by series
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'series', {}) };
    case 'district':               // snapshot: whole book by district
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'district', {}) };
    case 'staff':                  // flow: new business in window by staff
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'staff', filters) };
    case 'agent':                  // flow: new business in window by agent
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'agent', filters) };

    // ── flat lists ──
    case 'new-investments':
      return { kind: 'rows', rows: await book.newInvestmentsList(db, actor, filters) };
    case 'locker':
      return { kind: 'rows', rows: await book.newInvestmentsList(db, actor, filters, 'locker') };
    case 'app':
      return { kind: 'rows', rows: await book.newInvestmentsList(db, actor, filters, 'app') };
    case 'interest-month':
      return { kind: 'rows', rows: await book.interestListInRange(db, actor, filters) };
    case 'interest-accrued': {
      const asOf = filters.to || todayISO();
      const settings = await getSettingsMap(db);
      const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
      return { kind: 'rows', rows: await book.accruedList(db, actor, seriesFilter, payoutAnchor(asOf, payoutDay), asOf) };
    }
    case 'redemptions':
      return { kind: 'rows', rows: await book.redemptions(db, actor, filters) };
    // legacy monthly-redemption drill (kept for back-compat)
    case 'redemptions-month': {
      const { scopeFor, scopeWhere } = await import('../../lib/scope.js');
      const sc = scopeWhere(scopeFor(actor), { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id' }, 1);
      return { kind: 'rows', rows: (await db.query(
        `SELECT c.full_name AS customer, s.code AS series, r.type, r.net_payment, r.redemption_date
         FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
         WHERE r.status = 'Approved' AND to_char(r.redemption_date,'YYYY-MM') = $1 AND ${sc.sql} ORDER BY r.redemption_date`, [param, ...sc.params])).rows };
    }
    default:
      return { kind: 'rows', rows: [] };
  }
}

export async function monthlyRedemptions(db: Db, actor: AuthUser) {
  const rows = await book.redemptions(db, actor, {});
  const byMonth = new Map<string, { month: string; total: number; rows: unknown[] }>();
  for (const r of rows as Array<{ redemption_date: string; net_payment: string }>) {
    const month = String(r.redemption_date).slice(0, 7);
    const g = byMonth.get(month) ?? { month, total: 0, rows: [] };
    g.total -= Number(r.net_payment);
    g.rows.push(r);
    byMonth.set(month, g);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}
