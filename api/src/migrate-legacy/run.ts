/**
 * migrate-legacy/run.ts — CLI entry for the real migration.
 *
 * DRY-RUN (default): reads the old DB, loads into a freshly-migrated target
 * inside a transaction, prints the reconciliation report, then ROLLS BACK.
 * Nothing is written. Safe to run repeatedly.
 *
 * COMMIT (`--commit`): same load, kept. Requires an EMPTY target (freshly
 * migrated + seeded). Use only after the dry-run report looks right.
 *
 * Usage (on the owner's local machine, against a RESTORE of the prod dump —
 * never prod directly):
 *   LEGACY_DATABASE_URL=postgres://…/dhanam_wealth_restore \
 *   DATABASE_URL=postgres://…/dhanam_newwealth \
 *   node dist/migrate-legacy/run.js            # dry-run
 *   node dist/migrate-legacy/run.js --commit   # persist
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { runMigration } from './pipeline.js';
import { formatReport } from './report.js';
import { PgLegacySource } from './source.js';

async function main() {
  await loadSecretsFromSsm();
  const commit = process.argv.includes('--commit');

  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  if (!legacyUrl) {
    console.error(
      '[migrate-legacy] LEGACY_DATABASE_URL is required — point it at a LOCAL restore\n' +
        '  of the prod dump (never production). Example:\n' +
        '  LEGACY_DATABASE_URL=postgres://localhost/dhanam_wealth_restore \\\n' +
        '  DATABASE_URL=postgres://localhost/dhanam_newwealth node dist/migrate-legacy/run.js'
    );
    process.exit(1);
  }

  const source = new PgLegacySource(legacyUrl);
  const target = createDb(); // uses DATABASE_URL (the new DB), already migrated+seeded

  console.log(`[migrate-legacy] source=${source.label()}  mode=${commit ? 'COMMIT' : 'DRY-RUN'}`);
  const report = await runMigration(source, target, { dryRun: !commit });
  console.log('\n' + formatReport(report));

  await source.close();
  await target.close();

  if (!commit) {
    console.log('\n[migrate-legacy] DRY-RUN complete — nothing was written. Re-run with --commit to persist.');
  } else {
    console.log('\n[migrate-legacy] COMMIT complete.');
  }
}

main().catch((e) => {
  console.error('[migrate-legacy] failed:', e);
  process.exit(1);
});
