/**
 * Boot sequence (docs/01 §2, docs/10): SSM secrets → config → migrate/seed →
 * app → crons → listen. Secrets must load BEFORE config is imported (config
 * validates process.env at import time), so config/app are dynamic-imported.
 * Process-safety handlers ported from the old app (docs/01 §4).
 */
import { loadSecretsFromSsm } from './secrets.js';

/** Canary for a stale @new-wealth/shared build. The source deliberately EXCLUDES
 * 'PendingApproval' from the outstanding book (unfunded money must not inflate
 * it); a stale compiled dist re-includes it and silently corrupts every
 * portfolio total. Fail fast at boot rather than serve wrong numbers — the
 * deploy rebuilds shared via `npm run build`, so this only fires on a partial
 * build (npm ci without build, api-only build, stale local dist). */
async function assertSharedBuildFresh(): Promise<void> {
  const { OUTSTANDING_APPLICATION_STATUSES } = await import('@new-wealth/shared');
  if ((OUTSTANDING_APPLICATION_STATUSES as readonly string[]).includes('PendingApproval')) {
    throw new Error('Stale @new-wealth/shared build (OUTSTANDING_APPLICATION_STATUSES includes PendingApproval). Run `npm run build` to rebuild the shared package before starting.');
  }
}

async function bootstrapDb(): Promise<void> {
  await assertSharedBuildFresh();
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

  // LockerHub outbound — both no-op unless explicitly enabled in SSM
  // (see ops/CUTOVER-LOCKERHUB.md). Safe to keep armed.
  const { config } = await import('./config.js');
  const { dispatchPending } = await import('./integrations/lockerhub/dispatcher.js');
  setInterval(() => {
    void dispatchPending(getDb()).catch((e) => console.warn('[cron] agent-event dispatch:', (e as Error).message));
  }, 30_000).unref();

  // Daily book-summary email (docs/00 §12) — once per IST day after 18:00 IST.
  const { runBookSummary } = await import('./integrations/book-summary.js');
  setInterval(() => {
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
    if (istNow.getUTCHours() < 18) return;
    void runBookSummary(getDb()).catch((e) => console.warn('[cron] book summary:', (e as Error).message));
  }, 15 * 60_000).unref();

  // Daily backup-check email (docs/08 §2) — once per IST day after 08:00 IST;
  // enqueue is per-day idempotent, and it degrades to "not configured" notes
  // until the SharePoint params land.
  const { runBackupCheck } = await import('./integrations/backup-check.js');
  setInterval(() => {
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
    if (istNow.getUTCHours() < 8) return;
    void runBackupCheck(getDb()).catch((e) => console.warn('[cron] backup check:', (e as Error).message));
  }, 15 * 60_000).unref();

  // Digio eSign poller — real mode only, gated (webhook is the primary path;
  // this catches Digio's unreliable webhook delivery). Every 5 min.
  if (config.DIGIO_POLLER_ENABLED === 'true') {
    const { pollOutstanding } = await import('./integrations/digio/service.js');
    setInterval(() => {
      void pollOutstanding(getDb()).catch((e) => console.warn('[cron] digio poll:', (e as Error).message));
    }, 5 * 60_000).unref();
  }

  if (config.LOCKERHUB_RECONCILIATION_ENABLED === 'true') {
    const { runReconciliation } = await import('./integrations/lockerhub/reconciliation.js');
    // Once per IST day, first tick after 07:00 IST (enqueue is per-day idempotent).
    setInterval(() => {
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      if (istNow.getUTCHours() < 7) return;
      void runReconciliation(getDb()).catch((e) => console.warn('[cron] lockerhub recon:', (e as Error).message));
    }, 15 * 60_000).unref();
  }
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
  const alert = config.NODE_ENV === 'production'
    ? async (kind: string, e: unknown) => { const { sendCrashAlert } = await import('./lib/crashAlert.js'); await sendCrashAlert(kind, e); }
    : async () => {};
  process.on('unhandledRejection', (reason) => {
    console.error('[new-wealth-api] unhandledRejection:', reason);
    void alert('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[new-wealth-api] uncaughtException:', err);
    // Give the crash-alert a moment to enqueue+drain before exiting.
    void alert('uncaughtException', err).finally(() => setTimeout(() => process.exit(1), 2000));
  });
}

main().catch((err) => {
  console.error('[new-wealth-api] fatal boot error:', err);
  process.exit(1);
});
