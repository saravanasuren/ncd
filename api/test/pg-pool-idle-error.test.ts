/**
 * A dying IDLE database connection must not take the API down.
 *
 * 2026-08-28 06:21 UTC: unattended-upgrades restarted Postgres, every open
 * connection got "terminating connection due to administrator command", and
 * node-postgres emitted 'error' on the Pool. Nothing was listening — and Node
 * treats an unhandled EventEmitter 'error' as a THROW — so it surfaced as an
 * uncaughtException and the API exited. systemd restarted it ~6s later.
 *
 * A routine overnight package upgrade must not be able to stop the book. This
 * pins the listener: emit the exact error on the pool and require that nothing
 * throws. Without the handler this test dies with the emitted error.
 *
 * White-box on purpose (`pool` is private): the whole defect lives in whether
 * that listener is attached, so the test has to look at it. new pg.Pool() is
 * lazy — no connection is opened here, so this needs no live database.
 */
import { describe, it, expect } from 'vitest';
import { PgDb } from '../src/db/pg.js';

describe('a dropped idle pooled connection does not crash the process', () => {
  it("swallows the Postgres 'administrator command' error instead of throwing", async () => {
    const db = new PgDb('postgres://user:pass@127.0.0.1:5432/nonexistent');
    const pool = (db as unknown as { pool: NodeJS.EventEmitter & { end: () => Promise<void> } }).pool;

    // Exactly what node-postgres emitted at 06:21 UTC.
    const err = new Error('terminating connection due to administrator command');
    expect(() => pool.emit('error', err)).not.toThrow();

    // And the listener really is ours, not Node's default throw-on-error.
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    await pool.end();
  });

  it('survives a burst of them — a restart kicks every connection at once', async () => {
    const db = new PgDb('postgres://user:pass@127.0.0.1:5432/nonexistent');
    const pool = (db as unknown as { pool: NodeJS.EventEmitter & { end: () => Promise<void> } }).pool;
    expect(() => {
      for (let i = 0; i < 10; i++) {
        pool.emit('error', new Error('terminating connection due to administrator command'));
      }
    }).not.toThrow();
    await pool.end();
  });
});
