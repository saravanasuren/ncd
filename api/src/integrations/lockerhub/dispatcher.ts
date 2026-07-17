/**
 * Wealth → LockerHub agent-event webhooks — ported from the old app's
 * agent-event-dispatcher.js (2026-06-30), same wire contract:
 *   POST LOCKERHUB_WEBHOOK_URL
 *   Headers: X-Dhanam-Signature: sha256=<HMAC-SHA256(ts + '.' + body)>,
 *            X-Dhanam-Timestamp: <unix seconds>, X-Dhanam-Event: <type>
 *   Payload: { ...event fields, event, agent_id, lockerhub_user_id, fired_at }
 *
 * DISABLED BY DEFAULT: both LOCKERHUB_WEBHOOK_URL and
 * LOCKERHUB_WEBHOOK_SECRET must be set in SSM before anything enqueues or
 * dispatches (cutover step — see ops/CUTOVER-LOCKERHUB.md). The secret is
 * deliberately separate from LOCKERHUB_INTEGRATION_KEY.
 *
 * Retry: 60s, 5m, 30m, 2h, 12h, 24h; 4xx = permanent failure; after
 * max_attempts the row is 'abandoned'. Idempotent on dedup_key.
 */
import { createHmac } from 'node:crypto';
import { config } from '../../config.js';
import type { Db } from '../../db/types.js';

const MAX_BATCH = 25;
const HTTP_TIMEOUT_MS = 8000;
const BACKOFF_SECS = [60, 300, 1800, 7200, 43200, 86400];

const configured = () => !!(config.LOCKERHUB_WEBHOOK_URL && config.LOCKERHUB_WEBHOOK_SECRET);

function sign(body: string, timestamp: number): string {
  const h = createHmac('sha256', config.LOCKERHUB_WEBHOOK_SECRET!);
  h.update(`${timestamp}.${body}`);
  return 'sha256=' + h.digest('hex');
}

export interface EnqueueEventInput {
  eventType: 'customer_activated' | 'incentive_accrued' | 'incentive_paid';
  targetAgentId: number;
  dedupKey: string;
  payload: Record<string, unknown>;
}

/** Queue one event (call inside the domain transaction — no network here).
 * No-ops when the webhook isn't configured or the agent isn't LockerHub-sourced. */
export async function enqueueEvent(db: Db, input: EnqueueEventInput): Promise<{ enqueued: boolean; skipped?: string }> {
  if (!configured()) return { enqueued: false, skipped: 'webhook not configured' };
  const { rows } = await db.query<{ lockerhub_user_id: string | null }>(
    'SELECT lockerhub_user_id FROM agents WHERE id = $1', [input.targetAgentId]);
  const lhUserId = rows[0]?.lockerhub_user_id;
  if (lhUserId == null) return { enqueued: false, skipped: 'agent is not a lockerhub agent' };

  const finalPayload = {
    ...input.payload,
    event: input.eventType,
    agent_id: input.targetAgentId,
    lockerhub_user_id: Number(lhUserId),
    fired_at: new Date().toISOString(),
  };
  const ins = await db.query<{ id: string }>(
    `INSERT INTO agent_event_webhooks (event_type, target_agent_id, lockerhub_user_id, dedup_key, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [input.eventType, input.targetAgentId, Number(lhUserId), input.dedupKey, JSON.stringify(finalPayload)]
  );
  return { enqueued: !!ins.rowCount };
}

/** Drain up to MAX_BATCH due events. Safe to run concurrently (SKIP LOCKED). */
export async function dispatchPending(db: Db): Promise<{ sent: number; failed: number }> {
  if (!configured()) return { sent: 0, failed: 0 };
  const claim = await db.query<{ id: string; event_type: string; payload: unknown; attempts: number; max_attempts: number }>(
    `UPDATE agent_event_webhooks
        SET last_attempt_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM agent_event_webhooks
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, event_type, payload, attempts, max_attempts`,
    [MAX_BATCH]
  );
  let sent = 0, failed = 0;
  for (const row of claim.rows) {
    try {
      const body = JSON.stringify(row.payload);
      const ts = Math.floor(Date.now() / 1000);
      const ctl = new AbortController();
      const tid = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(config.LOCKERHUB_WEBHOOK_URL!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dhanam-Signature': sign(body, ts),
            'X-Dhanam-Timestamp': String(ts),
            'X-Dhanam-Event': row.event_type,
          },
          body,
          signal: ctl.signal,
        });
      } finally { clearTimeout(tid); }

      if (resp.ok) {
        await db.query("UPDATE agent_event_webhooks SET status='sent', sent_at=now(), http_response_status=$2, last_error=NULL WHERE id=$1", [row.id, resp.status]);
        sent++;
      } else if (resp.status >= 400 && resp.status < 500) {
        const errText = (await resp.text().catch(() => '')).slice(0, 500);
        await db.query("UPDATE agent_event_webhooks SET status='failed', http_response_status=$2, last_error=$3 WHERE id=$1", [row.id, resp.status, errText]);
        console.warn(`[agent-event] event ${row.id} failed permanently (${resp.status})`);
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
    await db.query("UPDATE agent_event_webhooks SET status='abandoned', last_error=$2 WHERE id=$1", [row.id, errMsg.slice(0, 500)]);
    console.warn(`[agent-event] event ${row.id} abandoned after ${row.attempts} attempts`);
    return;
  }
  const nextSec = BACKOFF_SECS[Math.min(row.attempts, BACKOFF_SECS.length - 1)];
  await db.query("UPDATE agent_event_webhooks SET next_attempt_at = now() + ($2 || ' seconds')::interval, last_error=$3 WHERE id=$1", [row.id, String(nextSec), errMsg.slice(0, 500)]);
}
