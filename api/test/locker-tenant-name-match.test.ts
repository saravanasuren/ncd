/**
 * The name guard on the locker-tenant → NCD-customer link.
 *
 * The link is only ever offered when the phone already matched, so this decides
 * one thing: is a shared phone number plus these two names the SAME person, or
 * a family sharing a handset? Every case below is a real pair from the live
 * roster (2026-07-23) — the accepted ones were verified by hand, and the
 * rejected ones are the shape that must never link, because a locker tenant
 * pointed at the wrong customer page is worse than one pointed at nothing.
 */
import { describe, it, expect } from 'vitest';
import { namesMatch } from '../src/modules/lockers/deposits.js';

describe('namesMatch', () => {
  it('accepts the same name written the same way', () => {
    expect(namesMatch('Yesothaa Ravichandran', 'YESOTHAA RAVICHANDRAN')).toBe(true);
    expect(namesMatch('Jothi Sangeetha', 'Jothi Sangeetha')).toBe(true);
    expect(namesMatch('Shilpa Nandakumar', 'SHILPA NANDAKUMAR')).toBe(true);
  });

  it('ignores word order — the same name, reversed, is still one person', () => {
    expect(namesMatch('Vani Mohan', 'MOHAN VANI')).toBe(true);
  });

  it('ignores single-letter initials, which are a prefix and not a name part', () => {
    expect(namesMatch('PALLAVI', 'K PALLAVI')).toBe(true);
    expect(namesMatch('SHANTHI S', 'SHANTHI')).toBe(true);
    expect(namesMatch('RAMAMURTHY', 'RAMAMURTHY K')).toBe(true);
    expect(namesMatch('R.Ravi', 'Ravi')).toBe(true);
  });

  it('REJECTS a name with an extra part — that is a family, not a person', () => {
    // The whole point of the guard. Same phone, one shared token, and a second
    // name that only one side carries: father and son, not one man.
    expect(namesMatch('SEENU', 'SEENU RAJAPPA')).toBe(false);
    expect(namesMatch('SATHISH', 'SATHISH VETRAYAN')).toBe(false);
    expect(namesMatch('GANGADAR', 'GANGADAR GOPAL')).toBe(false);
    expect(namesMatch('R.Ravi', 'Rajamanickam Ravi')).toBe(false);
  });

  it('rejects unrelated names and empties', () => {
    expect(namesMatch('ANBAZHAGAN NEELAGANDAN', 'KIRAN J')).toBe(false);
    expect(namesMatch('', 'SHANTHI')).toBe(false);
    expect(namesMatch('SHANTHI', '')).toBe(false);
    expect(namesMatch(null, null)).toBe(false);
    // A name of nothing but initials has no comparable tokens at all.
    expect(namesMatch('K S', 'R V')).toBe(false);
  });
});
