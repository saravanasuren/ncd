/**
 * The Schedule's "Agreement No." and "Locker Rent per Annum" (owner 2026-09-17).
 *
 * Both were wrong on a document customers sign:
 *   · the number was LockerHub's internal id — "mu57ytsh53ldvkg";
 *   · the rent came off LockerHub's rent LEG, which is GST-inclusive and moves.
 *     A Large locker printed ₹14,160 (₹12,000 + 18%) before the standard waiver
 *     was applied, and ₹12,000 after — so the contract said whatever the leg
 *     happened to hold when somebody pressed print.
 *
 * The number being STABLE is the load-bearing part. The agreement is re-rendered
 * at every signing stage and each stage signs the file the previous one
 * produced; a number that changed between renders would leave the
 * counter-signed contract carrying a different number from the customer's copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { lockerAgreementPdf, annualRentForSize } from '../src/modules/reports/forms/locker-agreement.js';
import { extractText } from './helpers/pdf-text.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.toLowerCase().replace(/[‘’']/g, '').replace(/\s+/g, '');

describe('the agreement number', () => {
  it('is DIF0001-shaped, and the SAME on every re-render', async () => {
    const { ensureAgreementNo } = await import('../src/modules/lockers/agreements.js');
    const first = await ensureAgreementNo(ctx.db, 'la_number_one');
    expect(first).toMatch(/^DIF\d{4,}$/);

    // Re-rendering must not mint a second number — this is what keeps the
    // customer's signed copy and the counter-signed copy in agreement.
    expect(await ensureAgreementNo(ctx.db, 'la_number_one')).toBe(first);
    expect(await ensureAgreementNo(ctx.db, 'la_number_one')).toBe(first);

    // A different locker gets its own.
    const second = await ensureAgreementNo(ctx.db, 'la_number_two');
    expect(second).toMatch(/^DIF\d{4,}$/);
    expect(second).not.toBe(first);
  });

  it('is what the Schedule prints, in place of the LockerHub id', async () => {
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'Number Tester', pan: 'AAAPN1234Q', address: '1 Test Rd' } as never,
      locker: { lockerhub_application_id: 'mu57ytsh53ldvkg', agreement_no: 'DIF0007', size: 'Large' },
    });
    const text = squash(extractText(r.buffer));
    expect(text).toContain(squash('DIF0007'));
    expect(text).not.toContain(squash('mu57ytsh53ldvkg'));
  });

  it('falls back to the LockerHub id rather than printing the number blank', async () => {
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'No Number', pan: 'AAAPN1234Q', address: '1 Test Rd' } as never,
      locker: { lockerhub_application_id: 'la_no_number', agreement_no: null, size: 'Large' },
    });
    expect(squash(extractText(r.buffer))).toContain(squash('la_no_number'));
  });
});

describe('the company signatory', () => {
  it('signs as "Authorised Signatory" on this document, whatever company_profile says', async () => {
    // company_profile.signatory_designation holds "CEO" and is shared with the
    // bond certificate and the application form. The owner's agreement says
    // Authorised Signatory, and ONLY this document changes (owner 2026-09-17).
    await ctx.db.query("UPDATE company_profile SET signatory_designation = 'CEO' WHERE id = 1");
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'Sig Tester', pan: 'AAAPG1234Q', address: '1 Test Rd' } as never,
      locker: { lockerhub_application_id: 'la_sig', size: 'Large' },
      signatoryName: 'Saravana Suren',
    });
    const text = squash(extractText(r.buffer));
    expect(text).toContain(squash('Authorised Signatory'));
    expect(text).not.toContain(squash('Designation:CEO'));
  });
});

describe('the rent on the Schedule', () => {
  it('is the round figure for the size — 6k / 12k / 20k, however the size is spelled', () => {
    expect(annualRentForSize('Medium')).toBe(6000);
    expect(annualRentForSize('Large')).toBe(12000);
    expect(annualRentForSize('Extra Large')).toBe(20000);
    // LockerHub sends the short form too. Matching only the long one is how a
    // Medium locker printed ₹23,600 — the GST-inclusive leg — on the contract.
    expect(annualRentForSize('M')).toBe(6000);
    expect(annualRentForSize('L')).toBe(12000);
    expect(annualRentForSize('XL')).toBe(20000);
    expect(annualRentForSize('extra-large')).toBe(20000);
    // Still nothing invented for a size with no price set.
    expect(annualRentForSize('Small')).toBeNull();
    expect(annualRentForSize('')).toBeNull();
  });

  it('ignores the GST-inclusive rent leg — a Large prints 12,000, not 14,160', async () => {
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'Rent Tester', pan: 'AAAPR1234Q', address: '1 Test Rd' } as never,
      // What LockerHub sends BEFORE the standard waiver: 12,000 + 18% GST.
      locker: { lockerhub_application_id: 'la_rent', size: 'Large', rent_amount: 14160 },
    });
    const text = squash(extractText(r.buffer));
    expect(text).toContain(squash('12,000'));
    expect(text).toContain(squash('Rupees Twelve Thousand Only'));
    expect(text).not.toContain(squash('14,160'));
  });

  it('still falls back to the leg for a size we hold no figure for', async () => {
    expect(annualRentForSize('Small')).toBeNull();
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'Small Tester', pan: 'AAAPS1234Q', address: '1 Test Rd' } as never,
      locker: { lockerhub_application_id: 'la_small', size: 'Small', rent_amount: 3540 },
    });
    expect(squash(extractText(r.buffer))).toContain(squash('3,540'));
  });
});
