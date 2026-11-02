/**
 * Which series take the Subordinate Debt Certificate (owner 2026-10-31).
 *
 * This is the load-bearing decision in bond.ts: NCD 29, NCD BOND and NCD
 * Doubling are subordinated bonds and get ICL-style wording. Every other series
 * is a SECURED debenture and must keep the Debenture Certificate — relabelling
 * one would tell the holder something untrue about the instrument they hold.
 */
import { describe, it, expect } from 'vitest';
import { isSubordinate } from '../src/modules/reports/forms/bond.js';

describe('only the subordinate-debt series get the new certificate', () => {
  it('the three the owner named', () => {
    expect(isSubordinate('NCD_29', 'NCD 29')).toBe(true);
    expect(isSubordinate('NCD BOND', 'NCD BOND')).toBe(true);
    expect(isSubordinate('NCD Doubling', 'NCD Doubling')).toBe(true);
  });

  it('every other series keeps the Debenture Certificate', () => {
    for (const code of ['NCD_28', 'NCD_27', 'NCD_26', 'NCD_22', 'NCD_10_ROLLOVER']) {
      expect(isSubordinate(code, code.replace('_', ' ')), `${code} must NOT be relabelled`).toBe(false);
    }
  });

  it('a missing or near-miss series does not accidentally qualify', () => {
    expect(isSubordinate(null, null)).toBe(false);
    expect(isSubordinate(undefined, undefined)).toBe(false);
    expect(isSubordinate('', '')).toBe(false);
    expect(isSubordinate('NCD_292', 'NCD 292')).toBe(false);
    expect(isSubordinate('NCD BONDS', 'NCD BONDS')).toBe(false);
  });

  it('matches on either the code or the name, since the name is editable in Settings', () => {
    expect(isSubordinate('SOMETHING_ELSE', 'NCD Doubling')).toBe(true);
    expect(isSubordinate('NCD_29', 'renamed in settings')).toBe(true);
  });
});
