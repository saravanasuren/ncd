/**
 * A locker record is matched to a customer by PHONE AND FULL NAME, never phone
 * alone (owner 2026-08-19).
 *
 * What happened: a brand-new NCD customer "EASHWAR" was created and immediately
 * showed a locker application APP-2026-01122 raised twelve days earlier —
 * because LockerHub holds "Eashwar ram" on the same number. Nothing had been
 * created; NCD simply presented someone else's ₹3,00,000 application as this
 * customer's own.
 *
 * The tenants roster already refused that match ("a shared phone plus one shared
 * token is the signature of a family, not of one person"). The customer card did
 * not. These pin that the two now agree — and that a genuine match still links,
 * because a guard that refuses everything is no better than one that refuses
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import { namesMatch } from '../src/modules/lockers/deposits.js';

describe('phone is not identity — the full-name guard', () => {
  it('REFUSES the case that caused this: EASHWAR vs "Eashwar ram"', () => {
    // One extra name part is exactly the family signature. It must not link.
    expect(namesMatch('EASHWAR', 'Eashwar ram')).toBe(false);
  });

  it('refuses a parent and child sharing one number', () => {
    expect(namesMatch('SEENU', 'SEENU RAJAPPA')).toBe(false);
    expect(namesMatch('Vijaya Palanisamy', 'Palanisamy K S')).toBe(false);
  });

  it('STILL links the same person, whatever the case or word order', () => {
    // The guard has to stay useful: refusing everything would just move the
    // problem to "why is my customer's own locker missing".
    expect(namesMatch('MOHAN VANI', 'Vani Mohan')).toBe(true);
    expect(namesMatch('eashwar ram', 'EASHWAR RAM')).toBe(true);
  });

  it('treats a single-letter initial as a prefix, not a name part', () => {
    // "K PALLAVI" is how "PALLAVI" is written in full on a document.
    expect(namesMatch('K PALLAVI', 'PALLAVI')).toBe(true);
  });

  it('never links on an empty or missing name', () => {
    expect(namesMatch('', 'Eashwar ram')).toBe(false);
    expect(namesMatch('EASHWAR', '')).toBe(false);
    expect(namesMatch(null, undefined)).toBe(false);
  });
});
