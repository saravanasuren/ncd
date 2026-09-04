/**
 * Put a customer (and a branch name) on the locker allotment rows that went out
 * without one (owner 2026-09-04: "what are those characters").
 *
 * The allocate route never passed a customer through, so every row written
 * before that fix has customer_id NULL — and the approval card, which is meant
 * to lead with the customer's name, showed LockerHub's internal application id
 * instead. Unreadable, and the only thing on the card.
 *
 * Resolution is the same join the live path now uses: LockerHub is phone-keyed,
 * so their application's phone finds the NCD customer. A row whose phone matches
 * nobody is LEFT ALONE rather than guessed at.
 *
 *   node dist/scripts/backfill-allotment-customers.js            # dry run
 *   node dist/scripts/backfill-allotment-customers.js --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
// Dynamic AFTER secrets: config.js validates at import time in production and
// throws before anything runs otherwise (learned the hard way, #381/#382).
const { createDb } = await import('../db/index.js');
const lh = await import('../integrations/lockerhub/client.js');
const { enrich } = await import('../modules/lockers/allotments.js');

const COMMIT = process.argv.includes('--commit');
const db = createDb();

const rows = (await db.query<{ lockerhub_application_id: string; locker_no: string | null; branch_id: string | null }>(
  `SELECT lockerhub_application_id, locker_no, branch_id
     FROM locker_allotments WHERE customer_id IS NULL ORDER BY id`)).rows;

console.log(`${rows.length} allotment row(s) with no customer — ${COMMIT ? 'COMMITTING' : 'DRY RUN'}\n`);
let fixed = 0, unmatched = 0, unreadable = 0;

for (const r of rows) {
  const appId = r.lockerhub_application_id;
  const app = await lh.getLockerApplication(appId).catch(() => null) as Record<string, unknown> | null;
  if (!app) { unreadable++; console.log(`  ${appId}  — could not read from LockerHub, skipped`); continue; }

  const filled = await enrich(db, {
    lockerhub_application_id: appId,
    phone: (app.phone as string) ?? null,
    branch_id: r.branch_id ?? (app.branch_id as string) ?? null,
  });

  if (filled.customer_id == null) {
    unmatched++;
    console.log(`  ${appId}  ${r.locker_no ?? ''} — no NCD customer on that phone, left blank`);
    continue;
  }
  const [c] = (await db.query<{ full_name: string }>(
    'SELECT full_name FROM customers WHERE id = $1', [filled.customer_id])).rows;
  if (COMMIT) {
    await db.query(
      `UPDATE locker_allotments
          SET customer_id = $2,
              branch_name = COALESCE(branch_name, $3),
              branch_id = COALESCE(branch_id, $4),
              updated_at = now()
        WHERE lockerhub_application_id = $1`,
      [appId, filled.customer_id, filled.branch_name ?? null, filled.branch_id ?? null]);
  }
  fixed++;
  console.log(`  ${appId}  ${r.locker_no ?? ''} → ${c?.full_name ?? filled.customer_id}${filled.branch_name ? ` (${filled.branch_name})` : ''}`);
}

console.log(`\n  linked to a customer : ${fixed}`);
console.log(`  no match on phone    : ${unmatched}   (left blank on purpose)`);
console.log(`  unreadable           : ${unreadable}`);
console.log(COMMIT ? '\nCOMMITTED.' : '\nDRY RUN — nothing written. Pass --commit.');
await db.close();
