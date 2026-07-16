/**
 * Incentive matrix — 4 cells + flat-vs-pct (docs/02 §6).
 * Values mirror the old app's incentive-policy DEFAULTS.
 */
import { describe, it, expect } from 'vitest';
import {
  computeIncentives,
  pickRates,
  DEFAULT_MATRIX,
  type IncentiveMatrix,
} from '../src/lib/incentive.js';

const AMOUNT = 1_000_000; // ₹10 L

describe('incentive matrix — the 4 cells (default pct rates)', () => {
  it('brand-new + no referrer → staff 2%, referrer 0', () => {
    const r = computeIncentives(DEFAULT_MATRIX, true, false, AMOUNT);
    expect(r.staffAmount).toBe(20000);
    expect(r.referrerAmount).toBe(0);
  });
  it('brand-new + referrer → staff 0, referrer 2%', () => {
    const r = computeIncentives(DEFAULT_MATRIX, true, true, AMOUNT);
    expect(r.staffAmount).toBe(0);
    expect(r.referrerAmount).toBe(20000);
  });
  it('existing + no referrer → staff 2%, referrer 0', () => {
    const r = computeIncentives(DEFAULT_MATRIX, false, false, AMOUNT);
    expect(r.staffAmount).toBe(20000);
    expect(r.referrerAmount).toBe(0);
  });
  it('existing + referrer → staff 0.25%, referrer 0', () => {
    const r = computeIncentives(DEFAULT_MATRIX, false, true, AMOUNT);
    expect(r.staffAmount).toBe(2500);
    expect(r.referrerAmount).toBe(0);
  });
});

describe('incentive matrix — flat ₹ rates are supported', () => {
  const flatMatrix: IncentiveMatrix = {
    selfSourced: { mode: 'flat', value: 5000 },
    existingWithReferrer: { mode: 'pct', value: 0.25 },
    newWithReferrer: { mode: 'pct', value: 0 },
    referrerNewCustomer: { mode: 'flat', value: 7500 },
  };
  it('flat staff rate pays the flat amount regardless of investment', () => {
    expect(computeIncentives(flatMatrix, true, false, AMOUNT).staffAmount).toBe(5000);
    expect(computeIncentives(flatMatrix, true, false, 999_999).staffAmount).toBe(5000);
  });
  it('flat referrer rate pays the flat amount', () => {
    expect(computeIncentives(flatMatrix, true, true, AMOUNT).referrerAmount).toBe(7500);
  });
});

describe('pickRates — cell selection is independent of amount', () => {
  it('no referrer always selects selfSourced for staff', () => {
    expect(pickRates(DEFAULT_MATRIX, true, false).staff).toEqual(DEFAULT_MATRIX.selfSourced);
    expect(pickRates(DEFAULT_MATRIX, false, false).staff).toEqual(DEFAULT_MATRIX.selfSourced);
  });
});
