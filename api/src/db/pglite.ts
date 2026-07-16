/**
 * PGlite adapter — in-process WASM Postgres for local dev + integration
 * tests (no server needed). Same `Db` interface as the pg adapter, so repos
 * and services are engine-agnostic.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from './types.js';

// NOTE: PGlite returns DATE/TIMESTAMP columns as JS Date objects, whereas
// node-postgres (prod) returns strings. Date math in the money code goes
// through `toISODate()` (lib/dates) so both engines behave identically.

const DATE_OID = 1082;
const TS_OIDS = new Set([1114, 1184]); // timestamp, timestamptz

/** Make PGlite rows match node-postgres output: DATE → 'YYYY-MM-DD',
 * TIMESTAMP → ISO string, BigInt → string (JSON-safe). */
function normalizeRows<T>(result: { rows: T[]; fields?: Array<{ name: string; dataTypeID: number }> }): T[] {
  const fields = result.fields ?? [];
  if (!fields.length) return result.rows;
  const typeByName = new Map(fields.map((f) => [f.name, f.dataTypeID]));
  return result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (v instanceof Date) {
        const t = typeByName.get(k);
        out[k] = t === DATE_OID ? v.toISOString().slice(0, 10) : TS_OIDS.has(t ?? -1) ? v.toISOString() : v.toISOString();
      } else if (typeof v === 'bigint') {
        out[k] = v.toString();
      } else {
        out[k] = v;
      }
    }
    return out as T;
  });
}

export class PgliteDb implements Db {
  private pg: PGlite;

  constructor(dataDir?: string) {
    this.pg = new PGlite(dataDir);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(sql, params as unknown[]);
    // PGlite reports affectedRows=0 for SELECT, so prefer rows.length when
    // rows are present (matches node-postgres rowCount semantics).
    return { rows: normalizeRows(r), rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async withTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const txDb: Db = {
        query: async <U = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const r = await tx.query<U>(sql, params as unknown[]);
          return { rows: normalizeRows(r), rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
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
