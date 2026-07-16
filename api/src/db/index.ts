/**
 * DB factory. Uses real Postgres when DATABASE_URL points at one; otherwise
 * falls back to PGlite (local dev / tests without a Postgres server).
 */
import type { Db } from './types.js';
import { PgDb } from './pg.js';
import { PgliteDb } from './pglite.js';

export type { Db, QueryResult } from './types.js';

let singleton: Db | null = null;

export function createDb(): Db {
  const url = process.env.DATABASE_URL;
  const usePglite = process.env.USE_PGLITE === '1' || !url || !url.startsWith('postgres');
  if (usePglite) {
    const dataDir = process.env.PGLITE_DIR; // undefined = in-memory
    return new PgliteDb(dataDir);
  }
  return new PgDb(url);
}

/** Process-wide DB used by the running server. Tests create their own. */
export function getDb(): Db {
  if (!singleton) singleton = createDb();
  return singleton;
}

export function setDb(db: Db): void {
  singleton = db;
}
