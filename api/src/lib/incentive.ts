/**
 * Incentive matrix (2026-06-26 policy) — ported from the old app's
 * `incentive-policy.js`, extended to support the owner's requirement that
 * every rate can be a **flat ₹ amount OR a percent of the investment**
 * (docs/02 §6, docs/07). Rate values come from the settings registry;
 * DEFAULTS mirror production and keep tests/pre-seed DBs working.
 *
 * Two facts decide the cell, both known at allotment:
 *   1. was the customer brand-new when THIS application was created
 *   2. is there a free-text referrer on THIS application
 *
 *   referrer? no  → staff: selfSourced,          referrer: 0
 *   referrer? yes + new customer → staff: newWithReferrer,      referrer: referrerNewCustomer
 *   referrer? yes + existing     → staff: existingWithReferrer, referrer: 0
 */
import { round2 } from './dates.js';

export type RateSpec = { mode: 'pct' | 'flat'; value: number };

export interface IncentiveMatrix {
  selfSourced: RateSpec;
  existingWithReferrer: RateSpec;
  newWithReferrer: RateSpec;
  referrerNewCustomer: RateSpec;
}

/** Settings keys holding each rate (docs/07). */
export const MATRIX_SETTING_KEYS = {
  selfSourced: 'incentive.staff_new_no_referrer',
  existingWithReferrer: 'incentive.staff_existing_with_referrer',
  newWithReferrer: 'incentive.referrer_new_with_referrer_staff',
  referrerNewCustomer: 'incentive.referrer_new_with_referrer',
} as const;

/** Production defaults (all percent). */
export const DEFAULT_MATRIX: IncentiveMatrix = {
  selfSourced: { mode: 'pct', value: 2.0 },
  existingWithReferrer: { mode: 'pct', value: 0.25 },
  newWithReferrer: { mode: 'pct', value: 0 },
  referrerNewCustomer: { mode: 'pct', value: 2.0 },
};

/** Resolve a rate spec against an investment amount → rupee amount. */
export function resolveRate(spec: RateSpec, investmentAmount: number): number {
  if (spec.mode === 'flat') return round2(spec.value);
  return round2((Number(investmentAmount) * spec.value) / 100);
}

/** Pick the staff + referrer rate specs for the matrix cell. */
export function pickRates(
  matrix: IncentiveMatrix,
  isNewCustomer: boolean,
  hasReferrer: boolean
): { staff: RateSpec; referrer: RateSpec } {
  if (!hasReferrer) {
    return { staff: matrix.selfSourced, referrer: { mode: 'pct', value: 0 } };
  }
  if (isNewCustomer) {
    return { staff: matrix.newWithReferrer, referrer: matrix.referrerNewCustomer };
  }
  return { staff: matrix.existingWithReferrer, referrer: { mode: 'pct', value: 0 } };
}

export interface IncentiveResult {
  staffSpec: RateSpec;
  referrerSpec: RateSpec;
  staffAmount: number;
  referrerAmount: number;
}

/** Full computation: which cell, and the resolved rupee amounts. */
export function computeIncentives(
  matrix: IncentiveMatrix,
  isNewCustomer: boolean,
  hasReferrer: boolean,
  investmentAmount: number
): IncentiveResult {
  const { staff, referrer } = pickRates(matrix, isNewCustomer, hasReferrer);
  return {
    staffSpec: staff,
    referrerSpec: referrer,
    staffAmount: resolveRate(staff, investmentAmount),
    referrerAmount: resolveRate(referrer, investmentAmount),
  };
}
