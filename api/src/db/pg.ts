/** Production Postgres adapter (node-postgres Pool). */
import pg from 'pg';
import type { Db, QueryResult } from './types.js';

// numeric/bigint come back as strings by default in node-postgres, and we keep
// them that way on purpose (docs/01 §4: money numbers are strings).
//
// DATE/TIMESTAMP are the exception: node-pg's DEFAULT parsers turn them into JS
// Date objects, but the whole codebase (and the PGlite test adapter, which
// returns strings) assumes plain strings — e.g. `String(col).slice(0,10)`. On a
// Date object that yields "Wed Jun 01 2026 …" instead of "2026-06-01", which
// then crashed the dashboard and mangled report/export/PDF dates in PROD only
// (tests never saw it). Register string parsers for date(1082),
// timestamp(1114) and timestamptz(1184) so prod matches tests and the
// String()/slice assumptions hold everywhere. This is process-global, which is
// fine — there is a single pool.
const asString = (v: string): string => v;
pg.types.setTypeParser(1082, asString); // date        -> 'YYYY-MM-DD'
pg.types.setTypeParser(1114, asString); // timestamp   -> 'YYYY-MM-DD HH:MM:SS(.ms)'
pg.types.setTypeParser(1184, asString); // timestamptz -> 'YYYY-MM-DD HH:MM:SS(.ms)+TZ'

export class PgDb implements Db {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const txDb: Db = {
      query: async <U = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params as unknown[]);
        return { rows: r.rows as U[], rowCount: r.rowCount ?? 0 };
      },
      exec: async (sql: string) => { await client.query(sql); },
      withTx: (nested) => nested(txDb), // already in a tx
      close: async () => {},
    };
    try {
      await client.query('BEGIN');
      const out = await fn(txDb);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
