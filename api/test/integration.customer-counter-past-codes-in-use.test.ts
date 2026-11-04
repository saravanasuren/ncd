/**
 * The customer counter must never hand out a code someone already wears.
 *
 * customers.customer_code is uniquely indexed and nothing retries a duplicate
 * on the enrolment path, so a counter standing behind the codes in use fails
 * the enrolment outright. That is not hypothetical: migration 110 moved seven
 * customers forward off staff codes and left the counter where it was, which
 * would have 500'd the next customer created.
 *
 * Two halves again: the generator asks the TABLE rather than trusting the
 * counter, and migration 111 closes the gap 110 opened.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { nextCode } from '../src/lib/sequences.js';

let ctx: TestCtx;

async function customer(code: string, name: string) {
  return Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone) VALUES ($1,$2,$3) RETURNING id`,
    [name, code, '96600' + Math.floor(Math.random() * 100000)])).rows[0]!.id);
}
async function staff(code: string, name: string) {
  await ctx.db.query(
    `INSERT INTO users (full_name, email, password_hash, role_id, code, is_active)
     VALUES ($1, $2, 'x', (SELECT id FROM roles WHERE name = 'branch_staff'), $3, TRUE)`,
    [name, `${code.toLowerCase()}-ctr@dhanam.finance`, code]);
}
const setCounter = (n: number) => ctx.db.query(
  `INSERT INTO number_sequences (key, next_value) VALUES ('customer', $1)
   ON CONFLICT (key) DO UPDATE SET next_value = $1`, [n]);
const counter = async () => Number((await ctx.db.query<{ v: string }>(
  "SELECT next_value AS v FROM number_sequences WHERE key = 'customer'")).rows[0]!.v);

async function runMigration() {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/111_customer_counter_past_the_codes_in_use.sql', import.meta.url)), 'utf8');
  const bare = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  await ctx.db.query(bare.trim());
}

beforeAll(async () => {
  ctx = await startTestServer();
  await ctx.db.query(
    `INSERT INTO app_settings (key, value, group_name, label)
     VALUES ('numbering.customer_format', '"DHN{seq:4}"'::jsonb, 'numbering', 'Customer code format')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});
afterAll(async () => { await ctx.close(); });

describe('the generator asks the table, not just the counter', () => {
  it('steps past a code another customer already wears', async () => {
    // Exactly the shape migration 110 left behind: the counter sits on a code
    // a customer was moved onto.
    await customer('DHN9001', 'Already Wearing It');
    await setCounter(9001);

    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    expect(code, 'must not re-issue a code in use').not.toBe('DHN9001');
    expect(code).toBe('DHN9002');
  });

  it('steps past a whole run of moved customers', async () => {
    for (const n of [9101, 9102, 9103, 9104]) await customer(`DHN${n}`, `Moved ${n}`);
    await setCounter(9101);
    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    expect(code).toBe('DHN9105');
  });

  it('steps past staff AND customers together', async () => {
    await customer('DHN9201', 'Customer Here');
    await staff('DHN9202', 'Staff Here');
    await setCounter(9201);
    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    expect(code).toBe('DHN9203');
  });

  it('the code it returns can actually be inserted', async () => {
    // The real proof: unique index and all.
    await customer('DHN9301', 'Occupant');
    await setCounter(9301);
    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    await expect(customer(code, 'New Enrolment')).resolves.toBeGreaterThan(0);
  });
});

describe('migration 111 realigns a counter left behind', () => {
  it('moves the counter past the highest code in use', async () => {
    await customer('DHN9401', 'High Water Mark');
    await setCounter(9390);
    await runMigration();
    expect(await counter()).toBe(9402);
  });

  it('never pulls the counter backwards', async () => {
    // A counter ahead of the book stays where it is — a lower one would
    // re-issue codes already printed on acknowledgements.
    await setCounter(9900);
    await runMigration();
    expect(await counter()).toBe(9900);
  });

  it('leaves the next code free to use', async () => {
    await customer('DHN9501', 'Another Occupant');
    await setCounter(9501);
    await runMigration();
    const code = await nextCode(ctx.db, 'customer', 'DHN{seq:4}');
    await expect(customer(code, 'Enrols Fine')).resolves.toBeGreaterThan(0);
  });

  it('is safe to run twice', async () => {
    await runMigration();
    const after = await counter();
    await runMigration();
    expect(await counter()).toBe(after);
  });
});
