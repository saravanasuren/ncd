/**
 * NCD → LockerHub CUSTOMER/subscription event push
 * (NCD_INTEGRATION_CONTRACT.md v1.0, "Events the NCD app SENDS LockerHub").
 *
 *   POST <LOCKERHUB_EVENT_WEBHOOK_URL>   (contract: …/api/integration/wealth/webhook)
 *   Header: X-Integration-Key: <shared secret>  (reuses LOCKERHUB_INTEGRATION_KEY)
 *   Body:   { event_id, event_type, occurred_at, phone, data:{ lockerhub_application_no, customer_code } }
 *
 * `event_id` is the idempotency key — deterministic from (event_type, dedup key)
 * so a re-emit of the same domain fact collapses to one row, and LockerHub is
 * re-delivery safe on it.
 *
 * DORMANT BY DEFAULT: nothing enqueues or dispatches unless
 * LOCKERHUB_EVENT_WEBHOOK_URL is set (cutover step). Emission is best-effort —
 * a queue failure never breaks the domain operation that triggered it.
 *
 * Retry: 1m, 5m, 30m, 2h, 6h, 12h, 24h; 4xx = permanent fail; max_attempts → abandoned.
 */
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import type { Db } from '../../db/types.js';

const MAX_BATCH = 25;
const HTTP_TIMEOUT_MS = 8000;
const BACKOFF_SECS = [60, 300, 1800, 7200, 21600, 43200, 86400];

export type CustomerEventType =
  | 'customer.synced'
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.cancelled'
  | 'payment.acknowledged'
  | 'interest.paid'
  | 'redemption.completed';

export const eventsConfigured = (): boolean => !!config.LOCKERHUB_EVENT_WEBHOOK_URL;

function eventId(eventType: string, dedupKey: string): string {
  return 'evt_' + createHash('sha256').update(`${eventType}:${dedupKey}`).digest('hex').slice(0, 24);
}

export interface EmitInput {
  eventType: CustomerEventType;
  phone: string | null;
  /** Contract data block; lockerhub_application_no + customer_code at minimum. */
  data: Record<string, unknown>;
  /** Stable per-fact key — same (eventType, dedupKey) never enqueues twice. */
  dedupKey: string;
}

/**
 * Queue one customer event (no network here — the cron dispatches). Best-effort:
 * swallows its own errors so it can never break the caller's transaction. No-op
 * unless the event webhook is configured.
 */
export async function emitCustomerEvent(db: Db, input: EmitInput): Promise<{ enqueued: boolean; skipped?: string }> {
  if (!eventsConfigured()) return { enqueued: false, skipped: 'event webhook not configured' };
  try {
    const id = eventId(input.eventType, input.dedupKey);
    const payload = {
      event_id: id,
      event_type: input.eventType,
      occurred_at: new Date().toISOString(),
      phone: input.phone ?? null,
      data: input.data,
    };
    const ins = await db.query<{ id: string }>(
      `INSERT INTO customer_event_webhooks (event_id, event_type, phone, payload)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
      [id, input.eventType, input.phone ?? null, JSON.stringify(payload)]
    );
    return { enqueued: !!ins.rowCount };
  } catch (e) {
    console.warn('[customer-event] enqueue failed (ignored):', (e as Error).message);
    return { enqueued: false, skipped: 'error' };
  }
}

/**
 * Emit an application-scoped event, resolving phone / customer_code /
 * lockerhub_application_no from the app + customer. `dedupSuffix` distinguishes
 * repeatable facts (e.g. each interest payout on the same app).
 */
export async function emitForApplication(
  db: Db, eventType: CustomerEventType, applicationId: number, dedupSuffix = ''
): Promise<void> {
  if (!eventsConfigured()) return;
  try {
    const r = (await db.query<{ application_no: string; lockerhub_intent_no: string | null; customer_code: string; phone: string | null }>(
      `SELECT a.application_no, a.lockerhub_intent_no, c.customer_code, c.phone
         FROM applications a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1`,
      [applicationId]
    )).rows[0];
    if (!r) return;
    await emitCustomerEvent(db, {
      eventType,
      phone: r.phone,
      data: {
        lockerhub_application_no: r.lockerhub_intent_no ?? r.application_no,
        // LockerHub's payment.acknowledged handler reconciles its queue row on
        // data.lockerhub_intent_no (confirmed by Prem 2026-07-21). Send it
        // explicitly alongside the contract's lockerhub_application_no so their
        // reconciliation matches regardless of which key their code reads.
        lockerhub_intent_no: r.lockerhub_intent_no,
        customer_code: r.customer_code,
        application_no: r.application_no,
      },
      dedupKey: `${applicationId}${dedupSuffix ? ':' + dedupSuffix : ''}`,
    });
  } catch (e) {
    console.warn('[customer-event] emitForApplication failed (ignored):', (e as Error).message);
  }
}

/** Drain up to MAX_BATCH due events. Safe to run concurrently (SKIP LOCKED). */
export async function dispatchPendingCustomerEvents(db: Db): Promise<{ sent: number; failed: number }> {
  if (!eventsConfigured()) return { sent: 0, failed: 0 };
  const claim = await db.query<{ id: string; event_type: string; payload: unknown; attempts: number; max_attempts: number }>(
    `UPDATE customer_event_webhooks
        SET last_attempt_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM customer_event_webhooks
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, event_type, payload, attempts, max_attempts`,
    [MAX_BATCH]
  );
  let sent = 0, failed = 0;
  for (const row of claim.rows) {
    try {
      const body = JSON.stringify(row.payload);
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(config.LOCKERHUB_EVENT_WEBHOOK_URL!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Integration-Key': config.LOCKERHUB_INTEGRATION_KEY,
            'X-Dhanam-Event': row.event_type,
          },
          body,
          signal: ctl.signal,
        });
      } finally { clearTimeout(tid); }

      if (resp.ok) {
        await db.query("UPDATE customer_event_webhooks SET status='sent', sent_at=now(), http_response_status=$2, last_error=NULL WHERE id=$1", [row.id, resp.status]);
        sent++;
      } else if (resp.status >= 400 && resp.status < 500) {
        const errText = (await resp.text().catch(() => '')).slice(0, 500);
        await db.query("UPDATE customer_event_webhooks SET status='failed', http_response_status=$2, last_error=$3 WHERE id=$1", [row.id, resp.status, errText]);
        console.warn(`[customer-event] event ${row.id} failed permanently (${resp.status})`);
        failed++;
      } else {
        await scheduleRetry(db, row, `HTTP ${resp.status}`);
        failed++;
      }
    } catch (err) {
      await scheduleRetry(db, row, (err as Error).message ?? String(err));
      failed++;
    }
  }
  return { sent, failed };
}

async function scheduleRetry(db: Db, row: { id: string; attempts: number; max_attempts: number }, errMsg: string): Promise<void> {
  if (row.attempts >= row.max_attempts) {
    await db.query("UPDATE customer_event_webhooks SET status='abandoned', last_error=$2 WHERE id=$1", [row.id, errMsg.slice(0, 500)]);
    console.warn(`[customer-event] event ${row.id} abandoned after ${row.attempts} attempts`);
    return;
  }
  const nextSec = BACKOFF_SECS[Math.min(row.attempts, BACKOFF_SECS.length - 1)];
  await db.query("UPDATE customer_event_webhooks SET next_attempt_at = now() + ($2 || ' seconds')::interval, last_error=$3 WHERE id=$1", [row.id, String(nextSec), errMsg.slice(0, 500)]);
}
