/** CLI: apply pending migrations against DATABASE_URL (prod) or PGlite (dev).
 * Loads SSM secrets first so DATABASE_URL is populated in production. */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

await loadSecretsFromSsm();
const db = createDb();
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date — nothing to apply');
await db.close();
