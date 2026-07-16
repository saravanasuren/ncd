/** TDS branches — ported from the old app's locked tests (docs/02 §6). */
import { describe, it, expect } from 'vitest';
import { computeTds } from '../src/lib/tds.js';

const stdRule = { rate_pct: 10 };
const interestDue = { due_type: 'Interest', gross_amount: 10000, due_date: '2026-06-30' };

describe('computeTds — every branch of the decision tree', () => {
  it('standard resident: 10% of gross', () => {
    expect(computeTds(stdRule, { is_nri: false }, { payout_frequency: 'Monthly' }, interestDue)).toBe(1000);
  });
  it('no rule at all → zero', () => {
    expect(computeTds(null, { is_nri: false }, {}, interestDue)).toBe(0);
  });
  it('pure principal redemption (non-cumulative) → zero', () => {
    const red = { due_type: 'Redemption', gross_amount: 500000, due_date: '2029-04-01' };
    expect(computeTds(stdRule, { is_nri: false }, { payout_frequency: 'Monthly' }, red)).toBe(0);
  });
  it('cumulative redemption: TDS on the interest portion only', () => {
    const red = { due_type: 'Redemption', gross_amount: 650000, due_date: '2029-04-01' };
    expect(
      computeTds(stdRule, { is_nri: false }, { payout_frequency: 'Cumulative', amount: 500000 }, red)
    ).toBe(15000);
  });
  it('line-level tds_applicable=false overrides everything → zero', () => {
    expect(
      computeTds(
        stdRule,
        { is_nri: false, tds_applicable: true },
        { payout_frequency: 'Monthly', tds_applicable: false },
        interestDue
      )
    ).toBe(0);
  });
  it('customer-level tds_applicable=false → zero', () => {
    expect(
      computeTds(stdRule, { is_nri: false, tds_applicable: false }, { payout_frequency: 'Monthly' }, interestDue)
    ).toBe(0);
  });
  it('valid 15G (resident) → zero', () => {
    expect(
      computeTds(
        stdRule,
        { is_nri: false, tds_applicable: true, tax_form: '15G', tax_form_expires_on: '2099-12-31' },
        { payout_frequency: 'Monthly' },
        interestDue
      )
    ).toBe(0);
  });
  it('EXPIRED 15G → TDS applies again', () => {
    expect(
      computeTds(
        stdRule,
        { is_nri: false, tds_applicable: true, tax_form: '15G', tax_form_expires_on: '2020-01-01' },
        { payout_frequency: 'Monthly' },
        interestDue
      )
    ).toBe(1000);
  });
  it('active LDC rate wins when payout is inside its window', () => {
    const ldc = { is_active: true, rate_pct: 5, valid_from: '2026-01-01', valid_to: '2026-12-31' };
    expect(
      computeTds(stdRule, { is_nri: false, tds_applicable: true }, { payout_frequency: 'Monthly' }, interestDue, ldc)
    ).toBe(500);
  });
  it('LDC outside its validity window is ignored', () => {
    const ldc = { is_active: true, rate_pct: 5, valid_from: '2025-01-01', valid_to: '2025-12-31' };
    expect(
      computeTds(stdRule, { is_nri: false, tds_applicable: true }, { payout_frequency: 'Monthly' }, interestDue, ldc)
    ).toBe(1000);
  });
});
