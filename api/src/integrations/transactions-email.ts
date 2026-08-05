/**
 * Daily transaction-register email (owner 2026-08-05).
 *
 * "Mail that particular transaction tab report alone to the mail ids I give, on
 * a daily basis. Make it UI config." All three knobs live in Settings → Reports
 * and are super-admin editable:
 *
 *   reports.transactions_email_enabled     off by default
 *   reports.transactions_email_time        HH:MM IST, default 19:00
 *   reports.transactions_email_recipients  explicit list
 *
 * NO ROLE FALLBACK on the recipients, unlike the daily book summary. That one
 * degrades to the management roles when unset; this attachment is the entire
 * register — every customer, PAN, DOB and amount — so it goes only where it was
 * explicitly addressed. An empty list sends nothing.
 *
 * The whole register goes every day, not just the day's movements (owner's
 * call), so the file matches the workbook tab exactly. On a day with no
 * activity it still sends, with the body saying so — silence then means a
 * broken job rather than a quiet day.
 *
 * Per-IST-day idempotent: enqueueing checks for an existing row for the same
 * recipient and date, so a restart or a second tick cannot double-send.
 */
import type { Db } from '../db/types.js';
import { getSettingsMap } from '../modules/settings/service.js';
import { enqueue } from '../modules/notifications/service.js';
import { transactionRegister } from '../modules/reports/book.js';

/** Today in IST — the report is dated by the owner's day, not UTC's. */
export function istToday(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

const inr = (n: number) =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function recipientsOf(settings: Record<string, unknown>): string[] {
  const raw = settings['reports.transactions_email_recipients'];
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/);
  return list.map((x) => String(x).trim().toLowerCase()).filter((x) => x.includes('@'));
}

export interface TransactionsEmailResult {
  sent: number;
  skipped?: string;
  report_date?: string;
}

export async function runTransactionsEmail(db: Db, now = new Date()): Promise<TransactionsEmailResult> {
  const settings = await getSettingsMap(db);
  if (settings['reports.transactions_email_enabled'] !== true) return { sent: 0, skipped: 'disabled' };

  const recipients = recipientsOf(settings);
  // Explicitly addressed or not at all — see the note above.
  if (!recipients.length) return { sent: 0, skipped: 'no recipients configured' };

  const reportDate = istToday(now);
  const rows = await transactionRegister(db, { id: 0, role: 'super_admin', branchIds: [], agentId: null, customerId: null, permissions: [] } as never, {});
  const issued = rows.filter((r) => r.trans_type === 'Issue').reduce((s, r) => s + r.amount, 0);
  const redeemed = rows.filter((r) => r.trans_type === 'Redemption').reduce((s, r) => s + r.amount, 0);
  const todayRows = rows.filter((r) => r.txn_date === reportDate).length;

  const payload = {
    report_date: reportDate,
    rows: rows.length,
    issued: inr(issued),
    redeemed: `-${inr(redeemed)}`,
    net: inr(issued + redeemed),
    today_rows: todayRows,
    changed_today: todayRows > 0,
  };

  let sent = 0;
  for (const to of recipients) {
    // Per-day, per-recipient idempotence — a restart mid-loop must not re-send
    // to those already queued.
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue
        WHERE template = 'transactions_daily' AND to_address = $1 AND payload->>'report_date' = $2`,
      [to, reportDate]);
    if (dup.rowCount) continue;
    await enqueue(db, { channel: 'email', template: 'transactions_daily', to, payload });
    sent++;
  }
  return { sent, report_date: reportDate };
}
