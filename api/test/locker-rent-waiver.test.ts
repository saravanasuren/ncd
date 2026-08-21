/**
 * The standard locker rent waiver (owner 2026-08-20): after it, the customer
 * pays the pre-tax rent as their WHOLE GST-inclusive bill — M 6,000, L 12,000,
 * XL 20,000.
 *
 * The bug these tests exist to prevent: LockerHub applies our waiver to the
 * PRE-TAX rent and recomputes GST on the discounted base (contract §A21). So
 * waiving "the GST amount" bills 5,805.60 on a 6,000 locker, not 6,000. The fix
 * is to send a PERCENTAGE. That is arithmetic nobody will re-derive when they
 * next touch this, so it is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { rentWaiverPctForGst, rentWaiverBreakdown, STANDARD_RENT_WAIVER_PCT } from '@new-wealth/shared';

/** What LockerHub does with our percentage, per §A21. */
const lockerHubBills = (annualRent: number, gstPct: number, waiverPct: number) => {
  const discountedBase = annualRent * (1 - waiverPct / 100);
  return discountedBase * (1 + gstPct / 100);
};

describe('standard rent waiver', () => {
  it('is 18/118 at 18% GST — the owner\'s "around 15.2%"', () => {
    expect(STANDARD_RENT_WAIVER_PCT).toBeCloseTo(15.2542372881, 8);
    expect(rentWaiverPctForGst(18)).toBeCloseTo(15.2542372881, 8);
  });

  it('is the SAME percentage for every size, because GST is', () => {
    // This is why one uniform rate lands all three sizes on a round number.
    const m = rentWaiverBreakdown(6000, 18).waiverPct;
    expect(rentWaiverBreakdown(12000, 18).waiverPct).toBeCloseTo(m, 10);
    expect(rentWaiverBreakdown(20000, 18).waiverPct).toBeCloseTo(m, 10);
  });

  it.each([
    ['M', 6000, 7080, 1080],
    ['L', 12000, 14160, 2160],
    ['XL', 20000, 23600, 3600],
  ])('%s: bills %d gross, waives %d, customer pays the round figure', (_size, rent, gross, waived) => {
    const b = rentWaiverBreakdown(rent as number, 18);
    expect(b.gross).toBe(gross);
    expect(b.waived).toBe(waived);
    expect(b.payable).toBe(rent);
    // The whole point: run our percentage through LockerHub's own arithmetic
    // and the customer must land exactly on the round rent.
    expect(lockerHubBills(rent as number, 18, b.waiverPct)).toBeCloseTo(rent as number, 6);
  });

  it('sending the GST AMOUNT instead would bill the wrong figure', () => {
    // The trap, stated as a test so nobody "simplifies" the percentage away.
    const wrong = (6000 - 1080) * 1.18;
    expect(wrong).toBeCloseTo(5805.6, 2);
    expect(wrong).not.toBeCloseTo(6000, 2);
  });

  it('follows the tax rate rather than a hardcoded 18', () => {
    // If LockerHub ever reprices GST, the waiver must move with it.
    expect(rentWaiverPctForGst(12)).toBeCloseTo((12 / 112) * 100, 10);
    expect(lockerHubBills(6000, 12, rentWaiverPctForGst(12))).toBeCloseTo(6000, 6);
    expect(lockerHubBills(6000, 5, rentWaiverPctForGst(5))).toBeCloseTo(6000, 6);
  });

  it('refuses to invent a waiver when there is no GST', () => {
    // 0% GST means the bill is already the round figure — waiving anything
    // would be giving money away for nothing.
    expect(rentWaiverPctForGst(0)).toBe(0);
    expect(rentWaiverPctForGst(NaN)).toBe(0);
  });
});
