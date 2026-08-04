/**
 * Payment-method options for the approval screen.
 *
 * Owner, 2026-08-04: the approval screen's payment mode was a free text box and
 * should be a dropdown. Production shows why — NEFT (41), NEFT/RTGS (25),
 * RTGS (22) and neft (1) are one payment method written four ways.
 *
 * The whole risk in this change is the 638 rows reading "Other" and the 2
 * reading "Easebuzz": a dropdown that does not offer a record's own stored
 * value re-points it to the first option the moment a checker approves — silent
 * data loss, inside the screen whose job is catching mistakes. These pin that.
 */
import { describe, it, expect } from 'vitest';
import { PAYMENT_METHODS, paymentMethodOptions } from '@new-wealth/shared';

describe('paymentMethodOptions', () => {
  it('offers the canonical list when the value is already one of them', () => {
    expect(paymentMethodOptions('Cheque')).toEqual([...PAYMENT_METHODS]);
    expect(paymentMethodOptions('NEFT/RTGS')).toEqual([...PAYMENT_METHODS]);
  });

  it('keeps an unrecognised stored value so approving cannot silently change it', () => {
    // Written by the payment-link integration, never typed by staff — and not
    // a canonical choice, so it is pinned to the front and stays selected.
    expect(paymentMethodOptions('Easebuzz')[0]).toBe('Easebuzz');
    // The four-spellings problem: NEFT is NOT the same string as NEFT/RTGS,
    // so it must survive rather than be assumed equivalent.
    expect(paymentMethodOptions('NEFT')[0]).toBe('NEFT');
    expect(paymentMethodOptions('RTGS')[0]).toBe('RTGS');
    expect(paymentMethodOptions('neft')[0]).toBe('neft');
  });

  it('leaves the 638 "Other" rows alone — it is a canonical value, not a stray', () => {
    // Worth stating outright: Other is IN the list, so those rows need no
    // special handling. The dropdown offers it and they approve unchanged.
    expect(PAYMENT_METHODS).toContain('Other');
    expect(paymentMethodOptions('Other')).toContain('Other');
    expect(paymentMethodOptions('Other')).toEqual([...PAYMENT_METHODS]);
  });

  it('always includes every canonical option, so a value can be corrected', () => {
    for (const stored of ['Other', 'Easebuzz', 'NEFT', 'neft', '', null, undefined]) {
      const opts = paymentMethodOptions(stored);
      for (const m of PAYMENT_METHODS) {
        // 'neft' matches 'NEFT/RTGS'? No — but case-insensitive equality means
        // the canonical entry may appear under the stored spelling instead.
        expect(opts.some((o) => o.toLowerCase() === m.toLowerCase())).toBe(true);
      }
    }
  });

  it('preserves the stored casing rather than rewriting it', () => {
    // 'cheque' differs from 'Cheque' only by case. Substituting the canonical
    // spelling would make the field dirty and change the record on approval,
    // for a difference nobody asked to fix.
    const opts = paymentMethodOptions('cheque');
    expect(opts).toContain('cheque');
    expect(opts).not.toContain('Cheque');
    expect(opts).toHaveLength(PAYMENT_METHODS.length);
  });

  it('falls back to the canonical list when nothing is stored', () => {
    // 3 live rows are blank. There is nothing to preserve, so the approver
    // simply picks one.
    expect(paymentMethodOptions('')).toEqual([...PAYMENT_METHODS]);
    expect(paymentMethodOptions(null)).toEqual([...PAYMENT_METHODS]);
    expect(paymentMethodOptions('   ')).toEqual([...PAYMENT_METHODS]);
  });

  it('never returns duplicates', () => {
    for (const stored of ['Other', 'Cheque', 'cheque', 'NEFT', '', 'IMPS']) {
      const opts = paymentMethodOptions(stored);
      expect(new Set(opts).size).toBe(opts.length);
    }
  });
});
