/**
 * Minimal forward-only migration runner. Applies `migrations/*.sql` in
 * filename order, tracking applied files in `schema_migrations`. Works
 * identically on Postgres (prod) and PGlite (dev/test) — one code path,
 * no engine-specific tooling.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    // DDL is idempotent (IF NOT EXISTS); run the script then record it.
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    ran.push(file);
  }
  return ran;
}
