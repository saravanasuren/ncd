/**
 * The promise-to-pay paragraph on the bond certificate — the operative legal
 * text of the instrument, supplied by the owner 2026-08-28.
 *
 * Pinned because it is the part of the document that actually binds the
 * Company, and inside the PDF it is compressed and ungreppable. A silent edit
 * here would change what Dhanam has promised a debenture holder, and nothing
 * else in the suite would notice.
 *
 * The two substantive changes from the previous wording, both asserted below:
 *   · the sum appears in WORDS as well as figures;
 *   · principal and interest are stated SEPARATELY — the old text read as
 *     though interest were paid with the principal at redemption, which is not
 *     what the system does.
 */
import { describe, it, expect } from 'vitest';
import { bondLegalParagraph } from '../src/modules/reports/forms/bond.js';

const LEGAL = 'Dhanam Investment and Finance Private Limited';
const OFFICE = '2/191B, 2nd Floor, Darshini Business Centre, Mylampatty Road, Karayampalayam, '
  + 'Chinniyampalayam, Coimbatore, TN - 641 062';

describe('bond certificate — promise to pay', () => {
  const p = bondLegalParagraph(LEGAL, OFFICE, 2000000);

  it("reads as the owner's wording, start to finish", () => {
    expect(p).toBe(
      `For Value Received, ${LEGAL}, having its Corporate Office at ${OFFICE}, promises to pay to the `
      + 'person(s) named herein as the holder(s), or their order, the sum of Rs. 20,00,000 '
      + '(Rupees Twenty Lakh Only) upon presentation and discharge of this NCD Certificate on the date of '
      + 'redemption as mentioned above. The principal amount shall be payable on redemption, while interest '
      + 'shall be paid separately at the rate specified above, subject to deduction of tax at source at the '
      + 'rate prevailing from time to time under the provisions of the Income-tax Act, 1961, or any statutory '
      + 'modification or re-enactment thereof. The NCD is issued subject to and with the benefit of the '
      + 'conditions mentioned in the Private Placement Offer Letter, which shall be binding on the Company, '
      + 'the NCD Holders, and persons claiming by, through, or under any of them.');
  });

  it('states the sum in figures AND words — the protection against an altered figure', () => {
    expect(p).toContain('Rs. 20,00,000 (Rupees Twenty Lakh Only)');
    // And they must agree. A certificate whose two amounts disagree is worse
    // than one that carries only figures.
    expect(bondLegalParagraph(LEGAL, OFFICE, 500000)).toContain('Rs. 5,00,000 (Rupees Five Lakh Only)');
    expect(bondLegalParagraph(LEGAL, OFFICE, 12500000)).toContain('Rs. 1,25,00,000 (Rupees One Crore Twenty Five Lakh Only)');
  });

  it('pays principal on redemption and interest SEPARATELY, not together', () => {
    expect(p).toContain('The principal amount shall be payable on redemption, while interest shall be paid separately');
    // The old wording promised the principal "including interest…", which said
    // the opposite of what the payout run does. It must not come back.
    expect(p).not.toContain('including interest');
  });

  it('keeps the TDS and Private Placement Offer Letter undertakings', () => {
    expect(p).toContain('deduction of tax at source');
    expect(p).toContain('Income-tax Act, 1961');
    expect(p).toContain('Private Placement Offer Letter');
    expect(p).toContain('binding on the Company, the NCD Holders');
  });

  it('carries the real company name and office, not a hardcoded one', () => {
    const other = bondLegalParagraph('Some Other Co Ltd', 'Somewhere Else', 100000);
    expect(other).toContain('For Value Received, Some Other Co Ltd, having its Corporate Office at Somewhere Else,');
    expect(other).not.toContain('Dhanam');
  });

  it('the corporate office pincode is 641 062, and it is what the documents print', async () => {
    // Corrected from 641 048 by the owner 2026-08-28. company_profile has NO
    // address column, so this constant is the single source for the bond, the
    // acknowledgment and the application form alike — which is exactly why it
    // is worth pinning: a wrong pincode would print on every document issued.
    const { COMPANY } = await import('../src/modules/reports/forms/shared.js');
    expect(COMPANY.corporate_office_address).toContain('TN - 641 062');
    expect(COMPANY.corporate_office_address).not.toContain('641 048');
    // And it reaches the certificate through the same path the PDF uses.
    expect(bondLegalParagraph(COMPANY.legal_name, COMPANY.corporate_office_address, 100000))
      .toContain('Coimbatore, TN - 641 062');
  });
});
