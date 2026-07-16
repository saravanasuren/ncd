/**
 * migrate-legacy/run.ts — CLI entry for the real migration.
 *
 * DRY-RUN (default): reads the old DB and loads into a THROWAWAY in-memory
 * target (PGlite) it builds itself, inside a transaction, prints the
 * reconciliation report, then rolls back. Nothing is written to any real DB —
 * the only real database touched is the legacy SOURCE, read-only. Safe to run
 * repeatedly, and safe to run on the box (data never leaves it).
 *
 * COMMIT (`--commit`): loads into the real new DB (`DATABASE_URL`, already
 * migrated + seeded) and keeps it. Use only after the dry-run report is right.
 *
 * Usage:
 *   # dry-run — only needs a pointer to the old DB (a local restore, or the
 *   # box's live old DB read-only):
 *   LEGACY_DATABASE_URL=postgres://…/dhanam_wealth  node dist/migrate-legacy/run.js
 *
 *   # commit — into the new DB:
 *   LEGACY_DATABASE_URL=postgres://…/dhanam_wealth \
 *   DATABASE_URL=postgres://…/dhanam_newwealth      node dist/migrate-legacy/run.js --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { PgliteDb } from '../db/pglite.js';
import { migrate } from '../db/migrate.js';
import { ROLES, ROLE_LABELS, ROLE_LEVEL } from '@new-wealth/shared';
import type { Db } from '../db/types.js';
import { runMigration } from './pipeline.js';
import { formatReport } from './report.js';
import { PgLegacySource } from './source.js';

/** A clean throwaway target for a dry-run: schema + the 8 roles, nothing else.
 * Never touches any real database — lives in memory and is discarded. */
async function buildDryRunTarget(): Promise<Db> {
  const db = new PgliteDb();
  await migrate(db);
  const roleId: Record<string, number> = Object.fromEntries(ROLES.map((r, i) => [r, i + 1]));
  for (const role of ROLES) {
    await db.query('INSERT INTO roles (id, name, label, level) VALUES ($1,$2,$3,$4)', [
      roleId[role], role, ROLE_LABELS[role], ROLE_LEVEL[role],
    ]);
  }
  return db;
}

async function main() {
  await loadSecretsFromSsm();
  const commit = process.argv.includes('--commit');

  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  if (!legacyUrl) {
    console.error(
      '[migrate-legacy] LEGACY_DATABASE_URL is required — point it at the OLD database\n' +
        '  (a local restore of the prod dump, or the box’s live old DB read-only). Example:\n' +
        '  LEGACY_DATABASE_URL=postgres://localhost/dhanam_wealth node dist/migrate-legacy/run.js'
    );
    process.exit(1);
  }

  const source = new PgLegacySource(legacyUrl);

  // Dry-run builds its own in-memory target; commit uses the real new DB.
  let target: Db;
  if (commit) {
    const url = process.env.DATABASE_URL;
    if (!url || !url.startsWith('postgres')) {
      console.error('[migrate-legacy] --commit requires DATABASE_URL pointing at the new Postgres DB (migrated + seeded).');
      process.exit(1);
    }
    target = createDb();
  } else {
    target = await buildDryRunTarget();
  }

  console.log(`[migrate-legacy] source=${source.label()}  mode=${commit ? 'COMMIT' : 'DRY-RUN'}`);
  const report = await runMigration(source, target, { dryRun: !commit });
  console.log('\n' + formatReport(report));

  await source.close();
  await target.close();

  if (!commit) {
    console.log('\n[migrate-legacy] DRY-RUN complete — no real database was written. Re-run with --commit to persist into the new DB.');
  } else {
    console.log('\n[migrate-legacy] COMMIT complete.');
  }
}

main().catch((e) => {
  console.error('[migrate-legacy] failed:', e);
  process.exit(1);
});
