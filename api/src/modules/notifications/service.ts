/** Notification queue (docs/08 §5). Enqueue → cron drains → provider sends.
 * enqueue can run inside a caller's transaction.
 *
 * Delivery rules (rewritten 2026-07-28 after batch NEFT-2026-000131 reached
 * 92 of 367 customers):
 *   · sends are PACED — WappCloud 429s at roughly 90 back-to-back;
 *   · a temporary failure RETRIES with backoff instead of being abandoned;
 *   · a 429 stops the whole drain cycle, because the next message would hit
 *     the same closed door and burn another row's attempt for nothing.
 */
import type { Db } from '../../db/types.js';
import { renderTemplate } from './templates.js';
import { providerFor, type SendMeta } from '../../integrations/notify/index.js';
import { config } from '../../config.js';
import { attachmentFor } from './attachments.js';
import { getSettingsMap } from '../settings/service.js';
import { resolveWhatsapp } from './whatsappConfig.js';

export interface EnqueueInput {
  channel: 'email' | 'sms' | 'whatsapp';
  template: string;
  to: string;
  payload?: Record<string, unknown>;
  /** Who it is for — so a batch report can name people. Phone alone is
   *  ambiguous: families share a number. */
  customerId?: number;
  /** What it belongs to, e.g. ('payout_batch', 131). */
  ref?: { kind: string; id: number };
  /** The ONE investment this message is about. Absent only for messages that
   *  genuinely cover no single investment. */
  applicationId?: number;
}

/** Give up after this many temporary failures — roughly 2.5h of backoff. */
export const MAX_ATTEMPTS = 8;

/** Backoff before attempt n (1-based), capped: 1m, 2m, 4m, 8m … 30m. */
export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function enqueue(db: Db, input: EnqueueInput): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications_queue (channel, template, to_address, payload, customer_id, ref_kind, ref_id, application_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.channel, input.template, input.to, JSON.stringify(input.payload ?? {}),
     input.customerId ?? null, input.ref?.kind ?? null, input.ref?.id ?? null, input.applicationId ?? null]
  );
  return Number(rows[0]!.id);
}

/**
 * Drain up to `limit` due notifications, pacing between sends. Never throws.
 *
 * `stopped` is true when the provider rate-limited us and the rest of the
 * cycle was deliberately left alone — those rows stay Pending and the next
 * cron tick picks them up, so a big batch drains over several minutes rather
 * than dying in one burst.
 */
export async function drainOnce(db: Db, limit = 25): Promise<{ sent: number; failed: number; retrying: number; stopped: boolean }> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, channel, template, to_address, payload, attempts
       FROM notifications_queue
      WHERE status = 'Pending' AND next_attempt_at <= now()
      ORDER BY id LIMIT $1`,
    [limit]
  );
  let sent = 0, failed = 0, retrying = 0, stopped = false;
  const gap = Math.max(0, config.NOTIFY_SEND_GAP_MS);
  // WhatsApp template config (names, {{n}} mapping, on/off, test-phone) is
  // admin-editable in Settings — load it once for the whole cycle rather than
  // per row. Lazy so a purely-email drain never touches app_settings.
  let waSettings: Record<string, unknown> | null = null;
  const whatsappSettings = async () => (waSettings ??= await getSettingsMap(db));

  for (const [i, r] of rows.entries()) {
    const id = Number(r.id);
    const attempts = Number(r.attempts ?? 0) + 1;
    try {
      const payload = (r.payload as Record<string, unknown>) ?? {};
      const { subject, body, html } = renderTemplate(String(r.template), payload);
      // A file, if this template carries one — built now rather than stored on
      // the row, so a retry attaches the book as it stands at that moment.
      // Email only; the SMS/WhatsApp providers ignore it.
      const attachment = String(r.channel) === 'email'
        ? await attachmentFor(db, String(r.template), payload)
        : null;
      // WhatsApp: resolve the Settings-driven template + variables. A type turned
      // OFF in Settings is not sent — it fails with a clear reason (final, so no
      // retry) rather than reaching a customer. A known type with a resolved name
      // is handed to the provider via meta.wa.
      let wa: SendMeta['wa'] | undefined;
      if (String(r.channel) === 'whatsapp') {
        const resolved = resolveWhatsapp(await whatsappSettings(), String(r.template), payload);
        if (resolved && !resolved.enabled) {
          await db.query("UPDATE notifications_queue SET status='Failed', error=$1, attempts=$2 WHERE id=$3",
            [`WhatsApp '${String(r.template)}' is turned off in Settings`, attempts, id]);
          failed++;
          if (gap && i < rows.length - 1) await sleep(gap);
          continue;
        }
        if (resolved) wa = { name: resolved.name, variables: resolved.variables, document: resolved.document, testPhone: resolved.testPhone };
      }
      const res = await providerFor(String(r.channel)).send(String(r.to_address), subject, body,
        { template: String(r.template), payload, html, ...(attachment ? { attachment } : {}), ...(wa ? { wa } : {}) });

      if (res.ok) {
        await db.query(
          "UPDATE notifications_queue SET status='Sent', provider_message_id=$1, sent_at=now(), attempts=$2, error=NULL WHERE id=$3",
          [res.messageId ?? null, attempts, id]);
        sent++;
      } else if (res.rateLimited) {
        // The door is shut for EVERY message on this channel, not just this
        // one, so push them all back together. Pushing only the current row
        // would let the next tick walk into the same 429 a minute later, and
        // the one after that, inching through the queue an hour at a time.
        // A rate limit also costs no attempt — it is not this message's fault.
        await db.query(
          `UPDATE notifications_queue
              SET error = $1, next_attempt_at = now() + ($2 || ' milliseconds')::interval
            WHERE status = 'Pending' AND channel = $3 AND next_attempt_at <= now()`,
          [res.error ?? 'rate limited', String(config.NOTIFY_RATE_LIMIT_BACKOFF_MS), String(r.channel)]);
        retrying++;
      } else if (res.retryable && attempts < MAX_ATTEMPTS) {
        await db.query(
          "UPDATE notifications_queue SET status='Pending', error=$1, attempts=$2, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id=$4",
          [res.error ?? 'send failed', attempts, String(backoffMs(attempts)), id]);
        retrying++;
      } else {
        await db.query(
          "UPDATE notifications_queue SET status='Failed', error=$1, attempts=$2 WHERE id=$3",
          [res.error ?? 'send failed', attempts, id]);
        failed++;
      }

      if (res.rateLimited) { stopped = true; break; }   // leave the rest Pending
    } catch (e) {
      // An exception here is our bug, not the provider's — retry it too: a
      // transient render/DB hiccup must not cost a customer their message.
      const retry = attempts < MAX_ATTEMPTS;
      if (retry) {
        await db.query(
          "UPDATE notifications_queue SET status='Pending', error=$1, attempts=$2, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id=$4",
          [(e as Error).message, attempts, String(backoffMs(attempts)), id]);
        retrying++;
      } else {
        await db.query("UPDATE notifications_queue SET status='Failed', error=$1, attempts=$2 WHERE id=$3",
          [(e as Error).message, attempts, id]);
        failed++;
      }
    }
    if (gap && i < rows.length - 1) await sleep(gap);
  }
  return { sent, failed, retrying, stopped };
}

export async function listQueue(db: Db, limit = 100) {
  return (await db.query('SELECT id, channel, template, to_address, status, provider_message_id, created_at, sent_at FROM notifications_queue ORDER BY id DESC LIMIT $1', [limit])).rows;
}

/**
 * Delivery report for one thing that fanned messages out (a payout batch).
 * `Pending` here means genuinely still on its way — retries land back in it.
 */
export async function deliveryFor(db: Db, kind: string, id: number) {
  return (await db.query<Record<string, unknown>>(
    `SELECT nq.id, nq.customer_id, nq.application_id, nq.to_address, nq.status, nq.attempts, nq.error,
            nq.sent_at, nq.next_attempt_at, c.full_name, c.customer_code
       FROM notifications_queue nq
       LEFT JOIN customers c ON c.id = nq.customer_id
      WHERE nq.ref_kind = $1 AND nq.ref_id = $2
      ORDER BY (nq.status = 'Sent'), c.full_name NULLS LAST, nq.id`,
    [kind, id])).rows;
}
