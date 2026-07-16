/**
 * Database abstraction (docs/01 §4). One interface, two implementations:
 * `pg` (production Postgres) and `pglite` (in-process WASM Postgres for dev
 * + integration tests). Repos depend only on this interface.
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  /** Parameterised query. Params use $1, $2, … placeholders (single statement). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a raw multi-statement SQL script (DDL / migrations). No params. */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction; commits on resolve, rolls back on throw. */
  withTx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Close the pool/instance. */
  close(): Promise<void>;
}
