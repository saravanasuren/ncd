/**
 * Federal Net NEFT format rules, ported from the old Wealth app
 * (utils/neft-format.js). These decide how real money is routed, so they get
 * their own unit tests.
 */
import { describe, it, expect } from 'vitest';
import { chooseTransactionType, normalizeIfsc } from '../src/lib/neft.js';

describe('NEFT transaction type', () => {
  it('is NEFT below ₹2,00,000', () => {
    expect(chooseTransactionType(199999, 'HDFC0001234')).toBe('NEFT');
    expect(chooseTransactionType(1, 'HDFC0001234')).toBe('NEFT');
  });

  it('is RTGS at ₹2,00,000 and above', () => {
    expect(chooseTransactionType(200000, 'HDFC0001234')).toBe('RTGS');
    expect(chooseTransactionType(2500000, 'ICIC0004321')).toBe('RTGS');
  });

  it('is IFT for a Federal Bank beneficiary at ANY amount', () => {
    expect(chooseTransactionType(500, 'FDRL0001234')).toBe('IFT');
    expect(chooseTransactionType(5000000, 'FDRL0001234')).toBe('IFT');
    expect(chooseTransactionType(250000, ' fdrl0001234 ')).toBe('IFT'); // case/space tolerant
  });
});

describe('IFSC normalisation', () => {
  it('is exactly 11 characters — truncated or padded', () => {
    expect(normalizeIfsc('HDFC0001234')).toBe('HDFC0001234');
    expect(normalizeIfsc('HDFC0001234XYZ')).toHaveLength(11);
    expect(normalizeIfsc('HDFC00')).toHaveLength(11);
    expect(normalizeIfsc('')).toHaveLength(11);
  });
  it('upper-cases and trims', () => {
    expect(normalizeIfsc(' hdfc0001234 ')).toBe('HDFC0001234');
  });
});
