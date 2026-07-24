/**
 * Date helpers for the interest engine — UTC-based, 'YYYY-MM-DD' strings.
 * Ported verbatim (behaviour-preserving) from the old app's schedule.js.
 * All business dates are handled as calendar dates, never local timestamps.
 */

export type ISODate = string; // 'YYYY-MM-DD'

/** 365 or 366 for the year containing dateStr. */
export function daysInYear(dateStr: ISODate): number {
  const yr = new Date(dateStr + 'T00:00:00Z').getUTCFullYear();
  return (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0 ? 366 : 365;
}

/** Add whole months, clamping the day to the target month's last day. */
export function addMonths(dateStr: ISODate, months: number): ISODate {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/**
 * The payout date = `payoutDay`-th of (anchor + monthsOffset). For months
 * without that day (e.g. Feb has no 30th), falls back to the month's last
 * day. Default payoutDay is 30 (production convention).
 */
export function payoutDayOfMonth(
  anchorDate: ISODate,
  monthsOffset: number,
  payoutDay = 28
): ISODate {
  const d = new Date(anchorDate + 'T00:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsOffset);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(payoutDay, last));
  return d.toISOString().slice(0, 10);
}

/**
 * First payout date STRICTLY AFTER `dateStr` — used by the maturity
 * broken-interest rule. If the current month's payout day hasn't passed,
 * use it; otherwise roll to next month.
 */
export function nextPayoutAfter(dateStr: ISODate, payoutDay = 28): ISODate {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const targetThisMonth = Math.min(payoutDay, last);
  if (day < targetThisMonth) {
    d.setUTCDate(targetThisMonth);
  } else {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last2 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(payoutDay, last2));
  }
  return d.toISOString().slice(0, 10);
}

/** Shift a date backward to the previous working day if weekend/holiday. */
export function adjustForHoliday(dateStr: ISODate, holidaySet: Set<string>): ISODate {
  if (!holidaySet || holidaySet.size === 0) return dateStr;
  const d = new Date(dateStr + 'T00:00:00Z');
  for (let attempts = 0; attempts < 10; attempts++) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidaySet.has(iso)) return iso;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dateStr;
}

/** Whole calendar days between two dates. */
export function daysBetween(d1Str: ISODate, d2Str: ISODate): number {
  const d1 = new Date(d1Str + 'T00:00:00Z');
  const d2 = new Date(d2Str + 'T00:00:00Z');
  return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}

/** Shift an ISO date by whole days (negative to go back). */
export function addDays(dateStr: ISODate, days: number): ISODate {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Half-up money rounding to 2 decimals (returns a number). */
export function round2(v: number): number {
  return Math.round(Number(v) * 100) / 100;
}

/** Day-of-month (UTC) of an ISO date. */
export function dayOfMonth(dateStr: ISODate): number {
  return new Date(dateStr + 'T00:00:00Z').getUTCDate();
}

/**
 * Normalise a DB date value to 'YYYY-MM-DD'. node-postgres returns strings,
 * PGlite returns Date objects — this handles both (and full ISO strings).
 */
export function toISODate(v: string | Date | null | undefined): ISODate | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
