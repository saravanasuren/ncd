/**
 * Crash-alert emails (docs/00 §12). On an uncaughtException / unhandledRejection,
 * email the admins — throttled to at most one per COOLDOWN so a crash-loop can't
 * flood inboxes. Best-effort and self-guarding: never throws out of the handler.
 */
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { enqueue, drainOnce } from '../modules/notifications/service.js';

const COOLDOWN_MS = 10 * 60 * 1000;
let lastSent = 0;

export async function sendCrashAlert(kind: string, error: unknown): Promise<void> {
  try {
    const now = Date.now();
    if (now - lastSent < COOLDOWN_MS) return; // throttle
    lastSent = now;
    const db: Db = getDb();
    const { rows } = await db.query<{ email: string }>(
      `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name IN ('super_admin','admin')`);
    const err = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    for (const r of rows) {
      await enqueue(db, { channel: 'email', template: 'crash_alert', to: r.email, payload: { kind, detail: err.slice(0, 1500), at: new Date().toISOString() } });
    }
    await drainOnce(db, 10); // try to get it out before the process may die
  } catch {
    // Never let the alert path throw — the process is already unhealthy.
  }
}
