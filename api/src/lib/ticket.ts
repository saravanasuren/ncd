/**
 * Investment ticket rule (owner spec 2026-07-23): NCDs are issued in whole
 * units of ₹1,00,000 — so an investment must be at least one unit and an exact
 * multiple of one.
 *
 * The numbers are NOT hardcoded: `schemes.min_ticket` and `schemes.multiple_of`
 * have carried them since 001_core.sql (both default 100000) — they were simply
 * never read. Enforcing what the scheme already declares means a future scheme
 * with a different denomination works without a code change.
 *
 * Enforced at the two points that matter:
 *   1. staff create — reject the typo at the door;
 *   2. approval     — nothing goes LIVE off-denomination, whatever the source.
 * Deliberately NOT enforced on the inbound LockerHub writes (B12/B18): those
 * land as PendingApproval, so the approval gate above catches them without
 * breaking a partner's live call.
 */
import type { Db } from '../db/types.js';
import { errors } from './errors.js';

export interface TicketRule { min: number; multiple: number }

const DEFAULTS: TicketRule = { min: 100000, multiple: 100000 };

/** The scheme's ticket rule (falls back to ₹1L/₹1L when unset). */
export async function ticketRule(db: Db, schemeId: number | null | undefined): Promise<TicketRule> {
  if (!schemeId) return DEFAULTS;
  const r = (await db.query<{ min_ticket: string | null; multiple_of: string | null }>(
    'SELECT min_ticket, multiple_of FROM schemes WHERE id = $1', [schemeId])).rows[0];
  if (!r) return DEFAULTS;
  const min = Number(r.min_ticket);
  const multiple = Number(r.multiple_of);
  return {
    min: Number.isFinite(min) && min > 0 ? min : DEFAULTS.min,
    multiple: Number.isFinite(multiple) && multiple > 0 ? multiple : DEFAULTS.multiple,
  };
}

const inr = (n: number) => '₹' + n.toLocaleString('en-IN');

/** Throw 400 unless `amount` is a whole number of units at or above the minimum. */
export function assertTicket(amount: number, rule: TicketRule): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw errors.badRequest('Investment amount must be greater than zero');
  }
  if (amount < rule.min) {
    throw errors.badRequest(`Minimum investment is ${inr(rule.min)}. ${inr(amount)} is below it.`);
  }
  // Paise can't survive a whole-unit rule, so compare in integer paise to keep
  // floating point out of it.
  if (Math.round(amount * 100) % Math.round(rule.multiple * 100) !== 0) {
    const below = Math.floor(amount / rule.multiple) * rule.multiple;
    throw errors.badRequest(
      `Investments are issued in units of ${inr(rule.multiple)} — ${inr(amount)} is not a whole number of units. Use ${inr(below)} or ${inr(below + rule.multiple)}.`
    );
  }
}

/** Convenience: look the rule up and assert in one call. */
export async function assertValidTicket(db: Db, schemeId: number | null | undefined, amount: number): Promise<void> {
  assertTicket(amount, await ticketRule(db, schemeId));
}
