/**
 * Row-locked sequence allocator → formatted human-readable codes
 * (docs/02 §6). Never MAX()+1. Must be called inside a transaction so the
 * SELECT … FOR UPDATE holds until commit.
 */
import type { Db } from '../db/types.js';
import { formatNumber, DEFAULT_NUMBER_FORMATS } from './numbering.js';

export type SequenceKey = keyof typeof DEFAULT_NUMBER_FORMATS;

/**
 * Is this a Postgres unique-violation (SQLSTATE 23505)?
 *
 * Callers that allocate a human-visible number use this to tell "that number is
 * already taken, take the next one" apart from a real failure. The code is
 * checked first; the message is a fallback because the error crosses a driver
 * boundary (pg in production, PGlite in tests) and only the code is guaranteed
 * to survive both.
 */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '23505') return true;
  return /duplicate key value|unique constraint/i.test(String(err?.message ?? ''));
}

/** Allocate the next sequence value for `key` (creates the row if absent). */
export async function nextSeq(tx: Db, key: string): Promise<number> {
  const upsert = await tx.query<{ next_value: string }>(
    `INSERT INTO number_sequences (key, next_value) VALUES ($1, 2)
     ON CONFLICT (key) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value`,
    [key]
  );
  // On first insert next_value becomes 2 and we return 1; on conflict we
  // bumped to N+1 and return N.
  const stored = Number(upsert.rows[0]!.next_value);
  return stored - 1;
}

/**
 * Allocate and format an id, e.g. `nextCode(tx, 'application', 'APP-{yyyy}-{seq:6}')`.
 * The template comes from settings (`numbering.*`); the default is passed as
 * a fallback so a missing setting can't hardcode a format silently.
 */
/**
 * How many numbers we will step past before giving up. Only ever consumed when
 * a candidate is already held by a member of staff or another customer; 50 is
 * far more than the 15 staff codes currently sitting above the customer
 * counter, and more than any run of codes a repair has moved forward.
 */
const MAX_CODE_SKIPS = 50;

export async function nextCode(
  tx: Db,
  key: SequenceKey,
  template: string = DEFAULT_NUMBER_FORMATS[key],
  year = new Date().getUTCFullYear()
): Promise<string> {
  const seq = await nextSeq(tx, key);
  const code = formatNumber(template, { seq, year });
  if (key !== 'customer') return code;

  // STAFF AND CUSTOMERS SHARE THE DHN#### SPACE. Staff carry codes in
  // users.code and customers in customers.customer_code, and the two sequences
  // count independently — so the customer counter will, left alone, eventually
  // hand a new customer a code a colleague already holds.
  //
  // It did. On 2026-11-03 it reached a staff member's code and 26 customers who
  // name that colleague as their referrer began displaying an unrelated person
  // enrolled that morning. Seven codes were already doubly held before anyone
  // noticed, and 15 more staff codes sit above the counter waiting their turn.
  //
  // So the customer run steps PAST anything staff already hold. Owner's call
  // (2026-11-03): "u should not assign a customer code whose code is already
  // with a staff". Customer codes are safe to skip — nothing keys on them, the
  // real identity is the row id — whereas staff codes cannot move, because 142
  // customers name a staff code as their referrer.
  // A code already worn by another CUSTOMER is skipped too. customer_code is
  // uniquely indexed and nothing retries a duplicate on the enrolment path, so
  // a counter sitting behind the codes in use would 500 the next enrolment —
  // which is exactly what happened when migration 110 moved seven customers
  // forward to clear staff codes and left the counter where it was. Asking the
  // table rather than trusting the counter removes the whole class of drift,
  // however it arises: a repair, a restored backup, a hand-typed code.
  let candidate = code;
  for (let skipped = 0; skipped < MAX_CODE_SKIPS; skipped++) {
    const clash = (await tx.query<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id
           WHERE r.name <> 'customer' AND upper(COALESCE(u.code,'')) = upper($1))
       + (SELECT count(*) FROM customers c WHERE upper(c.customer_code) = upper($1))
       )::int AS n`, [candidate])).rows[0];
    if (!Number(clash?.n ?? 0)) return candidate;
    candidate = formatNumber(template, { seq: await nextSeq(tx, key), year });
  }
  throw new Error(`could not find an unused customer code after ${MAX_CODE_SKIPS} attempts`);
}
