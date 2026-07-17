/** State-machine transition legality (docs/01 §4). */
import { describe, it, expect } from 'vitest';
import { assertTransition } from '../src/lib/statusMachine.js';
import { canTransition, isTerminal } from '@new-wealth/shared';
import { AppError } from '../src/lib/errors.js';

describe('application lifecycle transitions', () => {
  it('allows the legal happy path', () => {
    expect(canTransition('application', 'Draft', 'PendingFundVerification')).toBe(true);
    // Activation path: funded → PendingActivation → Active (allotment is separate).
    expect(canTransition('application', 'PendingFundVerification', 'PendingActivation')).toBe(true);
    expect(canTransition('application', 'PendingActivation', 'Active')).toBe(true);
    expect(canTransition('application', 'Active', 'Redeemed')).toBe(true);
  });
  it('rejects illegal jumps', () => {
    expect(canTransition('application', 'Draft', 'Active')).toBe(false);
    expect(canTransition('application', 'Redeemed', 'Active')).toBe(false);
  });
  it('terminal states are terminal', () => {
    expect(isTerminal('application', 'Redeemed')).toBe(true);
    expect(isTerminal('application', 'Active')).toBe(false);
  });
  it('assertTransition throws AppError(409) on illegal jump', () => {
    expect(() => assertTransition('application', 'Draft', 'Active')).toThrowError(AppError);
    try {
      assertTransition('application', 'Draft', 'Active');
    } catch (e) {
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe('ILLEGAL_TRANSITION');
    }
  });
});

describe('series + redemption lifecycles', () => {
  it('series Open → Allotted → Closed', () => {
    expect(canTransition('series', 'Open', 'Allotted')).toBe(true);
    expect(canTransition('series', 'Allotted', 'Closed')).toBe(true);
  });
  it('redemption Requested → Approved → Paid', () => {
    expect(canTransition('redemption', 'Requested', 'Approved')).toBe(true);
    expect(canTransition('redemption', 'Approved', 'Paid')).toBe(true);
    expect(canTransition('redemption', 'Requested', 'Paid')).toBe(false);
  });
});
