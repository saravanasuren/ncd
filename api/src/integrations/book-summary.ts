/**
 * Daily book summary — emailed each evening (docs/00 §12). Ported from the
 * wealth app's daily-book-summary.js, mapped to ncd's schema. Reports, for
 * the given IST day: total outstanding, today's new investments (physical vs
 * LockerHub-funded), today's redemptions, and a per-series outstanding split.
 * Per-(date, recipient) idempotent via notifications_queue.
 */
import type { Db } from '../db/types.js';
import { enqueue } from '../modules/notifications/service.js';

const RECIPIENT_ROLES = ['super_admin', 'admin', 'cxo', 'ncd_manager'];
const TERMINAL = ['Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function computeBookSummary(db: Db, reportDate?: string) {
  const date = reportDate || ymd(ist(new Date()));

  const outstanding = (await db.query<{ total: string; apps: number }>(
    `SELECT COALESCE(SUM(al.outstanding_amount),0) AS total, COUNT(DISTINCT al.application_id)::int AS apps
       FROM application_lines al JOIN applications a ON a.id = al.application_id
      WHERE a.status <> ALL($1::text[]) AND a.date_money_received IS NOT NULL AND COALESCE(al.outstanding_amount,0) > 0`,
    [TERMINAL])).rows[0]!;

  const physical = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS amt FROM applications
      WHERE date_money_received = $1::date AND lockerhub_intent_no IS NULL AND status <> ALL($2::text[])`,
    [date, ['Cancelled', 'Rejected']])).rows[0]!;
  const funded = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS amt FROM applications
      WHERE date_money_received = $1::date AND lockerhub_intent_no IS NOT NULL AND status <> ALL($2::text[])`,
    [date, ['Cancelled', 'Rejected']])).rows[0]!;

  const redemptions = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(net_payment),0) AS amt FROM redemptions
      WHERE created_at::date = $1::date`, [date])).rows[0] ?? { n: 0, amt: '0' };

  const bySeries = (await db.query<{ code: string; name: string; apps: number; outstanding: string }>(
    `SELECT sr.code, sr.name, COUNT(DISTINCT a.id)::int AS apps, COALESCE(SUM(al.outstanding_amount),0) AS outstanding
       FROM series sr JOIN applications a ON a.series_id = sr.id AND a.status <> ALL($1::text[])
       JOIN application_lines al ON al.application_id = a.id
      WHERE a.date_money_received IS NOT NULL
      GROUP BY sr.id, sr.code, sr.name HAVING COALESCE(SUM(al.outstanding_amount),0) > 0
      ORDER BY COALESCE(SUM(al.outstanding_amount),0) DESC`, [TERMINAL])).rows;

  return {
    report_date: date,
    total_outstanding: Number(outstanding.total),
    active_apps: outstanding.apps,
    physical: { count: physical.n, amount: Number(physical.amt) },
    funded: { count: funded.n, amount: Number(funded.amt) },
    redemptions: { count: redemptions.n, amount: Number(redemptions.amt) },
    by_series: bySeries.map((s) => ({ code: s.code, name: s.name, apps: s.apps, outstanding: Number(s.outstanding) })),
  };
}

/** Run + queue the summary email (per-day idempotent). */
export async function runBookSummary(db: Db, reportDate?: string): Promise<{ report_date: string; emails_queued: number }> {
  const d = await computeBookSummary(db, reportDate);
  const { rows: recipients } = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name = ANY($1::text[])`,
    [RECIPIENT_ROLES]);
  const payload = {
    report_date: d.report_date,
    total_outstanding: fmt(d.total_outstanding),
    active_apps: d.active_apps,
    physical: `${d.physical.count} · ₹${fmt(d.physical.amount)}`,
    funded: `${d.funded.count} · ₹${fmt(d.funded.amount)}`,
    redemptions: `${d.redemptions.count} · ₹${fmt(d.redemptions.amount)}`,
    by_series: d.by_series.length
      ? d.by_series.map((s) => `${s.code}: ${s.apps} apps · ₹${fmt(s.outstanding)}`).join('\n')
      : '—',
  };
  let queued = 0;
  for (const r of recipients) {
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue WHERE template='book_summary' AND to_address=$1 AND payload->>'report_date'=$2`, [r.email, d.report_date]);
    if (dup.rowCount) continue;
    await enqueue(db, { channel: 'email', template: 'book_summary', to: r.email, payload });
    queued++;
  }
  return { report_date: d.report_date, emails_queued: queued };
}
