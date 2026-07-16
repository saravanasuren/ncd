/** CLI: seed roles/permissions/settings/company-profile/admin (+ synthetic
 * demo data only when NODE_ENV != production). Loads SSM secrets first. */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from './index.js';
import { seed } from './seed.js';

await loadSecretsFromSsm();
const db = createDb();
await seed(db);
console.log('[seed] done');
await db.close();
