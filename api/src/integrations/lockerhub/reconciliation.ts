/**
 * Daily LockerHub ↔ ncd reconciliation — ported from the old app's
 * lockerhub-reconciliation.js. Reads LockerHub's SQLite READ-ONLY (sibling
 * co-tenant on the same box; no writes, no restarts) and flags "orphans":
 * successful Easebuzz payment intents on LockerHub with no matching ncd
 * application (by lockerhub_intent_no). Queues a summary email to admin roles.
 *
 * DISABLED BY DEFAULT: the daily cron runs only when
 * LOCKERHUB_RECONCILIATION_ENABLED=true in SSM (cutover step). The manual
 * admin endpoint may invoke it regardless (explicit human action).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { config } from '../../config.js';
import type { Db } from '../../db/types.js';
import { enqueue } from '../../modules/notifications/service.js';

const exec = promisify(execFile);

// wealth_manager is a legacy role — dropped in the 8-role model (docs/03).
const RECIPIENT_ROLES = ['super_admin', 'admin', 'cxo', 'ncd_manager'];

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function querySqlite(sql: string): Promise<Record<string, unknown>[]> {
  const dbPath = config.LOCKERHUB_DB_PATH;
  if (!existsSync(dbPath)) throw new Error(`LockerHub SQLite not found at ${dbPath}`);
  const { stdout } = await exec('sqlite3', ['-readonly', '-json', dbPath, sql], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export interface ReconReport {
  report_date: string;
  lh_success_count: number;
  lh_total_amount: number;
  ncd_count: number;
  ncd_total_amount: number;
  orphan_count: number;
  orphan_total_amount: number;
  orphans: Record<string, unknown>[];
  emails_queued: number;
  lh_error: string | null;
}

/** Run for one IST day (default today, IST). Idempotent per (date, recipient). */
export async function runReconciliation(db: Db, reportDate?: string): Promise<ReconReport> {
  const reportIstDate = reportDate || ymd(ist(new Date()));
  const startUtc = new Date(reportIstDate + 'T00:00:00+05:30').toISOString();
  const endUtc = new Date(reportIstDate + 'T23:59:59.999+05:30').toISOString();

  let lhRows: Record<string, unknown>[] = [];
  let lhError: string | null = null;
  try {
    // Same window predicate as the old app (LockerHub stores naive local timestamps).
    lhRows = await querySqlite(
      `SELECT intent_no, easepayid, application_id, amount, settled_at, updated_at
         FROM payment_intents
        WHERE status = 'success'
          AND ((settled_at >= '${reportIstDate} 00:00:00' AND settled_at <= '${reportIstDate} 23:59:59')
            OR (updated_at >= '${reportIstDate} 00:00:00' AND updated_at <= '${reportIstDate} 23:59:59'))`
    );
  } catch (e) {
    lhError = (e as Error).message;
  }
  const lhTotal = lhRows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const { rows: ncdRows } = await db.query<{ lockerhub_intent_no: string; total_amount: string; status: string }>(
    `SELECT a.lockerhub_intent_no, a.total_amount, a.status
       FROM applications a
      WHERE a.lockerhub_intent_no IS NOT NULL
        AND a.created_at >= $1::timestamptz AND a.created_at <= $2::timestamptz`,
    [startUtc, endUtc]
  );
  const ncdTotal = ncdRows.reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
  const ncdIntents = new Set(ncdRows.map((r) => r.lockerhub_intent_no));
  const statusBreakdown = Object.entries(
    ncdRows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {})
  ).map(([k, v]) => `${k}=${v}`).join(', ') || '—';

  const orphans = lhRows.filter((r) => r.intent_no && !ncdIntents.has(String(r.intent_no)));
  const orphanTotal = orphans.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const { rows: recipients } = await db.query<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name = ANY($1::text[])`,
    [RECIPIENT_ROLES]
  );

  const payload = {
    report_date: reportIstDate,
    lh_success_count: lhRows.length,
    lh_total_amount: fmt(lhTotal),
    ncd_count: ncdRows.length,
    ncd_total_amount: fmt(ncdTotal),
    ncd_status_breakdown: statusBreakdown,
    orphan_count: orphans.length,
    orphan_total_amount: fmt(orphanTotal),
    orphan_details: orphans.length === 0
      ? 'No orphans — every successful LockerHub payment has a matching application.'
      : orphans.map((o) => `${o.intent_no ?? '—'}  Rs ${fmt(Number(o.amount ?? 0))}  (Easebuzz ${o.easepayid ?? '—'})`).join('\n'),
    lh_error: lhError ?? '',
  };

  let queued = 0;
  for (const r of recipients) {
    // Idempotent per (date, recipient): skip if today's report is already queued/sent.
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue
        WHERE template = 'lockerhub_daily_reconciliation' AND to_address = $1 AND payload->>'report_date' = $2`,
      [r.email, reportIstDate]
    );
    if (dup.rowCount) continue;
    await enqueue(db, { channel: 'email', template: 'lockerhub_daily_reconciliation', to: r.email, payload });
    queued++;
  }

  return {
    report_date: reportIstDate,
    lh_success_count: lhRows.length,
    lh_total_amount: lhTotal,
    ncd_count: ncdRows.length,
    ncd_total_amount: ncdTotal,
    orphan_count: orphans.length,
    orphan_total_amount: orphanTotal,
    orphans,
    emails_queued: queued,
    lh_error: lhError,
  };
}
