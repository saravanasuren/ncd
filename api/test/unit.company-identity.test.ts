/**
 * The company's own identity as it prints on every document (owner 2026-11-02).
 *
 * Dhanam Investment and Finance Limited is a PUBLIC limited company: "Private"
 * is not part of its name, and its CIN's company-class characters are PLC, not
 * PTC. Both were wrong on every certificate, acknowledgement, application form
 * and agreement the platform has ever issued, so they are pinned here.
 *
 * The two facts reach a document by different routes, which is the trap this
 * file guards: legal_name comes from company_profile (NOT NULL, so the stored
 * row always wins over the constant — migration 104 corrects it), while the CIN
 * has no column at all and can ONLY come from the constant below.
 */
import { describe, it, expect } from 'vitest';
import { COMPANY, companyHeader } from '../src/modules/reports/forms/shared.js';

describe("the company's printed identity", () => {
  it('is a public limited company — the name carries no "Private"', () => {
    expect(COMPANY.legal_name).toBe('Dhanam Investment and Finance Limited');
    expect(COMPANY.legal_name).not.toMatch(/private/i);
  });

  it('has a PLC class in its CIN, not PTC', () => {
    expect(COMPANY.cin).toBe('U64920TZ2016PLC031308');
    expect(COMPANY.cin).not.toContain('PTC');
    // A CIN runs: listing status (1) + industry code (5) + state (2) + year (4)
    // + company class (3) + registration number (6), so the class is at 13-15.
    // Only those three characters change; the exact match above catches a typo
    // anywhere else in the number.
    expect(COMPANY.cin.slice(12, 15)).toBe('PLC');
    expect(COMPANY.cin).toHaveLength(21);
  });

  it('prints the CIN from the constant because the profile has no column for it', () => {
    // Whatever company_profile holds, the CIN must still come through: a stored
    // profile cannot supply one, so this is the only source on the page.
    expect(companyHeader({ legal_name: 'Anything At All' }).cin).toBe('U64920TZ2016PLC031308');
    expect(companyHeader(null).cin).toBe('U64920TZ2016PLC031308');
  });

  it('lets the stored profile name override the constant', () => {
    // This is why the code change alone was not enough on a deployed box.
    expect(companyHeader({ legal_name: 'Dhanam Investment and Finance Private Limited' }).legal_name)
      .toBe('Dhanam Investment and Finance Private Limited');
    expect(companyHeader(null).legal_name).toBe('Dhanam Investment and Finance Limited');
    expect(companyHeader({ legal_name: '   ' }).legal_name).toBe('Dhanam Investment and Finance Limited');
  });
});
