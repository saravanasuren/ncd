/**
 * The queue drain must never hand the same row to the provider twice.
 *
 * On 2026-08-28 a customer with ONE investment got TWO identical interest-credit
 * WhatsApps. The queue held ONE row, sent once (one provider id, attempts=1) —
 * so it wasn't a duplicate enqueue. The cause: the drain SELECTed due rows and
 * only marked them Sent AFTER the provider call, with no row claim. A slow cycle
 * overlapping the next 60s tick let both cycles pick the same not-yet-sent row
 * and send it twice.
 *
 * The fix claims rows atomically (lease via next_attempt_at + FOR UPDATE SKIP
 * LOCKED) before any send. These tests force two drains to overlap and prove
 * each row reaches the provider exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { drainOnce } from '../src/modules/notifications/service.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function enqueueWhatsapp(n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let k = 0; k < n; k++) {
    const r = await ctx.db.query<{ id: string }>(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status)
       VALUES ('whatsapp', 'interest_paid', $1, '{}'::jsonb, 'Pending') RETURNING id`,
      [`91900000${String(k).padStart(3, '0')}`]);
    ids.push(Number(r.rows[0]!.id));
  }
  return ids;
}

describe('drain claims rows atomically', () => {
  it('two overlapping drains send each row exactly once', async () => {
    const ids = await enqueueWhatsapp(6);

    // Force a yield between sends so the second drain genuinely overlaps the
    // first mid-cycle (with no gap the first can finish before the second even
    // starts, hiding the race). The claim/lease must make that overlap safe.
    const savedGap = config.NOTIFY_SEND_GAP_MS;
    config.NOTIFY_SEND_GAP_MS = 30;
    let a, b;
    try {
      [a, b] = await Promise.all([drainOnce(ctx.db, 20), drainOnce(ctx.db, 20)]);
    } finally {
      config.NOTIFY_SEND_GAP_MS = savedGap;
    }

    // The whole point: total sends across BOTH drains equals the row count — not
    // double. Pre-fix, both drains claimed the same rows and this summed high.
    expect(a!.sent + b!.sent).toBe(ids.length);

    const q = await ctx.db.query<{ status: string; attempts: string }>(
      `SELECT status, attempts FROM notifications_queue WHERE id = ANY($1)`, [ids]);
    expect(q.rows).toHaveLength(ids.length);
    expect(q.rows.every((r) => r.status === 'Sent')).toBe(true);
    expect(q.rows.every((r) => Number(r.attempts) === 1)).toBe(true);
  });

  it('splits the work — a concurrent drain takes the rows the first one skipped', async () => {
    const ids = await enqueueWhatsapp(8);
    const savedGap = config.NOTIFY_SEND_GAP_MS;
    config.NOTIFY_SEND_GAP_MS = 20;
    let a, b;
    try {
      [a, b] = await Promise.all([drainOnce(ctx.db, 8), drainOnce(ctx.db, 8)]);
    } finally {
      config.NOTIFY_SEND_GAP_MS = savedGap;
    }
    // Neither drain sent more than the 8 that exist, and between them they sent
    // each exactly once — a claimed row is out of the other's reach.
    expect(a!.sent + b!.sent).toBe(ids.length);
    const sent = await ctx.db.query<{ c: string }>(
      `SELECT count(*) c FROM notifications_queue WHERE id = ANY($1) AND status = 'Sent'`, [ids]);
    expect(Number(sent.rows[0]!.c)).toBe(ids.length);
  });

  it('leaves nothing behind — a single drain still sends everything due', async () => {
    const ids = await enqueueWhatsapp(4);
    const r = await drainOnce(ctx.db, 50);
    expect(r.sent).toBeGreaterThanOrEqual(ids.length);
    const pending = await ctx.db.query<{ c: string }>(
      `SELECT count(*) c FROM notifications_queue WHERE id = ANY($1) AND status = 'Pending'`, [ids]);
    expect(Number(pending.rows[0]!.c)).toBe(0);
  });
});
