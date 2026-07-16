/** Notification queue (docs/08 §5). Enqueue → cron drains → provider sends.
 * enqueue can run inside a caller's transaction. */
import type { Db } from '../../db/types.js';
import { renderTemplate } from './templates.js';
import { providerFor } from '../../integrations/notify/index.js';

export interface EnqueueInput {
  channel: 'email' | 'sms' | 'whatsapp';
  template: string;
  to: string;
  payload?: Record<string, unknown>;
}

export async function enqueue(db: Db, input: EnqueueInput): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications_queue (channel, template, to_address, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.channel, input.template, input.to, JSON.stringify(input.payload ?? {})]
  );
  return Number(rows[0]!.id);
}

/** Drain up to `limit` pending notifications. Returns counts. Never throws. */
export async function drainOnce(db: Db, limit = 25): Promise<{ sent: number; failed: number }> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, channel, template, to_address, payload FROM notifications_queue WHERE status = 'Pending' ORDER BY id LIMIT $1`,
    [limit]
  );
  let sent = 0, failed = 0;
  for (const r of rows) {
    const id = Number(r.id);
    try {
      const { subject, body } = renderTemplate(String(r.template), (r.payload as Record<string, unknown>) ?? {});
      const res = await providerFor(String(r.channel)).send(String(r.to_address), subject, body);
      if (res.ok) {
        await db.query("UPDATE notifications_queue SET status='Sent', provider_message_id=$1, sent_at=now(), attempts=attempts+1 WHERE id=$2", [res.messageId ?? null, id]);
        sent++;
      } else {
        await db.query("UPDATE notifications_queue SET status='Failed', error=$1, attempts=attempts+1 WHERE id=$2", [res.error ?? 'send failed', id]);
        failed++;
      }
    } catch (e) {
      await db.query("UPDATE notifications_queue SET status='Failed', error=$1, attempts=attempts+1 WHERE id=$2", [(e as Error).message, id]);
      failed++;
    }
  }
  return { sent, failed };
}

export async function listQueue(db: Db, limit = 100) {
  return (await db.query('SELECT id, channel, template, to_address, status, provider_message_id, created_at, sent_at FROM notifications_queue ORDER BY id DESC LIMIT $1', [limit])).rows;
}
