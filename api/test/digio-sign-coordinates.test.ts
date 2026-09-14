/**
 * Digio places signatures from `sign_coordinates`, which is keyed by SIGNER and
 * holds a LIST of boxes per page. Two things must hold, and neither is visible
 * from the outside once a request has been sent:
 *
 *  - a signer with more than one box keeps ALL of them (the locker agreement's
 *    hirer 1 and its authorised signatory each sign the Schedule's witness table
 *    AND the closing block, on one request over one document);
 *  - signers never collapse into each other.
 *
 * A dropped second box would still produce a document that looks signed.
 */
import { describe, it, expect } from 'vitest';
import { buildSignCoordinates, type SignParty } from '../src/integrations/digio/index.js';

const box = (n: number) => ({ llx: n, lly: n, urx: n + 10, ury: n + 10 });
const idOf = (p: SignParty) => String(p.phone);

describe('digio sign_coordinates', () => {
  it('keeps every box a signer has, grouped by page', () => {
    const c = buildSignCoordinates([
      { name: 'Hirer One', phone: '1', box: box(10), page: 2, also: [{ box: box(20), page: 6 }] },
    ], idOf)!;
    expect(Object.keys(c)).toEqual(['1']);
    expect(Object.keys(c['1']!).sort()).toEqual(['2', '6']);
    expect(c['1']!['2']).toEqual([box(10)]);
    expect(c['1']!['6']).toEqual([box(20)]);
  });

  it('puts two boxes on the SAME page into one list rather than overwriting', () => {
    const c = buildSignCoordinates([
      { name: 'Twice', phone: '1', box: box(10), page: 2, also: [{ box: box(30), page: 2 }] },
    ], idOf)!;
    expect(c['1']!['2']).toEqual([box(10), box(30)]);
  });

  it('keeps signers apart', () => {
    const c = buildSignCoordinates([
      { name: 'One', phone: '1', box: box(10), page: 2, also: [{ box: box(11), page: 6 }] },
      { name: 'Two', phone: '2', box: box(20), page: 2 },
      { name: 'Three', phone: '3', box: box(30), page: 2 },
    ], idOf)!;
    expect(Object.keys(c).sort()).toEqual(['1', '2', '3']);
    expect(Object.keys(c['1']!).length).toBe(2);
    expect(Object.keys(c['2']!)).toEqual(['2']);
    expect(Object.keys(c['3']!)).toEqual(['2']);
  });

  it('is null when nobody has a box, so display_on_page stays unset', () => {
    expect(buildSignCoordinates([{ name: 'Nobody', phone: '1' }], idOf)).toBeNull();
    expect(buildSignCoordinates([], idOf)).toBeNull();
  });

  it('still works for a single-box signer, the shape every other form uses', () => {
    const c = buildSignCoordinates([{ name: 'Solo', phone: '1', box: box(10), page: 3 }], idOf)!;
    expect(c).toEqual({ '1': { '3': [box(10)] } });
  });
});
