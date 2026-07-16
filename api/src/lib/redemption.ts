/**
 * Premature redemption math (docs/02 §6, docs/09 §17 old-app bug note).
 *
 *   Net Payment = Principal − Penalty
 *
 * Broken-period interest (from the last regular payout to the redemption
 * date) is paid SEPARATELY in the next payout cycle — it is NEVER rolled
 * into Net Payment. Penalty is config-driven (settings
 * `redemption.premature_penalty`, flat ₹ or % of principal).
 */
import { round2, daysBetween, type ISODate } from './dates.js';
import { resolveRate, type RateSpec } from './incentive.js';
import type { DayCountConvention } from './interest.js';

export const DEFAULT_PENALTY: RateSpec = { mode: 'pct', value: 1.0 };

export interface RedemptionInput {
  principal: number;
  penalty?: RateSpec; // default 1%
  /** For the separately-paid broken interest, if computed here. */
  couponRatePct?: number;
  lastRegularPayoutDate?: ISODate;
  redemptionDate?: ISODate;
  convention?: DayCountConvention;
}

export interface RedemptionResult {
  principal: number;
  penalty: number;
  netPayment: number;
  brokenInterest: number; // paid separately next cycle, not in netPayment
}

function denom(convention: DayCountConvention | undefined): number {
  switch (convention) {
    case 'Thirty360':
    case 'Actual360':
      return 360;
    default:
      return 365; // Actual365 (owner-confirmed default) / ActualActual
  }
}

export function computeRedemption(input: RedemptionInput): RedemptionResult {
  const principal = Number(input.principal);
  const penalty = resolveRate(input.penalty ?? DEFAULT_PENALTY, principal);
  const netPayment = round2(principal - penalty);

  let brokenInterest = 0;
  if (
    input.couponRatePct != null &&
    input.lastRegularPayoutDate &&
    input.redemptionDate
  ) {
    const days = daysBetween(input.lastRegularPayoutDate, input.redemptionDate);
    if (days > 0) {
      brokenInterest = round2(
        (principal * Number(input.couponRatePct)) / 100 * days / denom(input.convention)
      );
    }
  }

  return { principal, penalty, netPayment, brokenInterest };
}
