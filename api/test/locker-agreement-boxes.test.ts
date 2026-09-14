/**
 * The locker agreement reports where each e-signature goes.
 *
 * The owner's document (AGREEMENT 08-SEP) has TWO signing places: the Schedule's
 * witness table on page 2, where every hirer signs, and the closing block on the
 * last page, where hirer 1 and the authorised signatory sign (owner 2026-09-14:
 * "in the second page in that table - every hirer signs. in the last page only
 * the primary - hirer 1 signs and the ceo in the other space").
 *
 * So a signer can have more than one box, and Digio must be told about all of
 * them. Every box must fall on a real page, right side up, and no two may
 * overlap — an overlap means two people's signatures stamped on top of each
 * other, which nothing downstream would catch.
 */
import { describe, it, expect } from 'vitest';
import { lockerAgreementPdf } from '../src/modules/reports/forms/locker-agreement.js';

// The renderer only reads company_profile; a stub that returns none exercises
// the default-header path without a database.
const stubDb = { query: async () => ({ rows: [] as unknown[] }) } as never;

const A4_W = 595, A4_H = 842;
type Box = { llx: number; lly: number; urx: number; ury: number };
const onPage = (b: Box) =>
  b.llx >= 0 && b.urx <= A4_W && b.llx < b.urx && b.lly >= 0 && b.ury <= A4_H && b.lly < b.ury;
const overlaps = (a: Box, b: Box) =>
  a.llx < b.urx && b.llx < a.urx && a.lly < b.ury && b.lly < a.ury;

const joint = [
  { position: 2, full_name: 'Meenakshi R', phone: '9876500001', email: 'm@example.com' },
  { position: 3, full_name: 'Karthikeyan S', phone: '9876500002', email: 'k@example.com' },
];
/** A joint hiring by default; pass [] for a sole hirer. */
const render = (hirers: typeof joint = joint) => lockerAgreementPdf(stubDb, {
  customer: { full_name: 'Box Tester', pan: 'AAAPB1234Q', address: '1 Test Rd' } as never,
  hirers,
  locker: { lockerhub_application_id: 'la_box', locker_number: 'L1-1', size: 'Large', rent_amount: null },
  nominee: { name: 'Nom Ee', relationship: 'Brother', phone: '9700000000' },
  signatoryName: 'Saravana Suren',
});

describe('locker agreement signature boxes', () => {
  it('returns a PDF plus every signature box, each on-page and upright', async () => {
    const r = await render();
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
    expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');

    expect(r.hirerPage).toBeGreaterThanOrEqual(1);
    expect(r.signatoryPage).toBeGreaterThanOrEqual(1);
    expect(onPage(r.hirer)).toBe(true);
    expect(onPage(r.signatory)).toBe(true);
    for (const h of r.hirers) for (const p of h.placements) expect(onPage(p.box)).toBe(true);
    for (const p of r.signatoryPlacements) expect(onPage(p.box)).toBe(true);
  });

  it('gives hirer 1 and the signatory two places to sign, and each joint hirer one', async () => {
    const r = await render();
    expect(r.hirers.map((h) => h.position)).toEqual([1, 2, 3]);

    const h1 = r.hirers.find((h) => h.position === 1)!;
    // The witness table (page 2 of the Schedule) AND the closing block.
    expect(h1.placements).toHaveLength(2);
    expect(new Set(h1.placements.map((p) => p.page)).size).toBe(2);
    expect(h1.placements.some((p) => p.page === r.hirerPage)).toBe(true);

    // Hirers 2 and 3 sign the witness table only — NOT the closing line.
    for (const pos of [2, 3]) {
      const h = r.hirers.find((x) => x.position === pos)!;
      expect(h.placements).toHaveLength(1);
      expect(h.placements[0]!.page).not.toBe(r.hirerPage);
    }

    // The signatory signs "For the Company" on the Schedule and the closing
    // "Authorised Signatory" space.
    expect(r.signatoryPlacements).toHaveLength(2);
    expect(r.signatoryPlacements.some((p) => p.page === r.signatoryPage)).toBe(true);
  });

  it('never puts two signatures on top of each other', async () => {
    const r = await render();
    const all = [
      ...r.hirers.flatMap((h) => h.placements.map((p) => ({ who: `hirer ${h.position}`, ...p }))),
      ...r.signatoryPlacements.map((p) => ({ who: 'signatory', ...p })),
    ];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!, b = all[j]!;
        if (a.page !== b.page) continue;
        expect(overlaps(a.box, b.box), `${a.who} overlaps ${b.who} on page ${a.page}`).toBe(false);
      }
    }
  });

  it('a sole hiring still signs in both places, with no box for absent hirers', async () => {
    const r = await render([]);
    expect(r.hirers.map((h) => h.position)).toEqual([1]);
    expect(r.hirers[0]!.placements).toHaveLength(2);
    expect(r.signatoryPlacements).toHaveLength(2);
  });
});
