/**
 * Daily book summary — emailed each evening (docs/00 §12). Ported from the
 * wealth app's daily-book-summary.js, mapped to ncd's schema, then reshaped
 * (owner 2026-08-01) into a structured report the HTML template renders:
 *   · total outstanding + a real day-over-day net change (via a daily snapshot);
 *   · today's new investments (physical vs LockerHub-funded) and who brought
 *     each rupee in (staff / agent attribution);
 *   · today's redemptions, both in total and per series;
 *   · a per-series outstanding split, newest series first.
 *
 * The "outstanding book" here uses OUTSTANDING_APPLICATION_STATUSES — the same
 * canonical rule the dashboard uses, which EXCLUDES PendingApproval (unfunded /
 * unapproved money must not inflate the book). Recipients are settings-driven
 * (reports.book_summary_recipients), falling back to the management roles.
 * Per-(date, recipient) idempotent via notifications_queue.
 */
import type { Db } from '../db/types.js';
import { enqueue } from '../modules/notifications/service.js';
import { getSettingsMap } from '../modules/settings/service.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

const FALLBACK_ROLES = ['super_admin', 'admin', 'cxo', 'ncd_manager'];
const BOOK = [...OUTSTANDING_APPLICATION_STATUSES]; // funded/approved live money; excludes PendingApproval + Draft

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const numOf = (code: string) => parseInt(String(code).replace(/[^0-9]/g, ''), 10) || 0;

export interface SeriesLine {
  code: string;
  name: string;
  apps: number;
  outstanding: number;
  redeemed_count: number;
  redeemed_amount: number;
}
export interface BroughtInLine {
  name: string;
  kind: 'staff' | 'agent' | 'unattributed';
  count: number;
  amount: number;
}
export interface BookSummaryReport {
  report_date: string;
  total_outstanding: number;
  prev_outstanding: number | null;
  net_change: number | null;
  active_apps: number;
  physical: { count: number; amount: number };
  funded: { count: number; amount: number };
  redemptions: { count: number; amount: number };
  brought_in: BroughtInLine[];
  by_series: SeriesLine[];
}

export async function computeBookSummary(db: Db, reportDate?: string): Promise<BookSummaryReport> {
  const date = reportDate || ymd(ist(new Date()));

  const outstanding = (await db.query<{ total: string; apps: number }>(
    `SELECT COALESCE(SUM(al.outstanding_amount),0) AS total, COUNT(DISTINCT al.application_id)::int AS apps
       FROM application_lines al JOIN applications a ON a.id = al.application_id
      WHERE a.status = ANY($1::text[]) AND a.date_money_received IS NOT NULL AND COALESCE(al.outstanding_amount,0) > 0`,
    [BOOK])).rows[0]!;

  // "Invested today" counts only investments actually ON THE BOOK (same rule as
  // the outstanding figure) — a PendingApproval subscription is not a new
  // investment until it is approved, so it must not appear here or in "brought
  // in today". Otherwise the email disagrees with the book and the dashboard.
  const physical = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS amt FROM applications
      WHERE date_money_received = $1::date AND lockerhub_intent_no IS NULL AND status = ANY($2::text[])`,
    [date, BOOK])).rows[0]!;
  const funded = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0) AS amt FROM applications
      WHERE date_money_received = $1::date AND lockerhub_intent_no IS NOT NULL AND status = ANY($2::text[])`,
    [date, BOOK])).rows[0]!;

  const redemptions = (await db.query<{ n: number; amt: string }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(net_payment),0) AS amt FROM redemptions
      WHERE created_at::date = $1::date`, [date])).rows[0] ?? { n: 0, amt: '0' };

  // Per-series outstanding (book statuses only).
  const seriesRows = (await db.query<{ code: string; name: string; apps: number; outstanding: string }>(
    `SELECT sr.code, sr.name, COUNT(DISTINCT a.id)::int AS apps, COALESCE(SUM(al.outstanding_amount),0) AS outstanding
       FROM series sr JOIN applications a ON a.series_id = sr.id AND a.status = ANY($1::text[])
       JOIN application_lines al ON al.application_id = a.id
      WHERE a.date_money_received IS NOT NULL
      GROUP BY sr.id, sr.code, sr.name HAVING COALESCE(SUM(al.outstanding_amount),0) > 0`, [BOOK])).rows;

  // Per-series redemptions on the report date (drives the red rows).
  const redBySeries = (await db.query<{ code: string; n: number; amt: string }>(
    `SELECT sr.code, COUNT(*)::int AS n, COALESCE(SUM(r.net_payment),0) AS amt
       FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN series sr ON sr.id = a.series_id
      WHERE r.created_at::date = $1::date GROUP BY sr.code`, [date])).rows;
  const redMap = new Map(redBySeries.map((r) => [r.code, { n: r.n, amt: Number(r.amt) }]));

  const by_series: SeriesLine[] = seriesRows
    .map((s) => {
      const rd = redMap.get(s.code);
      return {
        code: s.code,
        name: s.name,
        apps: s.apps,
        outstanding: Number(s.outstanding),
        redeemed_count: rd?.n ?? 0,
        redeemed_amount: rd?.amt ?? 0,
      };
    })
    .sort((a, b) => numOf(b.code) - numOf(a.code)); // newest series first (28, 27, 26 …)

  // Who brought in today's money (staff / agent), unattributed rolled up.
  const broughtRows = (await db.query<{ staff_name: string | null; agent_name: string | null; n: number; amt: string }>(
    `SELECT u.full_name AS staff_name, ag.full_name AS agent_name, COUNT(*)::int AS n, COALESCE(SUM(a.total_amount),0) AS amt
       FROM applications a
       LEFT JOIN users u   ON u.id  = a.enrolled_by_user_id
       LEFT JOIN agents ag ON ag.id = a.enrolled_by_agent_id
      WHERE a.date_money_received = $1::date AND a.status = ANY($2::text[])
      GROUP BY u.full_name, ag.full_name`, [date, BOOK])).rows;
  const broughtMap = new Map<string, BroughtInLine>();
  for (const r of broughtRows) {
    const kind: BroughtInLine['kind'] = r.staff_name ? 'staff' : r.agent_name ? 'agent' : 'unattributed';
    const name = r.staff_name || r.agent_name || '(unattributed)';
    const key = `${kind}:${name}`;
    const e = broughtMap.get(key) ?? { name, kind, count: 0, amount: 0 };
    e.count += r.n;
    e.amount += Number(r.amt);
    broughtMap.set(key, e);
  }
  const brought_in = [...broughtMap.values()].sort((a, b) => b.amount - a.amount);

  // Previous outstanding = most recent snapshot strictly before this date.
  const prevRow = (await db.query<{ total_outstanding: string }>(
    `SELECT total_outstanding FROM book_summary_snapshots WHERE report_date < $1::date ORDER BY report_date DESC LIMIT 1`,
    [date])).rows[0];
  const prev_outstanding = prevRow ? Number(prevRow.total_outstanding) : null;
  const total_outstanding = Number(outstanding.total);
  const net_change = prev_outstanding == null ? null : total_outstanding - prev_outstanding;

  return {
    report_date: date,
    total_outstanding,
    prev_outstanding,
    net_change,
    active_apps: outstanding.apps,
    physical: { count: physical.n, amount: Number(physical.amt) },
    funded: { count: funded.n, amount: Number(funded.amt) },
    redemptions: { count: redemptions.n, amount: Number(redemptions.amt) },
    brought_in,
    by_series,
  };
}

/** Settings-driven recipient list, falling back to the management roles. */
async function bookSummaryRecipients(db: Db): Promise<string[]> {
  const settings = await getSettingsMap(db);
  const configured = settings['reports.book_summary_recipients'];
  if (Array.isArray(configured) && configured.length) {
    return configured.map((e) => String(e).trim()).filter(Boolean);
  }
  const { rows } = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name = ANY($1::text[])`,
    [FALLBACK_ROLES]);
  return rows.map((r) => r.email);
}

/** Run + queue the summary email (per-day idempotent), then snapshot today. */
export async function runBookSummary(db: Db, reportDate?: string): Promise<{ report_date: string; emails_queued: number }> {
  const report = await computeBookSummary(db, reportDate);
  const recipients = await bookSummaryRecipients(db);

  let queued = 0;
  for (const email of recipients) {
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue WHERE template='book_summary' AND to_address=$1 AND payload->>'report_date'=$2`,
      [email, report.report_date]);
    if (dup.rowCount) continue;
    await enqueue(db, {
      channel: 'email',
      template: 'book_summary',
      to: email,
      payload: report as unknown as Record<string, unknown>,
    });
    queued++;
  }

  // Snapshot today's outstanding so tomorrow can show a real day-over-day delta.
  await db.query(
    `INSERT INTO book_summary_snapshots (report_date, total_outstanding, active_apps, updated_at)
     VALUES ($1::date, $2, $3, now())
     ON CONFLICT (report_date) DO UPDATE SET total_outstanding = $2, active_apps = $3, updated_at = now()`,
    [report.report_date, report.total_outstanding, report.active_apps]);

  return { report_date: report.report_date, emails_queued: queued };
}
