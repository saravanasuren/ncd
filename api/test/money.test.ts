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
  it('formats lakhs/crores', () => {
    expect(formatINR('1234567.00')).toBe('₹12,34,567.00');
    expect(formatINR('500000')).toBe('₹5,00,000.00');
    expect(formatINR('999.5')).toBe('₹999.50');
  });
  it('handles negatives (money out)', () => {
    expect(formatINR('-500000')).toBe('-₹5,00,000.00');
  });
  it('symbol can be suppressed for export cells', () => {
    expect(formatINR('1234567', { symbol: false })).toBe('12,34,567.00');
  });
});
