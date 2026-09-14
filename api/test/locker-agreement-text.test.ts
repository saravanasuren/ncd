/**
 * What the locker agreement SAYS, pinned against the owner's supplied document
 * ("AGREEMENT 08-SEP - LOCKER").
 *
 * Every negative here is paired with a positive from the same region of the
 * page. PDFKit justifies these paragraphs, which emits one word at a time with
 * no spaces between them, and the whole clause block is one long run — so a
 * bare "does not contain" would pass just as happily if the text were
 * unreadable, which is how an earlier version of this check proved nothing.
 * Whitespace is stripped from both sides so the comparison survives the
 * justification.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { lockerAgreementPdf } from '../src/modules/reports/forms/locker-agreement.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stubDb = { query: async () => ({ rows: [] as unknown[] }) } as never;

/** The PDF's text, lower-cased with ALL whitespace removed. */
function agreementText(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'agr-'));
  try {
    const pdf = join(dir, 'a.pdf'), txt = join(dir, 'a.txt');
    writeFileSync(pdf, buf);
    execFileSync('pdftotext', [pdf, txt]);
    return squash(readFileSync(txt, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** Lower-case, no whitespace, straight quotes — the document uses typographic
 *  apostrophes, and justified text has no spaces between words at all. */
const squash = (s: string) =>
  s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, '');

let text = '';
beforeAll(async () => {
  const r = await lockerAgreementPdf(stubDb, {
    customer: { full_name: 'Text Tester', pan: 'AAAPT1234Q', address: '1 Test Rd' } as never,
    hirers: [{ position: 2, full_name: 'Joint Two', phone: '9876500001' }],
    locker: { lockerhub_application_id: 'la_text', locker_number: 'L1-1', size: 'Large', rent_amount: null },
    nominee: { name: 'Nom Ee', relationship: 'Brother', phone: '9700000000' },
    signatoryName: 'Saravana Suren',
  });
  text = agreementText(r.buffer);
});

describe('locker agreement wording', () => {
  it('has no security deposit clause, while the clauses either side of it remain', async () => {
    // Positives first: if these are missing the negative below means nothing.
    expect(text).toContain(squash('3.5 Event of shifting of branch'));
    expect(text).toContain(squash("THE COMPANY'S DISCHARGE FROM OBLIGATIONS AND LIABILITY"));
    // Owner 2026-09-14: "remove the deposit one completely."
    expect(text).not.toContain(squash('SECURITY DEPOSIT'));
    expect(text).not.toContain(squash('prescribed security deposit'));
  });

  it('drops the deposit words from 3.1(a) but keeps the recovery right', async () => {
    expect(text).toContain(squash(
      'Recover the Rent and any other cost incurred by the Company, in the event the same is not paid by the Customer, when due'));
    expect(text).not.toContain(squash('in relation to the security deposit amount will be adjusted'));
  });

  it('carries the two clauses the 04-Sep revision was missing', async () => {
    expect(text).toContain(squash('3.4 Delay in Payment'));
    expect(text).toContain(squash(
      'Delay in payment of locker rent, beyond 30 days from the due date, will attract an interest @12% p.a compounded quarterly'));
    expect(text).toContain(squash('3.5 Event of shifting of branch'));
    expect(text).toContain(squash('warranting physical relocation of the lockers'));
  });

  it('restores the two phrases that had dropped out of 3.3', async () => {
    expect(text).toContain(squash('send to the Customer a notice his/her last known address'));
    expect(text).toContain(squash('and get valuation of the contents done by'));
  });

  it('closes with the owner\'s own signature wording, not per-hirer lines', async () => {
    expect(text).toContain(squash('Signature of Customers/ Hirer(s)'));
    expect(text).toContain(squash('Authorised Signatory'));
    // A brief 2026-09-12 version replaced the owner's single line with one named
    // line per hirer. That was never in their document.
    expect(text).not.toContain(squash('Signature of Hirer 1'));
    expect(text).not.toContain(squash('Signature of Hirer 2'));
  });

  it('carries the declaration and the witness table', async () => {
    expect(text).toContain(squash('DECLARATION'));
    expect(text).toContain(squash('I/We request you to allot me/us a Locker in your branch'));
    expect(text).toContain(squash('I / We have also received a copy of the agreement.'));
    expect(text).toContain(squash('IN WITNESS WHEREOF'));
    expect(text).toContain(squash('(*in case where the Customer is non individual/ not signing in person)'));
    // Both hirers are named in the witness table's Name row.
    expect(text).toContain(squash('Text Tester'));
    expect(text).toContain(squash('Joint Two'));
  });

  it('foots every page with the company block and numbers them', async () => {
    expect(text).toContain(squash('Page 1 of'));
    expect(text).toContain(squash('GST: 33AAGCK3310G1Z2'));
    expect(text).toContain(squash('RBI No: N-07.00831'));
    // The corrected corporate-office pincode (owner 2026-08-28), not the 641048
    // still printed on the supplied PDF.
    expect(text).toContain(squash('641 062'));
  });
});
