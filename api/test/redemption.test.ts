/** Premature redemption math (docs/02 §6). Net = Principal − Penalty. */
import { describe, it, expect } from 'vitest';
import { computeRedemption } from '../src/lib/redemption.js';

describe('computeRedemption', () => {
  it('default 1% penalty: ₹5L → penalty ₹5000, net ₹4,95,000', () => {
    const r = computeRedemption({ principal: 500000 });
    expect(r.penalty).toBe(5000);
    expect(r.netPayment).toBe(495000);
  });
  it('flat penalty overrides percent', () => {
    const r = computeRedemption({ principal: 500000, penalty: { mode: 'flat', value: 2500 } });
    expect(r.penalty).toBe(2500);
    expect(r.netPayment).toBe(497500);
  });
  it('broken interest is computed separately (÷365 default), not folded into netPayment', () => {
    const r = computeRedemption({
      principal: 500000,
      couponRatePct: 10,
      lastRegularPayoutDate: '2027-03-28',
      redemptionDate: '2027-03-30', // 2 days
    });
    // 5L × 10% × 2/365 = ₹273.97
    expect(r.brokenInterest).toBeCloseTo(273.97, 2);
    // netPayment must NOT include broken interest
    expect(r.netPayment).toBe(495000);
  });
  it('no interest inputs → brokenInterest 0', () => {
    expect(computeRedemption({ principal: 500000 }).brokenInterest).toBe(0);
  });
});
