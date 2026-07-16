/** CLI: seed roles/permissions/settings/company-profile/admin (+ synthetic
 * demo data only when NODE_ENV != production). Loads SSM secrets first.
 * config.js/seed.js are dynamic-imported so config validates process.env
 * AFTER the SSM values land (static imports would hoist config evaluation
 * above loadSecretsFromSsm — that's how the first prod seed got dev defaults). */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
const { createDb } = await import('./index.js');
const { seed } = await import('./seed.js');

const db = createDb();
await seed(db);
console.log('[seed] done');
await db.close();
