/**
 * Did THIS application's referrer introduce the customer in the first place?
 *
 * Owner rule (2026-08-03): the repeat rate (0.25%) exists for ONE case — a
 * customer who is already on the book, introduced by somebody else, and a
 * DIFFERENT referrer brings their next investment. That new referrer earns the
 * repeat rate. An agent's own customer coming back is not that case: the money
 * is still theirs, so they keep the full rate however many times it happens.
 *
 * What the code used to ask was `customer_was_new_at_creation` — "did this
 * customer already have an application ROW when this one was keyed in". That is
 * a question about row order, not about the business, and it got the answer
 * wrong twice over: every leg after the first of a same-day split dropped to
 * 0.25%, and so did the tail of the go-live import, where the customer had been
 * loaded minutes earlier by the same agent's own business.
 *
 * The staff side still reads `customer_was_new_at_creation` — untouched.
 */
import type { Db } from '../../db/types.js';

/** Case, spacing and punctuation are typing noise, not different people. */
export const normalizeReferrer = (s: string | null | undefined): string =>
  String(s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();

/**
 * Who introduced this customer — the referrer on their EARLIEST application
 * that names one, else the referrer on the customer record.
 *
 * Deliberately the application and not the customer first: a handover rewrites
 * `customers.referred_by_text`, and if that were the authority the new agent
 * would instantly look like the original introducer and earn the full rate on
 * business they did not bring. An application's referrer is written once at
 * insert and never edited, so it is the durable record.
 *
 * The current application is already inserted when accrual runs, so a
 * customer's first-ever investment finds ITSELF here and correctly matches.
 */
export async function originalReferrerFor(db: Db, customerId: number): Promise<string | null> {
  const { rows } = await db.query<{ origin: string | null }>(
    `SELECT coalesce(
       (SELECT nullif(btrim(x.referred_by_text), '') FROM applications x
         WHERE x.customer_id = $1 AND nullif(btrim(x.referred_by_text), '') IS NOT NULL
         ORDER BY x.created_at, x.id LIMIT 1),
       (SELECT nullif(btrim(c.referred_by_text), '') FROM customers c WHERE c.id = $1)
     ) AS origin`,
    [customerId]
  );
  return rows[0]?.origin ?? null;
}

/**
 * True when this referrer is the one who brought the customer in — i.e. the
 * new-customer rate applies. Nobody on record before means nobody is being
 * displaced, so the first person to refer them earns the full rate.
 */
export async function referrerIntroducedCustomer(
  db: Db,
  customerId: number,
  referrerName: string
): Promise<boolean> {
  const origin = await originalReferrerFor(db, customerId);
  if (!origin) return true;
  if (normalizeReferrer(origin) === normalizeReferrer(referrerName)) return true;
  // One person, typed two ways — a code on one application and a name on the
  // next ("DHN1084" vs "Guna"). Resolve both and compare the actual payee, so
  // the same human is not treated as an intruder on their own customer.
  const { resolveReferrer } = await import('../agents/service.js');
  const [a, b] = await Promise.all([resolveReferrer(db, origin), resolveReferrer(db, referrerName)]);
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}
