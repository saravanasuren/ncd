/**
 * Interest-math regression lock — ported from the old app's
 * test/schedule.test.js. These exact values are the CONTRACT (docs/02 §6).
 */
import { describe, it, expect } from 'vitest';
import { generateSchedule } from '../src/lib/interest.js';
import {
  payoutDayOfMonth,
  daysBetween,
  round2,
} from '../src/lib/dates.js';

describe('date helpers (30th-of-month convention)', () => {
  it('payout day is the 30th of the invest month', () => {
    expect(payoutDayOfMonth('2026-04-15', 0)).toBe('2026-04-30');
  });
  it('next month payout also lands on the 30th', () => {
    expect(payoutDayOfMonth('2026-04-15', 1)).toBe('2026-05-30');
  });
  it('year wrap: Dec + 1 month = Jan 30 next year', () => {
    expect(payoutDayOfMonth('2026-12-15', 1)).toBe('2027-01-30');
  });
  it('February (no 30th) falls back to the last day', () => {
    expect(payoutDayOfMonth('2026-01-15', 1)).toBe('2026-02-28');
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-04-15', '2026-04-30')).toBe(15);
    expect(daysBetween('2026-04-30', '2026-05-30')).toBe(30);
  });
  it('round2 is plain half-up money rounding', () => {
    expect(round2(541.66667)).toBe(541.67);
    expect(round2(1083.33333)).toBe(1083.33);
  });
});

describe('generateSchedule — Thirty360 default (Dhanam convention)', () => {
  // Ramesh: ₹5L @ 10%, monthly, 36 months, invested Apr 15, deemed Apr 1.
  const ramesh = generateSchedule(
    { amount: 500000, coupon_rate_pct: 10, payout_frequency: 'Monthly', tenure_months: 36 },
    { interestStartDate: '2026-04-15', seriesDeemedDate: '2026-04-01' }
  );

  it('first row is a broken period of (30 − invest_day) = 15 days', () => {
    expect(ramesh[0]!.is_broken_period).toBe(true);
    expect(ramesh[0]!.period_days).toBe(15);
  });
  it('first-row interest = 5L × 10% × 15/360 = ₹2083.33', () => {
    expect(ramesh[0]!.gross_amount).toBeCloseTo(2083.33, 2);
  });
  it('regular months are flat 30 days at 5L × 10% × 30/360 = ₹4166.67', () => {
    expect(ramesh[1]!.period_days).toBe(30);
    expect(ramesh[1]!.is_broken_period).toBe(false);
    expect(ramesh[1]!.gross_amount).toBeCloseTo(4166.67, 2);
  });
  it('principal comes back as a Redemption row on maturity (deemed + 36 months)', () => {
    const redemption = ramesh.find((r) => r.due_type === 'Redemption');
    expect(redemption).toBeDefined();
    expect(redemption!.gross_amount).toBe(500000);
    expect(redemption!.due_date).toBe('2029-04-01');
  });
  it('maturity broken interest is a separate BrokenInterest row after maturity = ₹277.78', () => {
    const bi = ramesh.find((r) => r.due_type === 'BrokenInterest');
    expect(bi).toBeDefined();
    expect(bi!.gross_amount).toBeCloseTo(277.78, 2);
  });
  it('no monthly row is tagged Final — all regular rows are plain Interest', () => {
    const types = new Set(ramesh.map((r) => r.due_type));
    expect(types.has('Interest')).toBe(true);
    expect([...types]).not.toContain('Final');
  });
});

describe('generateSchedule — quarterly frequency', () => {
  const quart = generateSchedule(
    { amount: 100000, coupon_rate_pct: 12, payout_frequency: 'Quarterly', tenure_months: 12 },
    { interestStartDate: '2026-04-01', seriesDeemedDate: '2026-04-01' }
  );
  it('invest on the 1st → no broken period, full 90-day quarters', () => {
    expect(quart[0]!.is_broken_period).toBe(false);
    expect(quart[0]!.period_days).toBe(90);
  });
  it('quarterly interest = 1L × 12% × 90/360 = ₹3000.00', () => {
    expect(quart[0]!.gross_amount).toBeCloseTo(3000, 2);
    expect(quart[1]!.gross_amount).toBeCloseTo(3000, 2);
  });
});
