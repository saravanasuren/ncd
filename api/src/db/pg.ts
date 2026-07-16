/** Production Postgres adapter (node-postgres Pool). */
import pg from 'pg';
import type { Db, QueryResult } from './types.js';

// numeric/bigint/date come back as strings by default in node-postgres — we
// keep it that way on purpose (docs/01 §4: money numbers are strings).

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
