/**
 * migrate-legacy/source.ts — the read side of the ETL.
 *
 * `LegacySource` is the contract the pipeline reads through. Two implementations:
 *   - PgLegacySource      : the REAL old database (a pg_restore of the prod dump
 *                           into a LOCAL Postgres), read over LEGACY_DATABASE_URL.
 *   - SyntheticLegacySource (synthetic.ts): hand-built fake rows, no DB, used to
 *                           prove the pipeline end-to-end without touching real data.
 *
 * The pipeline never assumes exact old column names beyond the few that are
 * structurally load-bearing; PgLegacySource does `SELECT *` per table and the
 * pipeline reads columns defensively (name ?? fallback). That tolerates the old
 * schema's 77-migration sprawl and the two dual-definition tables.
 */

/** A legacy row is just an untyped bag of columns. */
export type Row = Record<string, any>;

export interface LegacySource {
  /** Human label for the report header (e.g. connection target, "synthetic"). */
  label(): string;
  roles(): Promise<Row[]>;
  branches(): Promise<Row[]>;
  users(): Promise<Row[]>;
  agents(): Promise<Row[]>;
  banks(): Promise<Row[]>;
  tdsRules(): Promise<Row[]>;
  holidays(): Promise<Row[]>;
  companyProfile(): Promise<Row[]>;
  schemes(): Promise<Row[]>;
  series(): Promise<Row[]>;
  seriesSchemes(): Promise<Row[]>;
  leads(): Promise<Row[]>;
  customers(): Promise<Row[]>;
  customerBankAccounts(): Promise<Row[]>;
  nominees(): Promise<Row[]>;
  jointHolders(): Promise<Row[]>;
  applications(): Promise<Row[]>;
  applicationLines(): Promise<Row[]>;
  schedule(): Promise<Row[]>;
  redemptions(): Promise<Row[]>;
  /** Referrer / staff incentive accruals, normalised into one stream. */
  incentiveAccruals(): Promise<Row[]>;
  close(): Promise<void>;
}

/**
 * Real old database, read-only. Requires `pg` and LEGACY_DATABASE_URL pointing at
 * a RESTORE of the prod dump on the owner's local machine (never prod directly).
 */
export class PgLegacySource implements LegacySource {
  private pool: any;
  private tableCache = new Map<string, boolean>();

  constructor(private connectionString: string) {}

  private async pool_() {
    if (!this.pool) {
      const { Pool } = await import('pg');
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    }
    return this.pool;
  }

  label() {
    // Never print credentials — just the host/db.
    try {
      const u = new URL(this.connectionString);
      return `postgres ${u.host}${u.pathname}`;
    } catch {
      return 'postgres (legacy)';
    }
  }

  private async tableExists(name: string): Promise<boolean> {
    if (this.tableCache.has(name)) return this.tableCache.get(name)!;
    const pool = await this.pool_();
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    const exists = r.rows.length > 0;
    this.tableCache.set(name, exists);
    return exists;
  }

  /** SELECT * from an optional table; missing table → []. */
  private async all(table: string, orderBy = 'id'): Promise<Row[]> {
    if (!(await this.tableExists(table))) return [];
    const pool = await this.pool_();
    // Order by id when present for deterministic output; fall back to no order.
    try {
      const r = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      return r.rows;
    } catch {
      const r = await pool.query(`SELECT * FROM ${table}`);
      return r.rows;
    }
  }

  roles() { return this.all('roles'); }
  branches() { return this.all('branches'); }
  users() { return this.all('users'); }
  agents() { return this.all('agents'); }
  banks() { return this.all('banks'); }
  tdsRules() { return this.all('tds_rules'); }
  holidays() { return this.all('holidays', 'holiday_date'); }
  companyProfile() { return this.all('company_profile'); }
  schemes() { return this.all('schemes'); }
  series() { return this.all('series'); }
  seriesSchemes() { return this.all('series_schemes'); }
  leads() { return this.all('investor_leads'); }
  customers() { return this.all('customers'); }
  customerBankAccounts() { return this.all('customer_bank_accounts'); }
  nominees() { return this.all('nominees'); }
  jointHolders() { return this.all('joint_holders'); }
  applications() { return this.all('applications'); }
  applicationLines() { return this.all('application_lines'); }
  schedule() { return this.all('disbursement_schedule'); }
  redemptions() { return this.all('redemptions'); }

  /** Merge staff incentive_accruals + referrer_incentive_accruals into one
   * stream tagged by payee_type, so the loader writes a single ledger table. */
  async incentiveAccruals(): Promise<Row[]> {
    const out: Row[] = [];
    if (await this.tableExists('incentive_accruals')) {
      for (const r of await this.all('incentive_accruals')) {
        out.push({ ...r, _payee_type: 'staff', _payee_ref: r.user_id });
      }
    }
    if (await this.tableExists('commission_accruals')) {
      for (const r of await this.all('commission_accruals')) {
        // agent_id present → agent payee.
        const agentId = r.agent_id ?? r.referrer_agent_id;
        if (agentId) out.push({ ...r, _payee_type: 'agent', _payee_ref: agentId });
      }
    }
    if (await this.tableExists('referrer_incentive_accruals')) {
      for (const r of await this.all('referrer_incentive_accruals')) {
        out.push({ ...r, _payee_type: 'referrer', _payee_ref: r.referrer_name_norm });
      }
    }
    return out;
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}
