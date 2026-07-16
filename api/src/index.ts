/**
 * Boot sequence (docs/01 §2, docs/10): SSM secrets → config → migrate/seed →
 * app → crons → listen. Secrets must load BEFORE config is imported (config
 * validates process.env at import time), so config/app are dynamic-imported.
 * Process-safety handlers ported from the old app (docs/01 §4).
 */
import { loadSecretsFromSsm } from './secrets.js';

async function bootstrapDb(): Promise<void> {
  const { config } = await import('./config.js');
  const { getDb } = await import('./db/index.js');
  const usingPglite = !process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('postgres');
  const db = getDb();
  if (usingPglite && config.NODE_ENV !== 'production') {
    const { seed } = await import('./db/seed.js');
    await seed(db);
    console.log('[new-wealth-api] PGlite dev DB migrated + seeded');
  } else {
    const { migrate } = await import('./db/migrate.js');
    const ran = await migrate(db);
    if (ran.length) console.log(`[new-wealth-api] applied migrations: ${ran.join(', ')}`);
  }
}

async function startCrons(): Promise<void> {
  const { getDb } = await import('./db/index.js');
  const { drainOnce } = await import('./modules/notifications/service.js');
  setInterval(() => {
    void drainOnce(getDb(), 25).catch((e) => console.warn('[cron] notify drain:', (e as Error).message));
  }, 60_000).unref();
}

async function main(): Promise<void> {
  await loadSecretsFromSsm(); // no-op locally
  const { config } = await import('./config.js');
  await bootstrapDb();
  const { createApp } = await import('./app.js');
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
