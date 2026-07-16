/**
 * Boot sequence (docs/01 §2): [secrets →] config → app → listen.
 * Process-safety handlers ported from the old app (docs/01 §4).
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

async function bootstrapDb(): Promise<void> {
  const usingPglite = !process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgres');
  const db = getDb();
  if (usingPglite && config.NODE_ENV !== 'production') {
    // Dev without a Postgres server: in-memory PGlite — migrate + seed so the
    // demo logins work immediately (docs/10 §4).
    await seed(db);
    console.log('[new-wealth-api] PGlite dev DB migrated + seeded');
  } else {
    const ran = await migrate(db);
    if (ran.length) console.log(`[new-wealth-api] applied migrations: ${ran.join(', ')}`);
  }
}

async function startCrons(): Promise<void> {
  const { getDb } = await import('./db/index.js');
  const { drainOnce } = await import('./modules/notifications/service.js');
  // Notification queue drain (docs/12). Production only.
  setInterval(() => {
    void drainOnce(getDb(), 25).catch((e) => console.warn('[cron] notify drain:', (e as Error).message));
  }, 60_000).unref();
}

async function main(): Promise<void> {
  // In production, SSM secrets would be loaded here before config is read.
  await bootstrapDb();
  const app = createApp();
  if (config.NODE_ENV === 'production') await startCrons();

  const server = app.listen(config.PORT, () => {
    console.log(`[new-wealth-api] listening on :${config.PORT} (${config.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[new-wealth-api] ${signal} received, draining…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[new-wealth-api] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[new-wealth-api] uncaughtException:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[new-wealth-api] fatal boot error:', err);
  process.exit(1);
});
