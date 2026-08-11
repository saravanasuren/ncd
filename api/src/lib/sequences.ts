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
export async function nextCode(
  tx: Db,
  key: SequenceKey,
  template: string = DEFAULT_NUMBER_FORMATS[key],
  year = new Date().getUTCFullYear()
): Promise<string> {
  const seq = await nextSeq(tx, key);
  return formatNumber(template, { seq, year });
}
