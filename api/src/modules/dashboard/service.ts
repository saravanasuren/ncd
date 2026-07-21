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
import * as incentives from '../incentives/service.js';

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

/** Who may VIEW the dashboard incentive tiles/drill — incentive managers plus
 * CXO (read-only; paying still needs incentives:pay on the Incentives page). */
function canViewIncentives(actor: AuthUser): boolean {
  return actor.permissions.includes('incentives:manage-eligibility') || actor.role === 'cxo';
}

export async function overview(db: Db, actor: AuthUser, filters: book.BookFilters = {}) {
  const today = todayISO();
  const asOf = today; // accrual is always "as of now" (till date), never the future range end
  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
  const anchor = payoutAnchor(asOf, payoutDay);
  const seriesFilter: book.BookFilters = { seriesIds: filters.seriesIds };
  // Accrued interest only makes sense for the current/ongoing period. A range that
  // ends in the past (last month, a closed quarter, last FY) shows zero — that
  // interest was already paid, not "accruing".
  const isCurrentPeriod = !filters.to || filters.to >= today;
  const showIncentives = canViewIncentives(actor);

  // Redemptions, when a series is selected, split into two readings:
  //  - window: money redeemed DURING that series' active window (open → allotment,
  //    or → today for a still-open series). Ignores which series was redeemed.
  //  - ofSeries: redemptions that BELONG to the selected series (by ownership).
  // With no series selected there is one reading: redemptions in the date range.
  const seriesWindow = filters.seriesIds?.length ? await book.seriesActiveWindow(db, filters.seriesIds) : null;
  const redemptionFilters: book.BookFilters = seriesWindow
    ? { from: seriesWindow.from, to: seriesWindow.to }
    : { from: filters.from, to: filters.to };

  // Point-in-time interest snapshots (independent of the selected window):
  //  - accrued_total    : total interest payable AS ON today (since the last payout)
  //  - monthly_projected : gross run-rate monthly coupon cost of the outstanding book
  const [kpis, seriesRows, districts, moneyIn, moneyBySource, interest, accrued, redemptionRows, redemptionsOfSeriesRows, leadFunnel, almTiles, rateMix, todayBook, accruedTotal, monthlyInterest] = await Promise.all([
    book.kpis(db, actor, seriesFilter),                    // snapshot, but honours a selected series
    book.seriesSummary(db, actor, {}),                     // ALL series (pie + active/last-series pick)
    book.districtwise(db, actor, seriesFilter),            // snapshot (pie), honours a selected series
    book.moneyInByChannel(db, actor, filters),             // flow
    book.moneyInBySource(db, actor, filters),              // flow (staff vs agent tiles)
    book.interestInRange(db, actor, filters),              // flow (paid vs due)
    isCurrentPeriod ? book.interestAccrued(db, actor, seriesFilter, anchor, asOf) : Promise.resolve({ total: 0 }),
    book.redemptions(db, actor, redemptionFilters),        // flow — by date window (series → series-active window)
    book.redemptionsOfSeries(db, actor, filters.seriesIds ?? []), // flow — by ownership (only when a series is selected)
    book.leadFunnel(db, actor),                            // lead pipeline (snapshot)
    book.alm(db, actor, today),                            // ALM timing tiles (snapshot)
    book.rateMix(db, actor),                               // cost-of-funds rate mix (snapshot)
    book.todayBook(db, actor, today),                      // today's additions/deletions
    book.interestAccrued(db, actor, seriesFilter, anchor, today),                                    // accrued payable as-on-date (always)
    book.monthlyInterestRunRate(db, actor, seriesFilter),                                            // run-rate gross monthly coupon of the whole outstanding book
  ]);
  // Incentive totals (Staff vs Agent) — management only.
  const incentiveTotals = showIncentives ? await incentives.incentiveTotals(db) : null;

  // Active series = the Open series (latest code); Last series = latest non-Open.
  const openSeries = seriesRows.filter((r: any) => r.status === 'Open').sort(byCodeDesc);
  const closedSeries = seriesRows.filter((r: any) => r.status !== 'Open').sort(byCodeDesc);
  const activeSeries = openSeries[0] ?? null;
  const lastSeries = closedSeries[0] ?? null;

  const redemptionsTotal = (redemptionRows as Array<{ net_payment: string }>).reduce((s, r) => s + Number(r.net_payment), 0);
  const redemptionsOfSeriesTotal = (redemptionsOfSeriesRows as Array<{ net_payment: string }>).reduce((s, r) => s + Number(r.net_payment), 0);

  return {
    range: { from: filters.from ?? null, to: filters.to ?? null, series: filters.seriesIds ?? null, anchor },
    active_series: activeSeries,
    last_series: lastSeries,
    kpis,                       // outstanding_book, active_investors, interest_paid, interest_scheduled
    flow: {
      money_in: moneyIn.total,
      money_in_locker: moneyIn.locker,
      money_in_app: moneyIn.app,
      money_in_staff: moneyBySource.staff,
      money_in_agent: moneyBySource.agent,
      new_investments: moneyIn.count,
      interest_paid: interest.paid,        // interest actually paid in the window (0 for the current MTD)
      interest_due: interest.total,        // paid + still-scheduled, for reference
      interest_accrued: accrued.total,     // current period only; 0 for past ranges
      redemptions_total: Math.round(redemptionsTotal * 100) / 100,
      redemptions_count: redemptionRows.length,
      // Only meaningful when a series is selected (else null → tile hidden).
      redemptions_window: seriesWindow,                    // { from, to } | null — the series-active window used above
      redemptions_of_series_total: seriesWindow ? Math.round(redemptionsOfSeriesTotal * 100) / 100 : null,
      redemptions_of_series_count: seriesWindow ? redemptionsOfSeriesRows.length : null,
    },
    interest_snapshot: {
      accrued_total: accruedTotal.total,           // total interest payable as on date
      monthly_projected: monthlyInterest.gross_monthly, // gross run-rate monthly coupon cost of the outstanding book
    },
    series: seriesRows,
    districts,
    lead_funnel: leadFunnel,      // [{ status, count, expected }]
    alm: almTiles,                // { net_due_this_month, overdue, paid_fy, fy_label }
    rate_mix: rateMix,            // { mix:[{rate,outstanding,investments}], weighted_avg_rate, total_outstanding }
    today_book: todayBook,        // { additions:{count,amount,app,locker,physical,rows[]}, deletions:{count,amount,premature,maturity,rows[]} }
    incentives: incentiveTotals,  // { staff:{earned,paid,pending}, agent:{...} } | null (management only)
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
    case 'outstanding':            // snapshot: WHOLE book by series
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'series', {}) };
    case 'series':                 // snapshot by series, narrowed to a selected series when one is passed
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'series', { seriesIds: filters.seriesIds }) };
    case 'district':               // snapshot by district, honours a selected series
      return { kind: 'groups', groups: await book.segmentGrouped(db, actor, 'district', seriesFilter) };
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
    case 'interest-paid':
      return { kind: 'rows', rows: await book.interestListInRange(db, actor, filters, true) };
    case 'interest-month': {
      // "Monthly interest" tile = this calendar month's interest (projected), not the selected window.
      const today = todayISO();
      const monthStart = `${today.slice(0, 7)}-01`;
      const d = new Date(`${today}T00:00:00Z`);
      const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      return { kind: 'rows', rows: await book.interestListInRange(db, actor, { seriesIds: filters.seriesIds, from: monthStart, to: monthEnd }) };
    }
    case 'interest-accrued': {
      // "Accrued interest" tile = total payable as on today (always), scoped to any selected series.
      const today = todayISO();
      const settings = await getSettingsMap(db);
      const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
      return { kind: 'rows', rows: await book.accruedList(db, actor, seriesFilter, payoutAnchor(today, payoutDay), today) };
    }
    case 'redemptions': {
      // Match the tile: with a series selected, list what was redeemed during
      // that series' active window (open → allotment/today); else the date range.
      const win = filters.seriesIds?.length ? await book.seriesActiveWindow(db, filters.seriesIds) : null;
      const rf: book.BookFilters = win ? { from: win.from, to: win.to } : { from: filters.from, to: filters.to };
      return { kind: 'rows', rows: await book.redemptions(db, actor, rf) };
    }
    case 'redemptions-of-series':
      return { kind: 'rows', rows: await book.redemptionsOfSeries(db, actor, filters.seriesIds ?? []) };
    case 'staff-incentive':
    case 'agent-incentive': {
      if (!canViewIncentives(actor)) return { kind: 'incentive', groups: [], totals: { earned: 0, paid: 0, pending: 0 } };
      const which = widget === 'staff-incentive' ? 'staff' : 'agent';
      return { kind: 'incentive', ...(await incentives.dashboardIncentives(db, which)) };
    }
    case 'rate-mix': {
      // Cost-of-funds breakdown: outstanding book by coupon rate, with the
      // active-customer count per rate.
      const rm = await book.rateMix(db, actor);
      return {
        kind: 'rows',
        rows: rm.mix.map((m: any) => ({ rate: m.rate, outstanding: m.outstanding, customers: m.customers })),
        // True distinct customer total (not the sum of per-rate counts).
        foot_totals: { customers: rm.total_customers },
      };
    }
    // legacy monthly-redemption drill (kept for back-compat)
    case 'redemptions-month': {
      const { scopeFor, scopeWhere } = await import('../../lib/scope.js');
      const sc = scopeWhere(scopeFor(actor), { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id' }, 1);
      return { kind: 'rows', rows: (await db.query(
        `SELECT c.full_name AS customer, s.code AS series, r.type, r.net_payment, r.redemption_date
         FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
         WHERE r.status IN ('Approved','Paid') AND to_char(r.redemption_date,'YYYY-MM') = $1 AND ${sc.sql} ORDER BY r.redemption_date`, [param, ...sc.params])).rows };
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
