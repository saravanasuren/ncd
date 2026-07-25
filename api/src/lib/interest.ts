/**
 * Interest schedule engine (option-b, receipt-date driven).
 *
 * 🔒 CONVENTION — owner-confirmed 2026-07-16 (docs/02 §6):
 *   • Interest is PAID on the 28th of each month.
 *   • Each period runs 29th-of-previous-month → 28th-of-this-month, i.e. the
 *     ACTUAL calendar days between consecutive 28ths.
 *   • Interest = principal × rate/100 × actual_days / 365 for EVERY period
 *     (full months vary: 30, 31 or 28 days — NOT flat).
 *   • First (broken) period = actual days from the money-received date to
 *     the next 28th, ÷ 365.
 *   • Maturity = deemed date + tenure; principal returns as a Redemption row
 *     on maturity_date; the last part-period (last 28th → maturity) is a
 *     separate BrokenInterest row on the first 28th after maturity.
 *
 * The default convention is therefore `Actual365` (actual days every period).
 * `Thirty360` (flat 30/360) remains available per-scheme for back-compat.
 * Payout day and denominator are config-driven (settings) — no value is
 * hardcoded into a decision, only supplied as a default here.
 *
 * Locked worked example asserted in `test/interest.test.ts` — DO NOT change
 * the math without owner sign-off.
 */
import {
  addDays,
  addMonths,
  adjustForHoliday,
  dayOfMonth,
  daysBetween,
  daysInYear,
  nextPayoutAfter,
  payoutDayOfMonth,
  round2,
  type ISODate,
} from './dates.js';

export type DayCountConvention = 'Thirty360' | 'Actual365' | 'Actual360' | 'ActualActual';
export type PayoutFrequency =
  | 'Monthly'
  | 'Quarterly'
  | 'HalfYearly'
  | 'Annual'
  | 'Cumulative'
  | 'LockIn';

export type DueType = 'Interest' | 'BrokenInterest' | 'Redemption' | 'Premature';

const FREQ_MONTHS: Record<string, number> = {
  Monthly: 1,
  Quarterly: 3,
  HalfYearly: 6,
  Annual: 12,
};
const PERIOD_DAYS_PER_MONTH = 30;

export interface ScheduleLine {
  amount: number;
  coupon_rate_pct: number;
  payout_frequency: PayoutFrequency;
  tenure_months: number;
  face_value?: number;
  redemption_amount_per_unit?: number;
  day_count_convention?: DayCountConvention;
}

export interface ScheduleOpts {
  /** When interest starts accruing = max(latest collection date, deemed date). */
  interestStartDate: ISODate;
  /** Anchors maturity (deemed + tenure). */
  seriesDeemedDate: ISODate;
  holidays?: string[];
  /** Config-driven (settings `interest.payout_day_of_month`, default 28). */
  payoutDay?: number;
  /**
   * True when `interestStartDate` is actually a prior WATERMARK already paid
   * through (e.g. the legacy-migration freeze anchor — migrate-legacy/pipeline.ts
   * passes its cutover date here to regenerate everything after it), not a
   * fresh investment day. In that case the first generated period must NOT
   * count that boundary day, matching previewDue's ordinary paid_through
   * convention. Default false: the common case is a real go-live, where
   * interestStartDate is the actual day money arrived and — owner-confirmed
   * 2026-07-25 — that day itself accrues.
   */
  startIsPriorWatermark?: boolean;
}

export interface ScheduleRow {
  due_date: ISODate;
  due_type: DueType;
  gross_amount: number;
  period_days: number;
  is_broken_period: boolean;
}

export function denominatorFor(convention: DayCountConvention, fromDate?: ISODate): number {
  switch (convention) {
    case 'Actual360':
      return 360;
    case 'Thirty360':
      return 360;
    case 'ActualActual':
      return fromDate ? daysInYear(fromDate) : 365;
    case 'Actual365':
    default:
      return 365;
  }
}

function payoutDatesFor(
  freqMonths: number,
  tenureMonths: number,
  interestStartDate: ISODate,
  holidaySet: Set<string>,
  maturityDate: ISODate,
  payoutDay: number
): ISODate[] {
  const out: ISODate[] = [];
  const cap = Math.floor(tenureMonths / freqMonths) + 2;
  for (let i = 1; i <= cap; i++) {
    const raw = payoutDayOfMonth(interestStartDate, (i - 1) * freqMonths, payoutDay);
    const date = adjustForHoliday(raw, holidaySet);
    if (date <= interestStartDate) continue;
    if (maturityDate && date >= maturityDate) break;
    out.push(date);
  }
  return out;
}

export function generateSchedule(line: ScheduleLine, opts: ScheduleOpts): ScheduleRow[] {
  const { interestStartDate, seriesDeemedDate, holidays, payoutDay = 28, startIsPriorWatermark = false } = opts;
  const firstDayCounts = !startIsPriorWatermark;
  if (!interestStartDate || !seriesDeemedDate) {
    throw new Error('generateSchedule requires interestStartDate and seriesDeemedDate');
  }
  const holidaySet = new Set(Array.isArray(holidays) ? holidays : []);
  const convention: DayCountConvention = line.day_count_convention || 'Actual365';

  const out: ScheduleRow[] = [];
  const amount = Number(line.amount);
  const rate = Number(line.coupon_rate_pct);
  const tenure = Number(line.tenure_months);
  const freq = line.payout_frequency;
  const maturityDate = adjustForHoliday(addMonths(seriesDeemedDate, tenure), holidaySet);

  if (freq in FREQ_MONTHS) {
    const m = FREQ_MONTHS[freq]!;
    const periodDaysNormal = m * PERIOD_DAYS_PER_MONTH;
    const payouts = payoutDatesFor(m, tenure, interestStartDate, holidaySet, maturityDate, payoutDay);

    let prev = interestStartDate;
    let lastRegularPayout: ISODate | null = null;
    const investDay = dayOfMonth(interestStartDate);

    for (let i = 0; i < payouts.length; i++) {
      const due = payouts[i]!;
      // The FIRST period only: `prev` is interestStartDate itself, the day the
      // money actually arrived — a day that has never been paid for, unlike
      // every later `prev` (a prior payout boundary, already compensated
      // through end of that day). daysBetween is exclusive of its start, which
      // is correct for i>0 but silently drops the investment day itself for
      // i=0. Owner-confirmed 2026-07-25: interest starts ON the day of
      // investment, so the first period counts one more day than daysBetween
      // alone gives.
      const actualDays = daysBetween(prev, due) + (i === 0 && firstDayCounts ? 1 : 0);
      let periodDays: number;
      let isBroken: boolean;
      if (convention === 'Thirty360') {
        // Back-compat opt-in: flat 30-day months, broken first = (30 − invest_day + 1)
        // — same inclusive-of-investment-day rule as the Actual* branch below.
        if (i === 0 && investDay > 1) {
          periodDays = m * 30 - investDay + (firstDayCounts ? 1 : 0);
          isBroken = true;
        } else {
          periodDays = m * 30;
          isBroken = false;
        }
      } else {
        // Actual365 (default) / Actual360 / ActualActual: every period is the
        // ACTUAL calendar days between boundaries (owner-confirmed rule).
        periodDays = actualDays;
        isBroken = i === 0 && actualDays < periodDaysNormal;
      }
      const denom = denominatorFor(convention, prev);
      const interest = round2((amount * rate) / 100 * periodDays / denom);
      out.push({
        due_date: due,
        due_type: 'Interest',
        gross_amount: interest,
        period_days: periodDays,
        is_broken_period: isBroken,
      });
      prev = due;
      lastRegularPayout = due;
    }

    // Principal back on maturity_date.
    out.push({
      due_date: maturityDate,
      due_type: 'Redemption',
      gross_amount: amount,
      period_days: 0,
      is_broken_period: false,
    });

    // Maturity broken-interest catch-up on the first payout day after maturity.
    // Owner-confirmed 2026-07-25: interest stops the day BEFORE principal is
    // returned — maturity day itself is never a paid day, same rule as a
    // premature redemption. daysBetween's end is inclusive, so back the
    // boundary up by one rather than counting maturityDate itself.
    if (lastRegularPayout) {
      const brokenDays = daysBetween(lastRegularPayout, addDays(maturityDate, -1));
      if (brokenDays > 0) {
        const denom = denominatorFor(convention, lastRegularPayout);
        const brokenAmt = round2((amount * rate) / 100 * brokenDays / denom);
        if (brokenAmt > 0) {
          const nextPayout = adjustForHoliday(nextPayoutAfter(maturityDate, payoutDay), holidaySet);
          out.push({
            due_date: nextPayout,
            due_type: 'BrokenInterest',
            gross_amount: brokenAmt,
            period_days: brokenDays,
            is_broken_period: true,
          });
        }
      }
    }
  } else if (freq === 'Cumulative' || freq === 'LockIn') {
    const units = Math.floor(amount / Number(line.face_value || 1000));
    const redemptionPerUnit = Number(line.redemption_amount_per_unit || line.face_value || 1000);
    const gross = round2(units * redemptionPerUnit);
    out.push({
      due_date: maturityDate,
      due_type: 'Redemption',
      gross_amount: gross,
      period_days: 0,
      is_broken_period: false,
    });
  }
  return out;
}
