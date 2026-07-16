/**
 * PGlite adapter — in-process WASM Postgres for local dev + integration
 * tests (no server needed). Same `Db` interface as the pg adapter, so repos
 * and services are engine-agnostic.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from './types.js';

export class PgliteDb implements Db {
  private pg: PGlite;

  constructor(dataDir?: string) {
    this.pg = new PGlite(dataDir);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(sql, params as unknown[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async withTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const txDb: Db = {
        query: async <U = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const r = await tx.query<U>(sql, params as unknown[]);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
        exec: async (sql: string) => { await tx.exec(sql); },
        withTx: (nested) => nested(txDb),
        close: async () => {},
      };
      return fn(txDb);
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
