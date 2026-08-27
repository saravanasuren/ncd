/**
 * A super-admin hard delete FORCE deletes (owner 2026-08-27): "it should force
 * delete if I delete a customer, regardless of if they are having any
 * investments or lockers."
 *
 * This exists because it didn't. purge.ts cleared a hardcoded list of dependent
 * tables; `locker_authorised_users` was added in August, nobody added it to the
 * list, and on 2026-08-27 a production delete of DHN0730 died with
 *   violates foreign key constraint "locker_authorised_users_customer_id_fkey"
 * and rolled back. The first test below is that exact failure.
 *
 * The rule the fix applies to anything still pointing at the customer:
 *   nullable column -> SET NULL, so a record owned by another subsystem lives on
 *   NOT NULL        -> the row cannot exist without its parent, so it goes
 * discovered from the catalogue, so a table added tomorrow is handled tomorrow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function customerWithInvestment(sa: Client, name: string, phone: string) {
  const cust = await sa.post('/api/customers', { full_name: name, phone });
  const app = await sa.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
  return { custId: Number(cust.json.id), appId: Number(app.json.id) };
}

describe('force delete a customer', () => {
  it('deletes a customer who is an authorised user on a locker — the production failure', async () => {
    const sa = await superAdmin();
    const { custId } = await customerWithInvestment(sa, 'Locker Linked', '9700066601');
    await ctx.db.query(
      `INSERT INTO locker_authorised_users (lockerhub_application_id, customer_id, name)
       VALUES ('LH-TEST-1', $1, 'Authorised Person')`, [custId]);

    const res = await sa.del(`/api/customers/${custId}`, { confirm: true, reason: 'test record' });
    expect(res.status).toBe(200);                       // used to be a 500 FK violation
    expect(Number((await ctx.db.query('SELECT count(*)::int c FROM customers WHERE id = $1', [custId])).rows[0]!.c)).toBe(0);
    // ...and the blocking row went with it (customer_id is nullable, so the row
    // survives unlinked rather than being destroyed).
    expect(Number((await ctx.db.query(
      'SELECT count(*)::int c FROM locker_authorised_users WHERE customer_id = $1', [custId])).rows[0]!.c)).toBe(0);
  });

  it('keeps a bank statement line on the books, merely unmatched', async () => {
    const sa = await superAdmin();
    const { custId } = await customerWithInvestment(sa, 'Escrow Matched', '9700066602');
    const stmt = await ctx.db.query<{ id: string }>(
      `INSERT INTO escrow_statements (account_number, source_file) VALUES ('ESCROW-1', 'test.xls') RETURNING id`);
    const stmtId = Number(stmt.rows[0]!.id);
    const line = await ctx.db.query<{ id: string }>(
      `INSERT INTO escrow_statement_lines (statement_id, value_date, amount, matched_customer_id)
       VALUES ($1, '2026-07-01', 100000, $2) RETURNING id`, [stmtId, custId]);
    const lineId = Number(line.rows[0]!.id);

    expect((await sa.del(`/api/customers/${custId}`, { confirm: true, reason: 'test record' })).status).toBe(200);

    // Financial evidence must survive a customer purge — it belongs to the bank
    // statement, not to the customer. It is unmatched, not deleted.
    const row = (await ctx.db.query<{ matched_customer_id: string | null }>(
      'SELECT matched_customer_id FROM escrow_statement_lines WHERE id = $1', [lineId])).rows[0];
    expect(row).toBeDefined();
    expect(row!.matched_customer_id).toBeNull();
  });

  it('still deletes when a table nobody has heard of points at the customer', async () => {
    // The whole point of the fix: this test creates a dependent table AFTER the
    // code was written, exactly as a future migration would. If someone replaces
    // the catalogue lookup with another hardcoded list, this fails.
    const sa = await superAdmin();
    const { custId } = await customerWithInvestment(sa, 'Future Table', '9700066603');
    await ctx.db.query(
      `CREATE TABLE IF NOT EXISTS a_table_added_next_year (
         id BIGSERIAL PRIMARY KEY,
         customer_id BIGINT NOT NULL REFERENCES customers(id))`);
    await ctx.db.query('INSERT INTO a_table_added_next_year (customer_id) VALUES ($1)', [custId]);

    expect((await sa.del(`/api/customers/${custId}`, { confirm: true, reason: 'test record' })).status).toBe(200);
    // NOT NULL, so the row cannot outlive its customer — it is deleted, not nulled.
    expect(Number((await ctx.db.query(
      'SELECT count(*)::int c FROM a_table_added_next_year WHERE customer_id = $1', [custId])).rows[0]!.c)).toBe(0);
    await ctx.db.query('DROP TABLE a_table_added_next_year');
  });

  it('records in the audit trail what the force delete swept up', async () => {
    const sa = await superAdmin();
    const { custId } = await customerWithInvestment(sa, 'Audit Swept', '9700066604');
    await ctx.db.query(
      `INSERT INTO locker_authorised_users (lockerhub_application_id, customer_id, name)
       VALUES ('LH-TEST-2', $1, 'Someone')`, [custId]);

    expect((await sa.del(`/api/customers/${custId}`, { confirm: true, reason: 'test record' })).status).toBe(200);

    const audit = (await ctx.db.query<{ after_data: unknown }>(
      `SELECT after_data FROM audit_log WHERE action = 'customer.hard_delete' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`, [String(custId)])).rows[0];
    expect(audit).toBeDefined();
    const cleared = (audit!.after_data as { cleared?: Record<string, number> }).cleared ?? {};
    // A silent sweep would be worse than a failure — you could never tell what a
    // purge took with it.
    expect(cleared['locker_authorised_users.customer_id']).toBe(1);
  });

  it('a plain admin still cannot force delete anything', async () => {
    const sa = await superAdmin();
    const admin = await as('admin@demo.local');
    const { custId } = await customerWithInvestment(sa, 'Still Guarded', '9700066605');
    expect((await admin.del(`/api/customers/${custId}`, { confirm: true, reason: 'nope' })).status).toBe(403);
    expect(Number((await ctx.db.query('SELECT count(*)::int c FROM customers WHERE id = $1', [custId])).rows[0]!.c)).toBe(1);
  });
});
