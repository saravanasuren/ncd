/**
 * Daily backup check — ported from the wealth app's daily-backup-check.js.
 * Pure reads: stats the local dump dir, asks Graph for the newest offsite
 * copy, and computes the Azure-secret renewal reminder; then queues ONE
 * email per admin recipient per day (idempotent via notifications_queue).
 *
 * UPDATE SHAREPOINT_SECRET_EXPIRES whenever the secret is rotated in Azure.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db/types.js';
import { enqueue } from '../modules/notifications/service.js';
import { isConfigured, newestInFolder } from './sharepoint.js';

const SHAREPOINT_SECRET_EXPIRES = '2028-07-09';
const SECRET_WARN_WITHIN_DAYS = 45;
const MAX_AGE_HOURS = 30;
const RECIPIENT_ROLES = ['super_admin', 'admin'];

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmtBytes = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' KB' : `${n} B`;

export function inspectBackup(nowMs = Date.now()): { ok: boolean; note: string; newest?: { name: string; size: number; ageHours: number } } {
  const dir = config.BACKUP_DIR;
  if (!existsSync(dir)) return { ok: false, note: `Backup dir ${dir} does not exist.` };
  const newest = readdirSync(dir).filter((f) => f.endsWith('.sql.gz')).sort().reverse()[0];
  if (!newest) return { ok: false, note: `No dumps in ${dir}.` };
  const st = statSync(join(dir, newest));
  const ageHours = (nowMs - st.mtimeMs) / 3600000;
  const ok = ageHours <= MAX_AGE_HOURS && st.size > 1024;
  return {
    ok,
    note: ok
      ? `Local dump OK: ${newest} (${fmtBytes(st.size)}, ${ageHours.toFixed(1)}h old).`
      : `⚠ Local dump STALE or tiny: ${newest} (${fmtBytes(st.size)}, ${ageHours.toFixed(1)}h old, max ${MAX_AGE_HOURS}h).`,
    newest: { name: newest, size: st.size, ageHours },
  };
}

export async function inspectOffsite(nowMs = Date.now()): Promise<{ ok: boolean; note: string }> {
  if (!isConfigured() || !config.SHAREPOINT_BACKUP_DRIVE_ID) {
    return { ok: false, note: 'Offsite copy not configured (SHAREPOINT_* absent in SSM).' };
  }
  try {
    const it = await newestInFolder(config.SHAREPOINT_BACKUP_DRIVE_ID, config.SHAREPOINT_BACKUP_FOLDER);
    if (!it) return { ok: false, note: `⚠ No files in SharePoint ${config.SHAREPOINT_BACKUP_FOLDER}/ yet.` };
    const ageHours = (nowMs - new Date(it.lastModified).getTime()) / 3600000;
    const ok = ageHours <= MAX_AGE_HOURS;
    return {
      ok,
      note: ok
        ? `Offsite OK: ${it.name} (${fmtBytes(it.size)}, ${ageHours.toFixed(1)}h old).`
        : `⚠ Offsite copy STALE: ${it.name} is ${ageHours.toFixed(1)}h old (max ${MAX_AGE_HOURS}h).`,
    };
  } catch (e) {
    return { ok: false, note: `⚠ Offsite check failed: ${(e as Error).message}` };
  }
}

export function inspectSecretExpiry(nowMs = Date.now()): { warn: boolean; note: string } {
  const exp = new Date(SHAREPOINT_SECRET_EXPIRES + 'T00:00:00Z').getTime();
  const days = Math.floor((exp - nowMs) / 86400000);
  if (days < 0) {
    return { warn: true, note: `⚠ The Azure/SharePoint secret EXPIRED ${-days} day(s) ago (${SHAREPOINT_SECRET_EXPIRES}). The offsite copy is likely FAILING — renew in Azure and re-push SHAREPOINT_CLIENT_SECRET to SSM now.` };
  }
  if (days <= SECRET_WARN_WITHIN_DAYS) {
    return { warn: true, note: `⚠ The Azure/SharePoint secret expires in ${days} day(s) (${SHAREPOINT_SECRET_EXPIRES}). Renew it in Azure (Certificates & secrets → new secret) and re-push SHAREPOINT_CLIENT_SECRET to SSM before then.` };
  }
  return { warn: false, note: `Azure/SharePoint secret valid until ${SHAREPOINT_SECRET_EXPIRES}.` };
}

/** Run the daily check and queue the status email (idempotent per IST day). */
export async function runBackupCheck(db: Db, reportDate?: string): Promise<{ report_date: string; ok: boolean; emails_queued: number; local: string; offsite: string; secret: string }> {
  const reportIstDate = reportDate || ymd(ist(new Date()));
  const local = inspectBackup();
  const offsite = await inspectOffsite();
  const secret = inspectSecretExpiry();
  const ok = local.ok && offsite.ok && !secret.warn;

  const { rows: recipients } = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name = ANY($1::text[])`,
    [RECIPIENT_ROLES]
  );
  const payload = { report_date: reportIstDate, ok, local: local.note, offsite: offsite.note, secret: secret.note };
  let queued = 0;
  for (const r of recipients) {
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue WHERE template = 'backup_check' AND to_address = $1 AND payload->>'report_date' = $2`,
      [r.email, reportIstDate]
    );
    if (dup.rowCount) continue;
    await enqueue(db, { channel: 'email', template: 'backup_check', to: r.email, payload });
    queued++;
  }
  return { report_date: reportIstDate, ok, emails_queued: queued, local: local.note, offsite: offsite.note, secret: secret.note };
}
