/**
 * Which series take the Subordinate Debt Certificate.
 *
 * This is the load-bearing decision in bond.ts: a subordinated bond gets
 * ICL-style wording, and every other series is a SECURED debenture that must
 * keep the Debenture Certificate — relabelling one would tell the holder
 * something untrue about where they rank if the company fails.
 *
 * It used to be decided by matching the series CODE against a hardcoded set of
 * three. The owner is now adding one subordinate series per month
 * (2026-11-02), and under the old rule every one of them would have fallen
 * through to the Debenture Certificate. The decision therefore lives on the
 * series row, as `is_subordinate`, and these tests pin that it is read from
 * there and from nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { isSubordinate } from '../src/modules/reports/forms/bond.js';

describe('a series is subordinate because its row says so', () => {
  it('takes the flag, whatever the series is called', () => {
    expect(isSubordinate({ is_subordinate: true })).toBe(true);
    // The monthly series the owner is creating — names that match nothing.
    expect(isSubordinate({ code: 'SD1', name: 'Subordinate Debt 1', is_subordinate: true })).toBe(true);
    expect(isSubordinate({ code: 'SD5', name: 'Subordinate Debt 5', is_subordinate: true })).toBe(true);
  });

  it('keeps the Debenture Certificate for anything not flagged', () => {
    for (const code of ['NCD_28', 'NCD_27', 'NCD_26', 'NCD_22', 'NCD_10_ROLLOVER']) {
      expect(isSubordinate({ code, name: code, is_subordinate: false })).toBe(false);
    }
  });

  it('does NOT infer it from the code or the name', () => {
    // The whole point of the change. A series called "Subordinate Debt 9" that
    // nobody flagged is NOT subordinate — the flag is the only authority, so a
    // series cannot acquire subordinate wording by being named suggestively.
    expect(isSubordinate({ code: 'NCD_29', name: 'NCD 29' })).toBe(false);
    expect(isSubordinate({ code: 'SD9', name: 'Subordinate Debt 9' })).toBe(false);
    expect(isSubordinate({ code: 'NCD Doubling', name: 'NCD Doubling', is_subordinate: false })).toBe(false);
  });

  it('treats a missing or odd row as not subordinate', () => {
    // Defaulting the other way would quietly restyle a secured debenture.
    expect(isSubordinate(null)).toBe(false);
    expect(isSubordinate(undefined)).toBe(false);
    expect(isSubordinate({})).toBe(false);
    // Strictly true — a string from a loose driver must not pass.
    expect(isSubordinate({ is_subordinate: 'true' })).toBe(false);
    expect(isSubordinate({ is_subordinate: 1 })).toBe(false);
  });
});
