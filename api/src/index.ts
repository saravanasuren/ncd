/**
 * Boot sequence (docs/01 §2): [secrets →] config → app → listen.
 * Process-safety handlers ported from the old app (docs/01 §4).
 */
import { createApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  // In production, SSM secrets would be loaded here before config is read.
  const app = createApp();

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
