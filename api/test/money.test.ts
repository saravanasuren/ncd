/** Money helpers — paise arithmetic + Indian formatting (docs/01 §4). */
import { describe, it, expect } from 'vitest';
import { money, addMoney, subMoney, formatINR, toPaise, fromPaise } from '@new-wealth/shared';

describe('money paise arithmetic', () => {
  it('avoids float drift', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(subMoney('500000.00', '5000.00')).toBe('495000.00');
  });
  it('round trips through paise', () => {
    expect(fromPaise(toPaise('1234567.89'))).toBe('1234567.89');
  });
  it('money() normalises to 2dp', () => {
    expect(money(1083.333)).toBe('1083.33');
    expect(money(5)).toBe('5.00');
  });
});

describe('Indian digit grouping', () => {
  // Trailing ".00" is not printed (owner 2026-08-16: "there should be no
  // decimal"). Interest is now computed in whole rupees, so two zeroes on every
  // figure is noise. Paise are still shown WHEN THERE ARE ANY — see below.
  it('formats lakhs/crores, with no empty decimals', () => {
    expect(formatINR('1234567.00')).toBe('₹12,34,567');
    expect(formatINR('500000')).toBe('₹5,00,000');
  });
  it('STILL shows paise when the amount actually has them', () => {
    // The important half. Batches paid before the whole-rupee change carry real
    // paise and match the bank statement; blanket-stripping would misreport
    // ₹56,78,842.03 as ₹56,78,842 — a different number from the one that left
    // the account.
    expect(formatINR('999.5')).toBe('₹999.50');
    expect(formatINR('5678842.03')).toBe('₹56,78,842.03');
    expect(formatINR('0.01')).toBe('₹0.01');
  });
  it('handles negatives (money out)', () => {
    expect(formatINR('-500000')).toBe('-₹5,00,000');
    expect(formatINR('-500000.25')).toBe('-₹5,00,000.25');
  });
  it('symbol can be suppressed for export cells', () => {
    expect(formatINR('1234567', { symbol: false })).toBe('12,34,567');
  });
});
