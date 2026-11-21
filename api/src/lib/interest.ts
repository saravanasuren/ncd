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
 *   • Money received ON OR AFTER a cut-off day of the month (setting
 *     `interest.next_batch_from_day`, default 26 — owner 2026-10-26/27) is not
 *     paid in that same month's batch: its first payout is the NEXT payout
 *     day, covering every day from the day the money arrived. See
 *     `rollsToNextBatch`.
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
  | 'LockIn'
  // The Doubling product. It was in the DATA and the scheme row from the
  // start but never in this union, so generateSchedule fell off the end of
  // its if/else and returned NO ROWS — ten live lines, Rs 1.08 crore, with
  // nothing scheduled and no maturity date stamped (owner 2026-11-21).
  | 'AtMaturity';

export type DueType = 'Interest' | 'BrokenInterest' | 'Redemption' | 'Premature';

const FREQ_MONTHS: Record<string, number> = {
  Monthly: 1,
  Quarterly: 3,
  HalfYearly: 6,
  Annual: 12,
};
const PERIOD_DAYS_PER_MONTH = 30;

/**
 * What a CUMULATIVE holding is worth at maturity.
 *
 * THE ONE PLACE THIS IS COMPUTED. The certificate used to work it out on its
 * own and the engine did not work it out at all, which is how a document
 * promising Rs 42,00,000 came to sit over a schedule holding nothing. The
 * schedule, the maturity payout and the printed certificate now all read this
 * function, so they cannot drift apart again.
 *
 * TWO PARTS, by the owner's decision of 2026-11-21, asked outright:
 *
 *   term   = principal x rate x tenure/12 — the CERTIFICATE'S OWN FORMULA, so
 *            a Doubling holding earns exactly 100% and the paid figure can
 *            never fall short of the printed promise. Deliberately NOT a
 *            day count: Actual365 across five years picks up the 2028 leap
 *            day and would quietly pay more than the certificate says.
 *   broken = rate on the days the money sat with the Company BEFORE the term
 *            began — every one of the ten paid 2 to 30 days before the deemed
 *            date, and interest_start_date already records it. Day-counted on
 *            the line's own convention, exactly as every other product's
 *            broken period is.
 *
 * The deemed date itself belongs to the term, so the broken period ends the
 * day before it and nothing is counted twice.
 *
 * MONEY THAT ARRIVED LATE IS NOT CHARGED BACK. A negative gap clamps to zero
 * rather than shaving the term, because the holder's certificate promises the
 * full term and paying under it is the one error that cannot be defended.
 */
export function cumulativeMaturityValue(input: {
  principal: number;
  ratePct: unknown;
  tenureMonths: unknown;
  /** When the money actually arrived — the line's own date. */
  interestStartDate?: ISODate | null;
  /** When the term starts; the deemed date the maturity is measured from. */
  seriesDeemedDate?: ISODate | null;
  convention?: DayCountConvention;
}): { term: number; broken: number; brokenDays: number; interest: number; total: number } {
  const principal = Number(input.principal);
  const rate = Number(input.ratePct);
  const months = Number(input.tenureMonths);
  const none = { term: 0, broken: 0, brokenDays: 0, interest: 0, total: round2(principal || 0) };
  if (!Number.isFinite(principal) || principal <= 0) return { ...none, total: 0 };
  if (!Number.isFinite(rate) || !Number.isFinite(months) || rate <= 0 || months <= 0) return none;

  const term = round2(principal * (rate / 100) * (months / 12));

  let brokenDays = 0;
  if (input.interestStartDate && input.seriesDeemedDate) {
    brokenDays = Math.max(0, daysBetween(input.interestStartDate, input.seriesDeemedDate));
  }
  const denom = denominatorFor(input.convention || 'Actual365', input.interestStartDate || undefined);
  const broken = brokenDays > 0 ? round2(principal * (rate / 100) * brokenDays / denom) : 0;

  const interest = round2(term + broken);
  return { term, broken, brokenDays, interest, total: round2(principal + interest) };
}

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
  /**
   * Config-driven (settings `interest.next_batch_from_day`, default 26 — owner
   * 2026-10-26). Money received on or after this day of the month skips that
   * month's payout; its first period runs to the next payout day instead.
   * 0 / undefined = off. Never applied when `startIsPriorWatermark` — a
   * watermark is a date already paid through, not money arriving.
   */
  nextBatchFromDay?: number;
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

/**
 * True when money received on `moneyReceivedOn` must NOT be paid in the batch
 * dated `payoutDate`, because it arrived on or after the cut-off day of that
 * same month (owner 2026-10-26/27: investments from the 26th are paid in the next
 * month's batch). No day is lost — the next month's batch pays from the day the
 * money arrived.
 *
 * The ONE rule, used by both the projected schedule (generateSchedule) and the
 * live payout run (payouts/service.ts previewDue), so the two cannot disagree.
 */
export function rollsToNextBatch(moneyReceivedOn: ISODate, payoutDate: ISODate, fromDay: number | undefined): boolean {
  const cutoff = Number(fromDay);
  if (!Number.isFinite(cutoff) || cutoff <= 0) return false;
  if (dayOfMonth(moneyReceivedOn) < cutoff) return false;
  return moneyReceivedOn.slice(0, 7) === payoutDate.slice(0, 7);
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
  const { interestStartDate, seriesDeemedDate, holidays, payoutDay = 28, startIsPriorWatermark = false, nextBatchFromDay } = opts;
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
    // Money received on/after the cut-off day: drop that same month's payout so
    // the first period runs to the next one (see rollsToNextBatch). Only when a
    // later payout exists — with none, dropping it would leave the days from the
    // money date to maturity with no row at all.
    const rolled = !startIsPriorWatermark
      && payouts.length >= 2
      && rollsToNextBatch(interestStartDate, payouts[0]!, nextBatchFromDay);
    if (rolled) payouts.shift();

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
          // A rolled first period also carries the whole period it skipped.
          periodDays = m * 30 - investDay + (firstDayCounts ? 1 : 0) + (rolled ? m * 30 : 0);
          isBroken = true;
        } else {
          periodDays = m * 30;
          isBroken = false;
        }
      } else {
        // Actual365 (default) / Actual360 / ActualActual: every period is the
        // ACTUAL calendar days between boundaries (owner-confirmed rule).
        periodDays = actualDays;
        // A rolled first period is longer than a normal one but is still a
        // part-period carried forward, not a regular month.
        isBroken = i === 0 && (rolled || actualDays < periodDaysNormal);
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
  } else if (freq === 'AtMaturity') {
    // ONE COMBINED ROW (owner 2026-11-21, asked: "combined pluse the broken
    // period interest"). Principal and the whole of the interest land together
    // on the maturity date, because that is when the holder is actually paid —
    // nothing on a cumulative product reaches them before it.
    const v = cumulativeMaturityValue({
      principal: amount, ratePct: rate, tenureMonths: tenure,
      interestStartDate, seriesDeemedDate, convention,
    });
    out.push({
      due_date: maturityDate,
      due_type: 'Redemption',
      gross_amount: v.total,
      // The day-counted part only. The term is formula-based, not counted in
      // days, so putting the whole five years here would misdescribe it.
      period_days: v.brokenDays,
      is_broken_period: false,
    });
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
