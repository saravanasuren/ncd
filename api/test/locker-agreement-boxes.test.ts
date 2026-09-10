/**
 * The locker agreement reports where each e-signature goes (owner 2026-09-10,
 * stage 2): the customer at "Signature of Hirer(s)", the CEO at the authorised-
 * signatory block. Both boxes must fall on a real page, right-side up, so Digio
 * places the signatures inside the document rather than off the sheet.
 */
import { describe, it, expect } from 'vitest';
import { lockerAgreementPdf } from '../src/modules/reports/forms/locker-agreement.js';

// The renderer only reads company_profile; a stub that returns none exercises
// the default-header path without a database.
const stubDb = { query: async () => ({ rows: [] as unknown[] }) } as never;

const A4_W = 595, A4_H = 842;
const onPage = (b: { llx: number; lly: number; urx: number; ury: number }) =>
  b.llx >= 0 && b.urx <= A4_W && b.llx < b.urx && b.lly >= 0 && b.ury <= A4_H && b.lly < b.ury;

describe('locker agreement signature boxes', () => {
  it('returns a PDF plus both signature boxes, each on-page and upright', async () => {
    const r = await lockerAgreementPdf(stubDb, {
      customer: { full_name: 'Box Tester', pan: 'AAAPB1234Q', address: '1 Test Rd' } as never,
      locker: { lockerhub_application_id: 'la_box', locker_number: 'L1-1', size: 'Large', rent_amount: null },
      nominee: { name: 'Nom Ee', relationship: 'Brother', phone: '9700000000' },
    });
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
    expect(r.buffer.length).toBeGreaterThan(1000);
    expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');

    expect(r.hirerPage).toBeGreaterThanOrEqual(1);
    expect(r.signatoryPage).toBeGreaterThanOrEqual(1);
    expect(onPage(r.hirer)).toBe(true);
    expect(onPage(r.signatory)).toBe(true);
    // The authorised-signatory block sits BELOW the hirer line on the page, so in
    // PDF (bottom-left) coordinates its box is lower — a guard against the two
    // being captured at the same spot.
    if (r.signatoryPage === r.hirerPage) expect(r.signatory.ury).toBeLessThan(r.hirer.ury);
  });
});
