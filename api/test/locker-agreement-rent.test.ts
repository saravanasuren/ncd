/**
 * The locker agreement fills "Rent per Annum" from the fixed rent for the size
 * when LockerHub sends no amount (owner 2026-09-10): Medium 6,000 · Large 12,000
 * · Extra Large 20,000. Any other size stays blank rather than guessing.
 */
import { describe, it, expect } from 'vitest';
import { annualRentForSize } from '../src/modules/reports/forms/locker-agreement.js';

describe('annualRentForSize', () => {
  it('maps the three sized rents, case-insensitively', () => {
    expect(annualRentForSize('Medium')).toBe(6000);
    expect(annualRentForSize('large')).toBe(12000);
    expect(annualRentForSize('Extra Large')).toBe(20000);
    expect(annualRentForSize('XL')).toBe(20000);
  });
  it('returns null for a size we hold no figure for, so it prints blank', () => {
    expect(annualRentForSize('Small')).toBeNull();
    expect(annualRentForSize('')).toBeNull();
    expect(annualRentForSize(null)).toBeNull();
    expect(annualRentForSize(undefined)).toBeNull();
  });
});
