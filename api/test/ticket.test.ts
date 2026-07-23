/**
 * Investment ticket rule (owner spec 2026-07-23): NCDs are issued in whole
 * ₹1,00,000 units. Pure unit tests for the rule itself.
 */
import { describe, it, expect } from 'vitest';
import { assertTicket } from '../src/lib/ticket.js';

const LAKH = { min: 100000, multiple: 100000 };

describe('ticket rule', () => {
  it('accepts whole units', () => {
    for (const a of [100000, 200000, 600000, 2500000, 10000000]) {
      expect(() => assertTicket(a, LAKH)).not.toThrow();
    }
  });

  it('rejects a non-multiple and names both neighbours', () => {
    // The amount from the real approval screen that prompted this rule.
    expect(() => assertTicket(2580369, LAKH)).toThrow(/units of ₹1,00,000/);
    expect(() => assertTicket(2580369, LAKH)).toThrow(/₹25,00,000/);
    expect(() => assertTicket(2580369, LAKH)).toThrow(/₹26,00,000/);
  });

  it('rejects half-lakh amounts — 2.5L is not a whole unit', () => {
    expect(() => assertTicket(250000, LAKH)).toThrow(/whole number of units/);
    expect(() => assertTicket(750000, LAKH)).toThrow(/whole number of units/);
  });

  it('rejects below the minimum, and zero/negative/NaN', () => {
    expect(() => assertTicket(50000, LAKH)).toThrow(/Minimum investment is ₹1,00,000/);
    expect(() => assertTicket(0, LAKH)).toThrow(/greater than zero/);
    expect(() => assertTicket(-100000, LAKH)).toThrow(/greater than zero/);
    expect(() => assertTicket(Number.NaN, LAKH)).toThrow(/greater than zero/);
  });

  it('rejects paise riding on a whole unit', () => {
    expect(() => assertTicket(100000.5, LAKH)).toThrow(/whole number of units/);
  });

  it('honours a scheme that declares a different denomination', () => {
    const tenK = { min: 10000, multiple: 10000 };
    expect(() => assertTicket(250000, tenK)).not.toThrow(); // 2.5L is fine at ₹10k units
    expect(() => assertTicket(25500, tenK)).toThrow(/units of ₹10,000/);
  });
});
