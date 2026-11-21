/**
 * The Doubling product — a cumulative holding that pays nothing until maturity.
 *
 * WHY THIS FILE EXISTS. 'AtMaturity' was in the scheme row and in ten live
 * lines but never in the PayoutFrequency union, so generateSchedule fell off
 * the end of its if/else and returned no rows at all. Rs 1.08 crore with
 * nothing scheduled, no maturity date stamped, and a maturity redemption that
 * hard-coded its interest to zero — against certificates promising double.
 *
 * The figures below are the REAL ten from production (2026-11-21), not made
 * up, so the test fails if the money ever moves.
 *
 * Rows are keyed by APPLICATION NUMBER, never by holder name — the figures
 * need to be the real ones to be worth pinning, the names do not.
 */
import { describe, it, expect } from 'vitest';
import { generateSchedule, cumulativeMaturityValue } from '../src/lib/interest.js';
import { redemptionValue } from '../src/modules/reports/forms/bond.js';

const DOUBLING = { ratePct: 20, tenureMonths: 60, convention: 'Actual365' as const };

/** app, principal, money-in, series deemed date, broken days, broken interest, total. */
const THE_TEN: [string, number, string, string, number, number, number][] = [
  ['APP-2026-001270',  100000, '2026-10-05', '2026-10-31', 26,  1424.66,  201424.66],
  ['APP-2026-001271',  500000, '2026-10-01', '2026-10-31', 30,  8219.18, 1008219.18],
  ['APP-2026-001272', 1500000, '2026-10-03', '2026-10-31', 28, 23013.70, 3023013.70],
  ['APP-2026-001274', 2100000, '2026-08-29', '2026-08-31',  2,  2301.37, 4202301.37],
  ['APP-2026-001275', 1100000, '2026-08-29', '2026-08-31',  2,  1205.48, 2201205.48],
  ['APP-2026-001276', 1800000, '2026-10-03', '2026-10-31', 28, 27616.44, 3627616.44],
  ['APP-2026-001277', 1700000, '2026-08-29', '2026-08-31',  2,  1863.01, 3401863.01],
  ['APP-2026-001322',  500000, '2026-10-22', '2026-10-31',  9,  2465.75, 1002465.75],
  ['APP-2026-001367',  500000, '2026-11-05', '2026-11-30', 25,  6849.32, 1006849.32],
  ['APP-2026-001389', 1000000, '2026-11-12', '2026-11-30', 18,  9863.01, 2009863.01],
];

describe('what a Doubling holding is worth at maturity', () => {
  it.each(THE_TEN)('%s — %d doubles, plus the days before the term began',
    (_app, principal, money, deemed, days, broken, total) => {
      const v = cumulativeMaturityValue({
        principal, ...DOUBLING, interestStartDate: money, seriesDeemedDate: deemed,
      });
      expect(v.term).toBe(principal);        // 20% x 5 years = exactly 100%
      expect(v.brokenDays).toBe(days);
      expect(v.broken).toBe(broken);
      expect(v.total).toBe(total);
    });

  it('the ten together come to Rs 2,16,84,821.92', () => {
    const total = THE_TEN.reduce((s, [, principal, money, deemed]) =>
      s + cumulativeMaturityValue({ principal, ...DOUBLING, interestStartDate: money, seriesDeemedDate: deemed }).total, 0);
    expect(Math.round(total * 100) / 100).toBe(21684821.92);
  });

  it('the term is the CERTIFICATE formula, not a day count', () => {
    // Actual365 over five years picks up the 2028 leap day and would pay
    // ~Rs 1,150 more per Rs 21,00,000 than the document promises. The owner
    // chose the certificate's own arithmetic (2026-11-21).
    const v = cumulativeMaturityValue({ principal: 2100000, ...DOUBLING,
      interestStartDate: '2026-08-31', seriesDeemedDate: '2026-08-31' });
    expect(v.term).toBe(2100000);
    expect(v.brokenDays).toBe(0);
    expect(v.total).toBe(4200000);           // exactly double, to the rupee
  });

  it('money that arrived LATE is never charged back against the term', () => {
    // The certificate promises the full term. Shaving it for a late credit is
    // the one error that cannot be defended to a holder.
    const v = cumulativeMaturityValue({ principal: 1000000, ...DOUBLING,
      interestStartDate: '2026-12-10', seriesDeemedDate: '2026-11-30' });
    expect(v.brokenDays).toBe(0);
    expect(v.broken).toBe(0);
    expect(v.total).toBe(2000000);
  });

  it('refuses to invent a number from an unreadable rate or tenure', () => {
    for (const bad of [{ ratePct: 0 }, { ratePct: NaN }, { tenureMonths: 0 }, { tenureMonths: NaN }]) {
      const v = cumulativeMaturityValue({ principal: 500000, ...DOUBLING, ...bad,
        interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31' });
      expect(v.interest).toBe(0);
      expect(v.total).toBe(500000);          // principal back, nothing conjured
    }
  });
});

describe('the schedule a Doubling line generates', () => {
  const sched = (over: Record<string, unknown> = {}) => generateSchedule(
    { amount: 2100000, coupon_rate_pct: 20, payout_frequency: 'AtMaturity',
      tenure_months: 60, day_count_convention: 'Actual365', ...over } as never,
    { interestStartDate: '2026-08-29', seriesDeemedDate: '2026-08-31', holidays: [] });

  it('is ONE combined row on the maturity date, not nothing', () => {
    // Before this it was literally []: no rows, which is why the maturity date
    // was never stamped either (materialize reads it off the Redemption row).
    const rows = sched();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.due_type).toBe('Redemption');
    expect(rows[0]!.due_date).toBe('2031-08-31');
    expect(rows[0]!.gross_amount).toBe(4202301.37);
  });

  it('carries principal AND the whole interest, never principal alone', () => {
    // The failure mode that would have paid Rs 21,00,000 on a Rs 42,00,000
    // certificate. Pinned explicitly so it cannot come back.
    expect(sched()[0]!.gross_amount).toBeGreaterThan(2100000 * 1.99);
  });
});

describe('nothing else moves', () => {
  it('a Monthly line schedules exactly as it always did', () => {
    const rows = generateSchedule(
      { amount: 1000000, coupon_rate_pct: 13, payout_frequency: 'Monthly',
        tenure_months: 36, day_count_convention: 'Actual365' } as never,
      { interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31', holidays: [] });
    expect(rows.filter((r) => r.due_type === 'Interest').length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.due_type === 'Redemption')).toHaveLength(1);
    // Principal back on its own, because the interest was paid out monthly.
    expect(rows.find((r) => r.due_type === 'Redemption')!.gross_amount).toBe(1000000);
  });

  it('the certificate still prints exactly double, with no broken days on it', () => {
    // 187 certificates are already issued and rendering one MINTS a number.
    // Sharing the formula must not have moved what they say.
    expect(redemptionValue(2100000, 20, 60, 'AtMaturity')).toBe(4200000);
    expect(redemptionValue(100000, 20, 60, 'AtMaturity')).toBe(200000);
    // A periodic holding gets its principal back and nothing more.
    expect(redemptionValue(2100000, 13, 36, 'Monthly')).toBe(2100000);
    // Unreadable inputs still fall back to the principal.
    expect(redemptionValue(2100000, 0, 60, 'AtMaturity')).toBe(2100000);
  });
});
