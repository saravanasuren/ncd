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
import { accruedAtMaturity, cumulativeMaturityValue, generateSchedule, rollsToNextBatch } from '../src/lib/interest.js';
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

/**
 * Owner 2026-10-26 (day moved to the 26th on 2026-10-27): money received on or
 * after the 26th is paid from the NEXT month's batch; money on the 25th is
 * still paid that month. The skipped short payment is not lost — the next
 * month's first period counts every day from the money date.
 */
describe('money received from the 26th is paid in the next month', () => {
  const line = {
    amount: 100000, coupon_rate_pct: 12, payout_frequency: 'Monthly' as const,
    tenure_months: 12, day_count_convention: 'Actual365' as const,
  };
  const schedule = (start: string, nextBatchFromDay?: number, startIsPriorWatermark = false) =>
    generateSchedule(line, { interestStartDate: start, seriesDeemedDate: '2026-10-01', nextBatchFromDay, startIsPriorWatermark });
  const interestRows = (rows: ReturnType<typeof schedule>) => rows.filter((r) => r.due_type !== 'Redemption');

  it('the rule itself: 26th onwards in the same month moves; the 25th, earlier days and other months do not', () => {
    expect(rollsToNextBatch('2026-10-26', '2026-10-28', 26)).toBe(true);
    expect(rollsToNextBatch('2026-10-27', '2026-10-28', 26)).toBe(true);
    expect(rollsToNextBatch('2026-10-25', '2026-10-28', 26)).toBe(false);
    expect(rollsToNextBatch('2026-10-24', '2026-10-28', 26)).toBe(false);
    expect(rollsToNextBatch('2026-10-26', '2026-11-28', 26)).toBe(false);
    expect(rollsToNextBatch('2026-10-26', '2026-10-28', 0)).toBe(false);
    expect(rollsToNextBatch('2026-10-26', '2026-10-28', undefined)).toBe(false);
  });

  it('money on the 25th is still paid on this month\'s 28th (4 days, the 25th counts)', () => {
    const first = schedule('2026-10-25', 26)[0]!;
    expect(first.due_date).toBe('2026-10-28');
    expect(first.period_days).toBe(4);
  });

  it('money on the 26th skips 28 Oct; first payout 28 Nov covers 26 Oct → 28 Nov (34 days)', () => {
    const rows = schedule('2026-10-26', 26);
    expect(rows[0]!.due_date).toBe('2026-11-28');
    expect(rows[0]!.period_days).toBe(34);
    expect(rows[0]!.is_broken_period).toBe(true);
    // 1,00,000 × 12% × 34 / 365
    expect(rows[0]!.gross_amount).toBeCloseTo(1117.81, 2);
    expect(rows[1]!.due_date).toBe('2026-12-28');
    expect(rows[1]!.period_days).toBe(30);
  });

  it('money on the 27th: first payout 28 Nov, 33 days', () => {
    const first = schedule('2026-10-27', 26)[0]!;
    expect(first.due_date).toBe('2026-11-28');
    expect(first.period_days).toBe(33);
  });

  it('moves timing only — lifetime interest is the same as before the rule', () => {
    const sum = (rows: ReturnType<typeof schedule>) => interestRows(rows).reduce((s, r) => s + r.gross_amount, 0);
    const days = (rows: ReturnType<typeof schedule>) => interestRows(rows).reduce((s, r) => s + r.period_days, 0);
    expect(days(schedule('2026-10-26', 26))).toBe(days(schedule('2026-10-26')));
    expect(Math.abs(sum(schedule('2026-10-26', 26)) - sum(schedule('2026-10-26')))).toBeLessThanOrEqual(0.01);
  });

  it('switched off (0 / not passed) the schedule is exactly as before', () => {
    expect(schedule('2026-10-26', 0)).toEqual(schedule('2026-10-26'));
    expect(schedule('2026-10-26')[0]!.due_date).toBe('2026-10-28');
  });

  it('never applies to a migration watermark (a date already paid through)', () => {
    expect(schedule('2026-10-26', 26, true)[0]!.due_date).toBe('2026-10-28');
  });
});

/**
 * THE DOUBLING PRODUCT (payout_frequency 'AtMaturity').
 *
 * Owner 2026-11-26, asked which figure is the real promise: "exactly double it
 * and also add the broken period interest from the date of investment till the
 * effective date/allotment date."
 *
 * Every case below is a REAL live investment, and the expected maturity figure
 * is the one already sitting in production's disbursement_schedule — so if this
 * math ever moves, these fail rather than silently repaying 7 people a
 * different amount. Rs 2,16,84,821 rides on them.
 */
describe('AtMaturity — double the principal, plus the broken period before the term starts', () => {
  // NIRANJAN B A, APP-2026-001271, Debenture 4. Money 1 Oct 2026, the series
  // term runs 31 Oct 2026 -> 31 Oct 2031, so 30 days are earned before it.
  const niranjan = {
    principal: 500000, ratePct: 20, tenureMonths: 60,
    interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31',
    maturityDate: '2031-10-31',
  } as const;

  it('pays principal + the whole term + the broken days', () => {
    const v = cumulativeMaturityValue(niranjan);
    expect(v.term).toBe(500000);              // 20% x 60 months = the principal over again
    expect(v.brokenDays).toBe(30);            // 1 Oct -> 31 Oct, the term's start excluded
    expect(v.broken).toBe(8219.18);           // 500000 x 20% x 30/365
    expect(v.interest).toBe(508219.18);
    expect(v.total).toBe(1008219.18);         // production holds 10,08,219 (whole rupees)
  });

  it('puts the whole thing on ONE row, on the maturity date', () => {
    const rows = generateSchedule(
      { amount: 500000, coupon_rate_pct: 20, payout_frequency: 'AtMaturity', tenure_months: 60 },
      { interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.due_type).toBe('Redemption');
    expect(rows[0]!.due_date).toBe('2031-10-31');
    expect(rows[0]!.gross_amount).toBe(1008219.18);
    // Nothing reaches the holder before maturity — no Interest row at all.
    expect(rows.some((r) => r.due_type === 'Interest')).toBe(false);
  });

  it('reproduces the figure production already holds, for every live Doubling line', () => {
    // principal, money date, deemed date, maturity, the stored whole-rupee gross.
    const live: Array<[number, string, string, string, number]> = [
      [2100000, '2026-08-29', '2026-08-31', '2031-08-31', 4202301],  // SIVA ARUL T  001274
      [1700000, '2026-08-29', '2026-08-31', '2031-08-31', 3401863],  // SIVA ARUL T  001277
      [1100000, '2026-08-29', '2026-08-31', '2031-08-31', 2201205],  // SIVA ARUL T  001275
      [1800000, '2026-10-03', '2026-10-31', '2031-10-31', 3627616],  // G PARAMESWARI 001276
      [1500000, '2026-10-03', '2026-10-31', '2031-10-31', 3023014],  // NIRANJAN B A  001272
      [500000,  '2026-10-01', '2026-10-31', '2031-10-31', 1008219],  // NIRANJAN B A  001271
      [1000000, '2026-11-12', '2026-11-30', '2031-11-30', 2009863],  // S.PREMALATHA  001389
      [500000,  '2026-10-22', '2026-10-31', '2031-10-31', 1002466],  // T PRASANA DEVI 001322
      [500000,  '2026-11-05', '2026-11-30', '2031-11-30', 1006849],  // UMAMAHESWARI M 001367
      [100000,  '2026-10-05', '2026-10-31', '2031-10-31', 201425],   // Periyasamy     001270
    ];
    let total = 0;
    for (const [principal, money, deemed, mat, stored] of live) {
      const v = cumulativeMaturityValue({
        principal, ratePct: 20, tenureMonths: 60,
        interestStartDate: money, seriesDeemedDate: deemed, maturityDate: mat,
      });
      expect(Math.round(v.total), `${principal} from ${money}`).toBe(stored);
      total += stored;
    }
    expect(total).toBe(21684821);
  });

  it('never shaves the term when the money arrived after the deemed date', () => {
    // The certificate promises the full term. Paying under it is the one error
    // that cannot be defended, so a negative gap clamps to zero.
    const v = cumulativeMaturityValue({
      principal: 500000, ratePct: 20, tenureMonths: 60,
      interestStartDate: '2026-11-15', seriesDeemedDate: '2026-10-31',
    });
    expect(v.brokenDays).toBe(0);
    expect(v.broken).toBe(0);
    expect(v.total).toBe(1000000);
  });

  it('refuses to hand back an empty schedule for a frequency it does not know', () => {
    // The whole reason this product went unscheduled: the if/else had no branch
    // for 'AtMaturity' and quietly returned []. Rs 1.08 crore, no payout, no
    // complaint. Every rebuild path deletes-then-regenerates in one
    // transaction, so throwing here rolls the delete back.
    expect(() => generateSchedule(
      { amount: 500000, coupon_rate_pct: 20, payout_frequency: 'Fortnightly' as never, tenure_months: 60 },
      { interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31' }))
      .toThrow(/no branch for the payout frequency "Fortnightly"/);
  });
});

/**
 * ACCRUED, NOT PAYABLE (owner 2026-11-26): "in the summary sheet ill be needing
 * their accured interest as on date but no interest should be going to them in
 * the payout."
 */
describe('accruedAtMaturity — what a Doubling holding is worth today', () => {
  const niranjan = {
    principal: 500000, ratePct: 20, tenureMonths: 60,
    interestStartDate: '2026-10-01', seriesDeemedDate: '2026-10-31',
    maturityDate: '2031-10-31',
  } as const;

  it('earns nothing on or before the day the money landed', () => {
    expect(accruedAtMaturity({ ...niranjan, asOf: '2026-09-30' }).interest).toBe(0);
    expect(accruedAtMaturity({ ...niranjan, asOf: '2026-10-01' }).interest).toBe(0);
  });

  it('runs the broken period first, day by day', () => {
    const a = accruedAtMaturity({ ...niranjan, asOf: '2026-10-15' });
    expect(a.broken).toBe(3835.62);            // 500000 x 20% x 14/365
    expect(a.term).toBe(0);                    // the term has not started
    expect(a.interest).toBe(3835.62);
  });

  it('completes the broken period exactly on the deemed date, counting nothing twice', () => {
    const a = accruedAtMaturity({ ...niranjan, asOf: '2026-10-31' });
    expect(a.broken).toBe(8219.18);
    expect(a.term).toBe(0);
  });

  it('then pro-rates the term across it', () => {
    // 28 days of 1826. Verified against production on 28 Nov 2026.
    const a = accruedAtMaturity({ ...niranjan, asOf: '2026-11-28' });
    expect(a.broken).toBe(8219.18);
    expect(a.term).toBe(7667.03);
    expect(a.interest).toBe(15886.21);
  });

  it('lands on the maturity figure to the rupee, and never past it', () => {
    const full = cumulativeMaturityValue(niranjan);
    expect(accruedAtMaturity({ ...niranjan, asOf: '2031-10-31' }).interest).toBe(full.interest);
    // A sheet cut after maturity cannot keep accruing.
    expect(accruedAtMaturity({ ...niranjan, asOf: '2033-01-01' }).interest).toBe(full.interest);
  });

  it('closes on the maturity figure for every live Doubling line', () => {
    const live: Array<[number, string, string, string]> = [
      [2100000, '2026-08-29', '2026-08-31', '2031-08-31'],
      [1700000, '2026-08-29', '2026-08-31', '2031-08-31'],
      [1100000, '2026-08-29', '2026-08-31', '2031-08-31'],
      [1800000, '2026-10-03', '2026-10-31', '2031-10-31'],
      [1500000, '2026-10-03', '2026-10-31', '2031-10-31'],
      [500000,  '2026-10-01', '2026-10-31', '2031-10-31'],
      [1000000, '2026-11-12', '2026-11-30', '2031-11-30'],
      [500000,  '2026-10-22', '2026-10-31', '2031-10-31'],
      [500000,  '2026-11-05', '2026-11-30', '2031-11-30'],
      [100000,  '2026-10-05', '2026-10-31', '2031-10-31'],
    ];
    for (const [principal, money, deemed, mat] of live) {
      const line = { principal, ratePct: 20, tenureMonths: 60, interestStartDate: money, seriesDeemedDate: deemed, maturityDate: mat };
      expect(accruedAtMaturity({ ...line, asOf: mat }).interest, `${principal} from ${money}`)
        .toBe(cumulativeMaturityValue(line).interest);
    }
  });
});
