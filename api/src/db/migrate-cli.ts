/** CLI: apply pending migrations against DATABASE_URL (prod) or PGlite (dev).
 * Loads SSM secrets first so DATABASE_URL is populated in production. */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
// Dynamic imports keep config/db evaluation AFTER secrets land (see seed-cli.ts).
const { createDb } = await import('./index.js');
const { migrate } = await import('./migrate.js');
const db = createDb();
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date — nothing to apply');
await db.close();
