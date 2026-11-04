/**
 * A customer code must never be one a staff member already holds.
 *
 * Staff carry codes in users.code and customers in customers.customer_code,
 * both DHN####, and the two sequences count independently. Left alone the
 * customer counter eventually hands a new customer a colleague's code — and it
 * did: 26 customers who name that colleague as their referrer began showing an
 * unrelated person enrolled that morning. Seven codes were doubly held before
 * anyone noticed.
 *
 * Two halves, both tested here: the generator steps PAST staff codes from now
 * on, and migration 110 clears the ones already collided.
 *
 * The CUSTOMER always moves, never the staff member — nothing keys on a
 * customer code, while 142 customers name a staff code as their referrer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { nextCode } from '../src/lib/sequences.js';

let ctx: TestCtx;

async function staff(code: string, name: string) {
  await ctx.db.query(
    `INSERT INTO users (full_name, email, password_hash, role_id, code, is_active)
     VALUES ($1, $2, 'x', (SELECT id FROM roles WHERE name = 'branch_staff'), $3, TRUE)`,
    [name, `${code.toLowerCase()}@dhanam.finance`, code]);
}
async function customer(code: string, name: string) {
  return Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone) VALUES ($1,$2,$3) RETURNING id`,
    [name, code, '95500' + Math.floor(Math.random() * 100000)])).rows[0]!.id);
}
const codeOf = async (id: number) => String((await ctx.db.query<{ c: string }>(
  'SELECT customer_code AS c FROM customers WHERE id = $1', [id])).rows[0]!.c);

async function runMigration() {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/110_customer_codes_clear_of_staff.sql', import.meta.url)), 'utf8');
  const bare = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  // One DO block, then a reporting SELECT.
  const cut = bare.indexOf('END $$;') + 'END $$;'.length;
  await ctx.db.query(bare.slice(0, cut).trim());
}

beforeAll(async () => {
  ctx = await startTestServer();
  await ctx.db.query(
    `INSERT INTO app_settings (key, value, group_name, label)
     VALUES ('numbering.customer_format', '"DHN{seq:4}"'::jsonb, 'numbering', 'Customer code format')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});
afterAll(async () => { await ctx.close(); });

describe('the generator steps past a code staff already hold', () => {
  it('skips a staff code and issues the next free one', async () => {
    // Put the counter one short of a staff-held code.
    await ctx.db.query(
      `INSERT INTO number_sequences (key, next_value) VALUES ('customer', 7001)
       ON CONFLICT (key) DO UPDATE SET next_value = 7001`);
    await staff('DHN7001', 'A Colleague');

    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    expect(code, 'the staff-held code must be stepped over').not.toBe('DHN7001');
    expect(code).toBe('DHN7002');
  });

  it('steps past several staff codes in a row', async () => {
    await ctx.db.query("UPDATE number_sequences SET next_value = 7101 WHERE key = 'customer'");
    for (const c of ['DHN7101', 'DHN7102', 'DHN7103']) await staff(c, `Colleague ${c}`);
    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    expect(code).toBe('DHN7104');
  });

  it('leaves other sequences alone', async () => {
    // Only the customer run is filtered; an application number must not be.
    await staff('DHN7200', 'Another Colleague');
    const app = await nextCode(ctx.db, 'application', 'APP-{yyyy}-{seq:6}');
    expect(app).toMatch(/^APP-\d{4}-\d{6}$/);
  });
});

describe('migration 110 clears the codes already collided', () => {
  it('moves the CUSTOMER and leaves the staff member alone', async () => {
    await staff('DHN8001', 'Staff Keeps This');
    const cust = await customer('DHN8001', 'Customer Must Move');

    await runMigration();

    expect(await codeOf(cust), 'the customer moves').not.toBe('DHN8001');
    const staffCode = (await ctx.db.query<{ c: string }>(
      "SELECT code AS c FROM users WHERE full_name = 'Staff Keeps This'")).rows[0]!.c;
    expect(staffCode, 'the staff member keeps theirs').toBe('DHN8001');
  });

  it('gives it a code free of BOTH tables', async () => {
    await staff('DHN8100', 'Staff A');
    await staff('DHN8101', 'Staff B');   // the next number along is also staff
    const cust = await customer('DHN8100', 'Needs Two Skips');

    await runMigration();

    const moved = await codeOf(cust);
    expect(moved).not.toBe('DHN8100');
    expect(moved).not.toBe('DHN8101');
    const clash = (await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.name <> 'customer' AND upper(COALESCE(u.code,'')) = upper($1)`, [moved])).rows[0]!.n;
    expect(Number(clash)).toBe(0);
  });

  it('records every move in the audit trail', async () => {
    await staff('DHN8200', 'Audited Staff');
    const cust = await customer('DHN8200', 'Audited Customer');
    await runMigration();
    const n = (await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'customer.code_reassigned' AND entity_id = $1`, [String(cust)])).rows[0]!.n;
    expect(Number(n)).toBe(1);
  });

  it('leaves a customer whose code nobody shares untouched', async () => {
    const cust = await customer('DHN8300', 'No Collision Here');
    await runMigration();
    expect(await codeOf(cust)).toBe('DHN8300');
  });

  it('is safe to run twice', async () => {
    await staff('DHN8400', 'Twice Staff');
    const cust = await customer('DHN8400', 'Twice Customer');
    await runMigration();
    const after = await codeOf(cust);
    await runMigration();
    expect(await codeOf(cust), 'a second run must not move it again').toBe(after);
  });
});
