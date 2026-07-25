/**
 * Interest-math regression lock.
 *
 * 🔒 Values owner-confirmed 2026-07-16: pay on the 28th; each period = actual
 * calendar days between consecutive 28ths ÷ 365; first part-month = actual
 * days from receipt to the next 28th ÷ 365 (docs/02 §6).
 *
 * 🔓 Owner-confirmed 2026-07-25 (superseding the day-count of the two
 * BOUNDARY periods only — everything else above is unchanged):
 *   • Interest starts ON the day of investment — the very first period must
 *     count that day, not the day after.
 *   • Interest stops the day BEFORE a redemption or maturity — the day
 *     principal is returned is never itself a paid day.
 * Found via the NEFT summary sheet: new "Addition" rows were a day short.
 * Verified against a real redemption before the fix (P Sarasu, 24-Jul): the
 * old formula charged 26 days when it should have been 25.
 */
import { describe, it, expect } from 'vitest';
import { generateSchedule } from '../src/lib/interest.js';
import { computeRedemption } from '../src/lib/redemption.js';
import { payoutDayOfMonth, daysBetween, round2 } from '../src/lib/dates.js';

describe('date helpers (28th-of-month convention)', () => {
  it('payout day is the 28th of the invest month', () => {
    expect(payoutDayOfMonth('2026-04-15', 0)).toBe('2026-04-28');
  });
  it('next month payout also lands on the 28th', () => {
    expect(payoutDayOfMonth('2026-04-15', 1)).toBe('2026-05-28');
  });
  it('year wrap: Dec + 1 month = Jan 28 next year', () => {
    expect(payoutDayOfMonth('2026-12-15', 1)).toBe('2027-01-28');
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-04-15', '2026-04-28')).toBe(13);
    expect(daysBetween('2026-04-28', '2026-05-28')).toBe(30);
    expect(daysBetween('2026-05-28', '2026-06-28')).toBe(31);
  });
  it('round2 is plain half-up money rounding', () => {
    expect(round2(2136.9863)).toBe(2136.99);
    expect(round2(4931.5068)).toBe(4931.51);
  });
});

describe('generateSchedule — Actual365 default (28th, actual days/365)', () => {
  // ₹5L @ 12%, monthly, 36 months, invested Apr 15, deemed Apr 1.
  const s = generateSchedule(
    { amount: 500000, coupon_rate_pct: 12, payout_frequency: 'Monthly', tenure_months: 36 },
    { interestStartDate: '2026-04-15', seriesDeemedDate: '2026-04-01' }
  );

  // 14 days, not 13: daysBetween(Apr 15, Apr 28) alone is 13 (exclusive of
  // Apr 15) — the money was invested ON the 15th, so that day must count too.
  it('first row pays on the 28th, broken 14 days (Apr 15 counted, → Apr 28)', () => {
    expect(s[0]!.due_date).toBe('2026-04-28');
    expect(s[0]!.period_days).toBe(14);
    expect(s[0]!.is_broken_period).toBe(true);
  });
  it('first-row interest = 5L × 12% × 14/365 = ₹2301.37', () => {
    expect(s[0]!.gross_amount).toBeCloseTo(2301.37, 2);
  });
  it('a 30-day month = 5L × 12% × 30/365 = ₹4931.51 (regular cycle, unaffected)', () => {
    expect(s[1]!.due_date).toBe('2026-05-28');
    expect(s[1]!.period_days).toBe(30);
    expect(s[1]!.is_broken_period).toBe(false);
    expect(s[1]!.gross_amount).toBeCloseTo(4931.51, 2);
  });
  it('a 31-day month = 5L × 12% × 31/365 = ₹5095.89 (regular cycle, unaffected)', () => {
    expect(s[2]!.due_date).toBe('2026-06-28');
    expect(s[2]!.period_days).toBe(31);
    expect(s[2]!.gross_amount).toBeCloseTo(5095.89, 2);
  });
  it('principal comes back as a Redemption row on maturity (deemed + 36 months)', () => {
    const redemption = s.find((r) => r.due_type === 'Redemption');
    expect(redemption).toBeDefined();
    expect(redemption!.gross_amount).toBe(500000);
    expect(redemption!.due_date).toBe('2029-04-01');
  });
  // 3 days, not 4: the OLD count ran Mar 28 → Apr 1 inclusive of maturity day
  // itself. Maturity day doesn't earn interest — it stops the day before
  // (Mar 31), so only Mar 29/30/31 accrue.
  it('maturity broken interest stops the day BEFORE maturity: Mar 28 → Mar 31 = 3 days = ₹493.15, still paid Apr 28 2029', () => {
    const bi = s.find((r) => r.due_type === 'BrokenInterest');
    expect(bi).toBeDefined();
    expect(bi!.period_days).toBe(3);
    expect(bi!.gross_amount).toBeCloseTo(493.15, 2);
    expect(bi!.due_date).toBe('2029-04-28');
  });
  it('all monthly rows are plain Interest (no Final tag)', () => {
    const types = new Set(s.map((r) => r.due_type));
    expect(types.has('Interest')).toBe(true);
    expect([...types]).not.toContain('Final');
  });
});

describe('generateSchedule — Thirty360 remains available per-scheme (flat months)', () => {
  const quart = generateSchedule(
    {
      amount: 100000,
      coupon_rate_pct: 12,
      payout_frequency: 'Quarterly',
      tenure_months: 12,
      day_count_convention: 'Thirty360',
    },
    { interestStartDate: '2026-04-01', seriesDeemedDate: '2026-04-01' }
  );
  it('invest on the 1st → no broken period, flat 90-day quarters', () => {
    expect(quart[0]!.is_broken_period).toBe(false);
    expect(quart[0]!.period_days).toBe(90);
  });
  it('quarterly interest = 1L × 12% × 90/360 = ₹3000.00', () => {
    expect(quart[0]!.gross_amount).toBeCloseTo(3000, 2);
    expect(quart[1]!.gross_amount).toBeCloseTo(3000, 2);
  });

  // Same rule as Actual365: invest day counts. Invested on the 15th of a
  // 90-day (30-day-month) quarter → 90 - 15 + 1 = 76 days, not 75.
  const midMonth = generateSchedule(
    {
      amount: 100000,
      coupon_rate_pct: 12,
      payout_frequency: 'Quarterly',
      tenure_months: 12,
      day_count_convention: 'Thirty360',
    },
    { interestStartDate: '2026-04-15', seriesDeemedDate: '2026-04-01' }
  );
  it('invest on the 15th → broken first period = 90 - 15 + 1 = 76 days (the 15th counts)', () => {
    expect(midMonth[0]!.is_broken_period).toBe(true);
    expect(midMonth[0]!.period_days).toBe(76);
  });
});

describe('computeRedemption — broken-period interest stops the day BEFORE redemption', () => {
  it('last paid 28-Jun, redeemed 24-Jul → interest through 23-Jul = 25 days, not 26', () => {
    // Pinned against a real production redemption caught by this bug
    // (P Sarasu, APP-2026-000572, 13% p.a., ₹2,00,000): the old formula
    // produced 26 days / ₹1,852.05 by counting the redemption day itself.
    const r = computeRedemption({
      principal: 200000,
      penalty: { mode: 'flat', value: 0 },
      couponRatePct: 13,
      lastRegularPayoutDate: '2026-06-28',
      redemptionDate: '2026-07-24',
      convention: 'Actual365',
    });
    expect(daysBetween('2026-06-28', '2026-07-24')).toBe(26); // the raw (wrong) count
    // 200000 × 13% × 25/365 = ₹1,780.82
    expect(r.brokenInterest).toBeCloseTo(1780.82, 2);
  });

  it('redeemed the day after the last payout → 0 days of broken interest (nothing accrued yet)', () => {
    const r = computeRedemption({
      principal: 100000, penalty: { mode: 'flat', value: 0 }, couponRatePct: 12,
      lastRegularPayoutDate: '2026-07-28', redemptionDate: '2026-07-29', convention: 'Actual365',
    });
    // Stops the day before redemption (28-Jul) — the same day it was last
    // paid through — so zero new days have accrued.
    expect(r.brokenInterest).toBe(0);
  });
});
