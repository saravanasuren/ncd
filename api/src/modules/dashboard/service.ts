/** Dashboard read model (docs/06 §2). Delegates to the shared book queries
 * so the dashboard and the export never disagree. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import * as book from '../reports/book.js';

export async function overview(db: Db, actor: AuthUser, filters: book.BookFilters = {}) {
  const [kpis, series, districts] = await Promise.all([
    book.kpis(db, actor, filters),
    book.seriesSummary(db, actor, filters),
    book.districtwise(db, actor, filters),
  ]);
  return { kpis, series, districts };
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
