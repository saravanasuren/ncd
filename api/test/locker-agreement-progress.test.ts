/**
 * A locker agreement must read as the state it is actually in.
 *
 * Owner 2026-10-12, on Locker Tenants: "i get to see all shows aggrement not
 * signed - but some are signed." The roster asked `WHERE status = 'Signed'`
 * and painted everything else red, so six states collapsed into one word. On
 * the live book that was 3 of 55 ticked while 20 carried real signature
 * progress — 11 of them one joint-hirer signature short, 5 waiting on the
 * authorised signatory, 1 on a checker.
 *
 * These pin the wording (signingLabel is the single source every locker screen
 * reads) and, crucially, that "nothing has happened" is still distinguishable
 * from "part-way" — collapsing those the other way would be the same bug with
 * the opposite sign.
 */
import { describe, it, expect } from 'vitest';
import { signingLabel } from '../src/modules/lockers/agreements.js';

describe('signingLabel', () => {
  it('names the method once an agreement is fully signed', () => {
    expect(signingLabel('esign', 'Signed')).toBe('e-Signed');
    expect(signingLabel('physical', 'Signed')).toBe('Physically signed');
  });

  it('says who is being waited on in the mid-states', () => {
    expect(signingLabel('esign', 'CustomerSigned')).toBe('Awaiting authorised signatory');
    expect(signingLabel('esign', 'AwaitingCEO')).toBe('Sent to authorised signatory');
    expect(signingLabel('physical', 'PendingApproval')).toBe('Scan awaiting approval');
  });

  it('counts the hirers when an agreement is part-way through', () => {
    // The 11 live lockers: the customer signed, the joint hirer never got a link.
    expect(signingLabel('esign', 'AwaitingSignature', { signed: 1, needed: 2 }))
      .toBe('1 of 2 hirers signed');
    expect(signingLabel('esign', 'AwaitingSignature', { signed: 2, needed: 3 }))
      .toBe('2 of 3 hirers signed');
  });

  it('does NOT claim progress when nothing has been collected', () => {
    // The distinction the fix exists to preserve: an untouched agreement must
    // keep reading as untouched, or the red badge becomes as useless as the
    // one it replaced.
    expect(signingLabel('esign', 'AwaitingSignature', { signed: 0, needed: 2 }))
      .toBe('Awaiting e-signature');
    expect(signingLabel('physical', 'AwaitingSignature', { signed: 0, needed: 1 }))
      .toBe('Awaiting signature on paper');
    expect(signingLabel('esign', 'AwaitingSignature')).toBe('Awaiting e-signature');
  });

  it('never reports progress past the finish line', () => {
    // signed >= needed with the row still AwaitingSignature means the status
    // simply has not caught up; "2 of 2 hirers signed" would assert a completed
    // agreement this function has no evidence for.
    expect(signingLabel('esign', 'AwaitingSignature', { signed: 2, needed: 2 }))
      .toBe('Awaiting e-signature');
  });
});
