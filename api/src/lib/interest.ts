/**
 * Interest schedule engine (option-b, receipt-date driven).
 *
 * Ported behaviour-for-behaviour from the old app's `schedule.js`
 * `generateSchedule`. The locked worked example (Ramesh ₹5L @10%) is
 * asserted in `test/interest.test.ts` — DO NOT change the math without
 * owner sign-off (docs/02 §6).
 *
 * Defaults: payout day = 30, convention = Thirty360 (denom 360). Both are
 * overridable per-scheme / per-settings — no value is hardcoded into a
 * decision, only supplied as a default here.
 */
import {
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
  /** Config-driven (settings `interest.payout_day_of_month`, default 30). */
  payoutDay?: number;
}

export interface ScheduleRow {
  due_date: ISODate;
  due_type: DueType;
  gross_amount: number;
  period_days: number;
  is_broken_period: boolean;
}

function denominatorFor(convention: DayCountConvention, fromDate?: ISODate): number {
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
  const { interestStartDate, seriesDeemedDate, holidays, payoutDay = 30 } = opts;
  if (!interestStartDate || !seriesDeemedDate) {
    throw new Error('generateSchedule requires interestStartDate and seriesDeemedDate');
  }
  const holidaySet = new Set(Array.isArray(holidays) ? holidays : []);
  const convention: DayCountConvention = line.day_count_convention || 'Thirty360';

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
      const actualDays = daysBetween(prev, due);
      let periodDays: number;
      let isBroken: boolean;
      if (convention === 'Thirty360') {
        if (i === 0 && investDay > 1) {
          periodDays = m * 30 - investDay;
          isBroken = true;
        } else {
          periodDays = m * 30;
          isBroken = false;
        }
      } else if (convention === 'ActualActual') {
        periodDays = actualDays;
        isBroken = i === 0 && actualDays < periodDaysNormal;
      } else {
        isBroken = i === 0 && actualDays < periodDaysNormal;
        periodDays = isBroken ? actualDays : periodDaysNormal;
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
    if (lastRegularPayout) {
      const brokenDays = daysBetween(lastRegularPayout, maturityDate);
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
