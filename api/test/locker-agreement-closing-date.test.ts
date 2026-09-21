/**
 * The closing block's Date comes from ANNEXURE I.
 *
 * Page 1 (the Schedule) carries the agreement's date, and the sentence above the
 * signatures says the agreement is executed "on this date (date as mentioned
 * above)". The block at the end — the one hirer 1 and the authorised signatory
 * sign under — printed `Date ______ Place ______` blank, so the person signing
 * had to write in a date the document already knew. It now prints the Schedule's
 * date; Place stays a ruled line.
 *
 * Each negative is paired with a positive from the same region (the signature
 * captions), and whitespace is squashed on both sides — see
 * locker-agreement-text.test.ts for why a bare "does not contain" proves nothing.
 */
import { describe, it, expect } from 'vitest';
import { lockerAgreementPdf } from '../src/modules/reports/forms/locker-agreement.js';
import { extractText } from './helpers/pdf-text.js';

const stubDb = { query: async () => ({ rows: [] as unknown[] }) } as never;
const squash = (s: string) => s.toLowerCase().replace(/[‘’']/g, '').replace(/\s+/g, '');

const render = async (date?: string) => squash(extractText((await lockerAgreementPdf(stubDb, {
  customer: { full_name: 'Closing Tester', pan: 'AAAPC1234Q', address: '1 Test Rd' } as never,
  locker: { lockerhub_application_id: 'la_close', locker_number: 'L1-1', size: 'Large', branch: 'RS Puram', rent_amount: null },
  ...(date ? { date } : {}),
})).buffer));

describe('closing block date', () => {
  it("is the Schedule's date, printed right where the signatures are", async () => {
    const t = await render('2026-09-17T06:00:00.000Z');
    // Annexure I — the source.
    expect(t).toContain(squash('Date17-Sep-2026'));
    // The closing block: the caption under the signatures comes first…
    const caption = t.indexOf(squash('Signature of Customers/ Hirer(s)'));
    expect(caption).toBeGreaterThan(-1);
    // …and the date follows it, with Place still to be written in.
    const after = t.slice(caption);
    expect(after).toContain(squash('Date17-Sep-2026'));
    expect(after).toContain(squash('Place______'));
  });

  it('the blank Date line is gone from the closing block', async () => {
    const t = await render('2026-09-17T06:00:00.000Z');
    const after = t.slice(t.indexOf(squash('Signature of Customers/ Hirer(s)')));
    expect(after).not.toContain(squash('Date______'));
  });

  it("follows whatever date the Schedule carries, not a hard-coded one", async () => {
    const t = await render('2027-01-05T06:00:00.000Z');
    const after = t.slice(t.indexOf(squash('Signature of Customers/ Hirer(s)')));
    expect(after).toContain(squash('Date05-Jan-2027'));
    expect(after).not.toContain(squash('17-Sep-2026'));
  });

  it("with no date supplied it is today's, the same as the Schedule's", async () => {
    const today = new Date();
    const expected = squash(`${String(today.getUTCDate()).padStart(2, '0')}-${today.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${today.getUTCFullYear()}`);
    const t = await render();
    expect(t.slice(t.indexOf(squash('Signature of Customers/ Hirer(s)')))).toContain(squash('Date') + expected);
  });
});
