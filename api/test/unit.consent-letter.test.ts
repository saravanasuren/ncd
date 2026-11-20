/**
 * Consent for Premature Redemption — the document that gates a redemption.
 *
 * This is the one that actually protects the Company: the holder waives the 2%
 * premium, gives up further claims and authorises the Trustee. So these tests
 * hold the six clauses and the three declarations to the owner's Word file
 * word for word, and they check the page break, because a page carrying only a
 * signature can be detached from what it consents to.
 *
 * Fixture names are neutral and word-only — assertions search the rendered text
 * for "Consent", "Declaration", "Demat" and "Signature", and a holder called
 * "Consent Holder" would satisfy one of those without the clause being there.
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { consentLetterPdf, type ConsentLetterRow } from '../src/modules/reports/forms/consent-letter.js';
import { extractText } from './helpers/pdf-text.js';

const row = (over: Partial<ConsentLetterRow> = {}): ConsentLetterRow => ({
  letter_date: '2026-11-20',
  holder_name: 'Holder Alpha',
  pan: 'ABCDE1234F',
  series: 'NCD 12',
  allotment_date: '2021-12-31',
  original_maturity_date: '2026-12-31',
  ncd_count: '3',
  face_value: 500000,
  coupon_rate_pct: 12.5,
  mode_of_holding: 'Demat',
  account_name: 'Holder Alpha',
  account_no: '005301000012345',
  bank_and_branch: 'Indian Overseas Bank, Ganapathy',
  ifsc: 'IOBA0000534',
  ...over,
});

const squash = (s: string) => s.replace(/\s+/g, '');

/** The visible text of each page, in order. */
function perPage(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  const pages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); } catch { continue; }
    if (!body.includes('BT')) continue;
    const out: string[] = [];
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = t[1]!.replace(/\s+/g, '');
      if (hex.length % 2 === 0) out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    pages.push(out.join(''));
  }
  return pages;
}

describe('the consent letter says what the owner wrote', () => {
  it('opens by naming the holder and the issuing company', async () => {
    const t = squash(extractText(await consentLetterPdf(row())));
    expect(t).toContain('ConsentforPrematureRedemption');
    expect(t).toContain(squash('I, Holder Alpha, am the registered holder of the following'));
    expect(t).toContain(squash(
      'Non-Convertible Debentures ("NCDs") issued by Dhanam Investment and Finance Limited'
      + ' (Formerly Kiara Microcredit Private Limited) ("the Company"):'));
  });

  it('carries all six numbered clauses', async () => {
    const t = squash(extractText(await consentLetterPdf(row())));
    for (const lead of [
      'Consent to premature redemption.',
      'Redemption amount.',
      'Waiver of 2% additional premium.',
      'No further claims.',
      'Payment account.',
      'Authority to Trustee.',
    ]) expect(t, lead).toContain(squash(lead));
    // Numbered 1..6 — read out of the Word file's own numbering, not inferred.
    for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) expect(extractText(await consentLetterPdf(row()))).toContain(n);
  });

  it('states the waiver and the no-further-claims clause in full', async () => {
    const t = squash(extractText(await consentLetterPdf(row())));
    expect(t).toContain(squash(
      'I understand that the Debenture Trust Deed provides for an additional premium of 2% (two per cent)'
      + ' on premature redemption.'));
    expect(t).toContain(squash(
      'I hereby voluntarily and irrevocably waive my right to receive this 2% additional premium, and any'
      + ' other prepayment premium, penalty or charge payable on premature redemption.'));
    expect(t).toContain(squash(
      'I shall have no further claim against the Company or the Debenture Trustee for principal,'
      + ' interest, premium or any other amount relating to these NCDs.'));
  });

  it('carries the three declarations', async () => {
    const t = squash(extractText(await consentLetterPdf(row())));
    expect(t).toContain(squash('I am the lawful holder of the NCDs listed above'));
    expect(t).toContain(squash('I have read and understood the terms of the NCD issue'));
    expect(t).toContain(squash('without any coercion or undue influence'));
  });

  it('fills the particulars table from the redemption', async () => {
    const t = squash(extractText(await consentLetterPdf(row())));
    expect(t).toContain('Series/Tranche');
    expect(t).toContain('NCD12');
    expect(t).toContain('31-Dec-2021');   // allotment
    expect(t).toContain('31-Dec-2026');   // original maturity
    expect(t).toContain('5,00,000');      // face value
    expect(t).toContain('FacevalueperNCD(Rs.)'); // not the ₹ glyph — no Helvetica glyph for it
    expect(t).toContain('12.5%');         // coupon
    expect(t).toContain('Demat');
    expect(t).toContain('ABCDE1234F');    // PAN at the foot
  });

  it('names the number being REDEEMED in the consent sentence', async () => {
    // Owner 2026-11-20: a partial redemption consents to the part, not the
    // whole holding.
    const t = squash(extractText(await consentLetterPdf(row({ ncd_count: '1' }))));
    expect(t).toContain(squash('to redeem all 1 NCDs held by me under Series /Rollover Series NCD 12'));
  });

  it('leaves unknown particulars blank rather than inventing a dash', async () => {
    const t = extractText(await consentLetterPdf(row({
      allotment_date: '', original_maturity_date: '', face_value: null,
      coupon_rate_pct: null, mode_of_holding: '', ncd_count: '',
    })));
    // The labels are still there to be completed by hand...
    expect(squash(t)).toContain('Modeofholding');
    expect(squash(t)).toContain('Dateofallotment');
    // ...and nothing is asserted that we do not know. "Physical" in
    // particular: demat details were only synced for about a third of the
    // book, so an empty record is not evidence of a physical holding.
    expect(t).not.toContain('Physical');
    expect(t).not.toContain('Demat');
  });
});

describe('where the consent letter breaks across pages', () => {
  it('never leaves a page carrying only the signature', async () => {
    for (const holder of [
      'Holder Alpha',
      'SARATCHANDRAN PERIASAMY THANGAPANDIAN VENKATARAMAN',
    ]) {
      const pages = perPage(await consentLetterPdf(row({ holder_name: holder })));
      const last = pages[pages.length - 1]!;
      // A bare signature page is roughly "Thanking you / Yours faithfully /
      // Signature / Name / PAN" and nothing else. The Declaration must travel
      // with it, so the final page carries that too.
      expect(squash(last), `final page for ${holder}`).toContain('Declaration');
      expect(squash(last), `final page for ${holder}`).toContain('Iconfirmthat:');
      expect(squash(last), `final page for ${holder}`).toContain('Signature');
    }
  });

  it('keeps the sign-off together with what it signs off', async () => {
    const pages = perPage(await consentLetterPdf(row()));
    const last = squash(pages[pages.length - 1]!);
    expect(last.indexOf('Thankingyou')).toBeGreaterThan(last.indexOf('undueinfluence'));
    expect(last.indexOf('Signature')).toBeGreaterThan(last.indexOf('Yoursfaithfully'));
  });
});
