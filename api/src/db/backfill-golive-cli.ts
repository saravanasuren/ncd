/**
 * CLI wrapper for the go-live backfill. The logic lives in backfill-golive.ts
 * so it can be tested; this just loads secrets, opens the DB and runs it.
 *
 *     npm run backfill:golive -w @new-wealth/api      (built)
 *     npm run backfill:golive:dev -w @new-wealth/api  (tsx)
 *
 * Idempotent — safe to re-run.
 */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
const { createDb } = await import('./index.js');
const { backfillGoLive } = await import('./backfill-golive.js');

const db = createDb();
await backfillGoLive(db, (m) => console.log(m));
await db.close();
console.log('backfill:golive done.');
