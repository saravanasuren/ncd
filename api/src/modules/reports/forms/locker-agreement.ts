/**
 * The safe deposit locker agreement, PRE-FILLED, for physical signing.
 *
 * Replaced 2026-09-08 with the owner's new document ("AGREEMENT 04-SEP.pdf"):
 * ANNEXURE I (the Schedule — parties, locker, rent, licence period, operation
 * mandate, signatures) followed by ANNEXURE II (the full terms). The ten short
 * house-written clauses this file used to carry are gone; every word below is
 * from the supplied agreement.
 *
 * Still pre-filled, for the reason it always was (owner 2026-09-03: "it should
 * not be a blank application form, everything should be pre filled. only the
 * signing we have 2 ways"). Anything genuinely missing prints as a ruled blank
 * line rather than a dash, so it reads as "write here" on paper instead of
 * looking like an error.
 *
 * ─── Deliberate departures from the supplied document ───────────────────────
 *
 * 1. CLAUSE 4 (Security Deposit) is STRUCK (owner 2026-09-14, "remove the
 *    deposit one completely"). NCD lockers are rent-only: no deposit is quoted
 *    or collected, and every application 100%-waives the one LockerHub prices,
 *    so the clause described a payment that never happens. Clause 3.1(a)'s
 *    trailing "in relation to the security deposit amount will be adjusted" went
 *    with it (same instruction) — it was the only other mention, and leaving it
 *    would point at a clause that no longer exists. Nothing else moved: the
 *    later clauses keep the source's numbering, including its two clause 5s.
 *
 * 2. The VERNACULAR UNDERTAKING renders the ENGLISH limb only. The source has
 *    five languages; PDFKit ships the 14 standard PDF fonts, all Latin-1, so
 *    Tamil, Malayalam, Kannada and Devanagari would come out blank or as
 *    mojibake — worse than absent on a declaration that the customer understood
 *    the terms. Adding the Noto families (SIL OFL) to api/assets is approved and
 *    tracked separately, because it is a binary-asset change with its own risks.
 *
 * 3. The footer prints the CORRECTED corporate-office pincode (641 062, owner
 *    2026-08-28) rather than the 641048 still printed on the supplied PDF.
 */
import type { Db } from '../../../db/types.js';
import {
  renderToBuffer, drawHeader, section, kv, companyHeader, fmtDate, fmtINR,
  customerAddress, amountInWords, COLORS, COMPANY,
} from './shared.js';

export interface AgreementCustomer {
  full_name: string;
  customer_code?: string | null;
  pan?: string | null;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  father_name?: string | null;
  occupation?: string | null;
  [k: string]: unknown;            // address columns, read by customerAddress()
}
export interface AgreementLocker {
  lockerhub_application_id: string;
  /** The human-readable agreement number (DIF0001). Falls back to the LockerHub
   *  application id only when one has not been allocated. */
  agreement_no?: string | null;
  locker_number?: string | null;
  size?: string | null;
  branch?: string | null;
  lease_start?: string | null;
  lease_end?: string | null;
  rent_amount?: number | null;
  deposit_amount?: number | null;
}
export interface AgreementNominee {
  name?: string | null;
  relationship?: string | null;
  phone?: string | null;
}
/** A joint hirer (holder 2 or 3) — printed into its own block on the agreement
 *  so the person the branch added is on the document the customer e-signs. */
export interface AgreementHirer {
  position: number;
  full_name?: string | null;
  pan?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}
export interface AgreementInput {
  customer: AgreementCustomer;
  locker: AgreementLocker;
  nominee?: AgreementNominee | null;
  /** Joint hirers (holders 2 and 3). Absent positions print as ruled lines so a
   *  joint hiring can still be completed by hand at the counter. */
  hirers?: AgreementHirer[] | null;
  date?: string;
  /** Where it is signed. Defaults to the branch. */
  place?: string | null;
  /** The company's authorised signatory, printed under the Schedule's "For the
   *  Company" block. They e-sign it, so the name beside the signature should be
   *  theirs rather than a blank line. Falls back to a ruled line. */
  signatoryName?: string | null;
}

/** A value we hold, or a ruled line to write on. Never a dash: on a printed
 *  form a dash reads as "not applicable", a rule reads as "fill this in". */
const orBlank = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return s === '' ? '_______________________' : s;
};

/**
 * Fixed annual rent by locker size (owner 2026-09-10) — the round figure the
 * customer pays after the standard waiver. Fills the Schedule's "Rent per Annum"
 * when LockerHub hasn't sent a rent amount, so the agreement isn't printed blank.
 * A size we hold no figure for (e.g. Small, until the owner sets one) stays blank
 * rather than guessing.
 */
export function annualRentForSize(size: unknown): number | null {
  // LockerHub sends the size BOTH ways — "Large" on the applications we hold and
  // a bare "M" on others — so both spellings have to resolve. Matching only the
  // long form is how a Medium locker fell through to LockerHub's rent leg and
  // printed ₹23,600 (₹20,000 + 18% GST) on the contract.
  const s = String(size ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'medium' || s === 'm') return 6000;
  if (s === 'large' || s === 'l') return 12000;
  if (s === 'extralarge' || s === 'xlarge' || s === 'xl') return 20000;
  return null;
}

/**
 * ANNEXURE II, verbatim. A clause is [number, text]; an empty number is a
 * continuation paragraph, and a text-only heading is marked with `head`.
 *
 * The numbering is the SOURCE document's and is reproduced exactly, including
 * the fact that "THE COMPANY'S DISCHARGE FROM OBLIGATIONS AND LIABILITY" and
 * "LAW AND JURISDICTION" are both numbered 5. Clauses are cited by number when
 * a branch queries one, so silently renumbering them here would make our
 * printed copy disagree with the signed originals already in circulation. That
 * is also why striking clause 4 leaves a gap in the sequence rather than pulling
 * the clause 5s up to 4.
 */
type Clause = { head: string } | { n: string; t: string; indent?: number };

const TERMS: Clause[] = [
  { head: '1. LOCKER LICENCE' },
  { n: '1.1', t: 'the Company as a licensor hereby grants to the Customer as a licensee, the licence to use the safe deposit locker, the details of which are more particularly described in the Schedule to this Agreement (hereinafter referred to as the "Locker"), subject to the terms and conditions as set out under this Agreement.' },
  { n: '1.2', t: 'The Customer hereby accepts the license granted in terms hereof for fee as specified in the Schedule by way of rent (the "Rent").' },
  { n: '1.3', t: 'The license to use the Locker hereby granted is:' },
  { n: '(a)', t: 'Personal and for the Customer’s own use and not for the use of any person other than the Customer;', indent: 1 },
  { n: '(b)', t: 'Non-transferable;', indent: 1 },
  { n: '(c)', t: 'Only for legitimate purposes such as storing of valuables like jewelry and documents but not for storing any cash or currency;', indent: 1 },
  { n: '(d)', t: 'Not for storing:', indent: 1 },
  { n: '(i)', t: 'arms, weapons, explosives, drugs and/ or any contraband material; and/or', indent: 2 },
  { n: '(ii)', t: 'any perishable material and/ or radioactive material and/ or any illegal substance; and/or', indent: 2 },
  { n: '(iii)', t: 'any material which can create any hazard or nuisance to the Company or to any of its customers.', indent: 2 },
  { n: '1.4', t: 'The Customer shall have no right or property in the Locker other than the right to access and use the Locker in accordance with the terms and conditions specified under this Agreement.' },
  { n: '1.5', t: 'The Customer shall be allowed to operate the Locker:' },
  { n: '(a)', t: 'On a working day of the Company during the specific time notified from time to time by the Company for locker operation and in absence of such notification, during the business hours of the Company. However, in the event of the Company is not being able to operate for any reason beyond its control such as flood, riot, curfew, lockout etc., the Company shall not have any obligation to allow operation of Locker;', indent: 1 },
  { n: '(b)', t: 'After the Customer entering the details of such operation in the Company’s records in the form and manner as stipulated by the Company; and', indent: 1 },
  { n: '(c)', t: 'After the Customer provides identity proof, if so demanded by the Company.', indent: 1 },

  { head: '1 A. CUSTOMER’S RIGHTS' },
  { n: '(a)', t: 'The Customer shall have, subject to terms of this agreement, a right to use the Locker for keeping belongings and expect reasonable care by the Company for protecting such belongings and in case of the Company’s failure to do so, avail of such remedies as may be available from time to time under the applicable law and regulations.' },
  { n: '(b)', t: 'the Company acknowledges the Customer’s rights as may prevail from time to time under the applicable law and regulations.' },

  { head: '2. CUSTOMER’S UNDERTAKINGS AND OBLIGATIONS' },
  { n: '2.1', t: 'The Customer shall:' },
  { n: '(a)', t: 'Use the Locker only for the purpose for which it is provided and in accordance with applicable law and regulations;', indent: 1 },
  { n: '(b)', t: 'Abide by rules and regulations for locker operation as the Company may from time to time adopt;', indent: 1 },
  { n: '(c)', t: 'Keep the locker key, password or any other identification mechanism provided by the Company for opening of the Locker in a place of safety, not share the same with any other person and not allow the same to fall into hands of any other person, so as to save unauthorized use of the Locker;', indent: 1 },
  { n: '(d)', t: 'Operate the Locker only using the key, password or any other identification mechanism provided by the Company and not otherwise;', indent: 1 },
  { n: '(e)', t: 'Not to temper with or make a copy of key or any other identification mechanism provided by the Company for operation of the Locker;', indent: 1 },
  { n: '(f)', t: 'Inform the Company forthwith in case of loss of the key, password or any other identification mechanism provided by the Company for the operation of the Locker;', indent: 1 },
  { n: '(g)', t: 'Return forthwith to the Company in case of finding the key, password or any other identification mechanism provided by the Company for the operation of the Locker, earlier having been reported to the Company as lost;', indent: 1 },
  { n: '(h)', t: 'Pay to the Company the Rent when due and bear all costs incurred by the Company for-', indent: 1 },
  { n: '(i)', t: 'Changing the lock and repairs to the Locker on the Customer’s reporting of loss of key provided by the Company; and', indent: 2 },
  { n: '(ii)', t: 'Breaking open of the Locker in terms of this Agreement.', indent: 2 },
  { n: '(i)', t: 'Inform the Company forthwith in case of the change of address of the Customer providing new address and contact details including phone number, email id, mobile number etc.', indent: 1 },

  { head: '3. THE COMPANY’S RIGHTS' },
  { n: '3.1', t: 'the Company shall have a right to:' },
  { n: '(a)', t: 'Recover the Rent and any other cost incurred by the Company, in the event the same is not paid by the Customer, when due; and', indent: 1 },
  { n: '(b)', t: 'Refuse access to the Locker-', indent: 1 },
  { n: '(i)', t: 'In case the rent due on the Locker remains unpaid; and', indent: 2 },
  { n: '(ii)', t: 'Customer fails to provide proof of identity when demanded by the Company, at the time of seeking access to the Locker.', indent: 2 },

  { head: '3.2 Termination of License' },
  { n: '3.2.1', t: 'the Company shall have, in the event of the Customer’s breach of or default under this Agreement and/ or the Company being of the view that the Customer is not co-operating and/or complying with the terms and conditions of this Agreement, a right to terminate this Agreement and the license granted hereunder, after issuing to the Customer a prior written notice of not less than 3 (three) months by registered post or speed post (and also by (i) email where email id of the Customer is available; and (ii) SMS and/or WhatsApp where the mobile phone number of the Customer is available) ("Termination Notice").' },
  { n: '3.2.2', t: 'Upon receipt of the Termination Notice, the Licensor shall forthwith and before the end of the notice period stipulated under the Termination Notice surrender and vacate the Locker and handover the keys, password or any other identification mechanism and documents provided by the Company for opening of the Locker, to the Company.' },

  { head: '3.3 Breaking open of the Locker and dealing with its contents' },
  { n: '3.3.1', t: 'the Company shall have a right to break open the Locker and deal with its contents in accordance with the provisions under this Agreement, the Company’s internal policy(ies) and procedure(s) and the applicable laws and regulations, in case of any one or more of the following events-' },
  { n: '(a)', t: 'In the event Termination Notice in accordance with Clause 3.2.1 hereof is served to the Customer and the Customer does not surrender and vacate the Locker after the end of the notice period stipulated under the Termination Notice;', indent: 1 },
  { n: '(b)', t: 'The Rent remains unpaid for 3 (three) consecutive years; and', indent: 1 },
  { n: '(c)', t: 'The Locker remains inoperative (irrespective of whether Rent is paid or not) for a period of 7 (seven) years or more; and the Customer cannot be located by the Company.', indent: 1 },
  { n: '3.3.2', t: 'Before exercising the right to break open the Locker, the Company shall send to the Customer a notice his/her last known address (in addition to the Termination Notice under Clause 3.2.1 above) in writing of not less than 3 (three) months by registered post/ speed post (and also by (i) email where email id of the Customer is available; and (ii) SMS and/or WhatsApp where the mobile phone number of the Customer is available) of the Company’s proposed action of breaking open of the Locker ("Break Open Notice").' },
  { n: '3.3.3', t: 'Notwithstanding, anything contained under this Agreement the Company shall take all possible efforts to contact the Customer by sending messages on mobile phone of the Customer, sending a personal messenger to the Customer’s address, making phone calls on the Customer’s land line/ mobile phone etc. before breaking open of the Locker.' },
  { n: '3.3.4', t: 'In case the Termination Notice and the Breaking Open Notice as foresaid sent by the Company is returned undelivered or the Customer is not found to be traceable despite the Company having taken reasonable efforts including those stated under Clause 3.3.2 and 3.3.3 above, the Company shall, before breaking open the Locker, issue a public notice about the Company’s intention to break open the Locker, in minimum 2 (two) newspapers (one in English and another in local language) in the same location where the Customer resides as evidenced by the Customer’s address as stated in the Agreement or as further communicated by the Customer to the Company.' },
  { n: '3.3.5', t: 'The breaking open of a Locker shall be carried out in the presence of one authorized officer of the Company, two independent witnesses, and a Notary Public (Advocate), who shall prepare an inventory of the contents. The Company shall also record the entire locker-breaking process. In the case of electronically operated Lockers (including Smart Vaults), access for opening the Locker using the "Vault Administrator" password shall be assigned only to a senior official. A complete audit trail of all access and activities related to the opening of the Locker shall be maintained and preserved by the Company.' },
  { n: '3.3.6', t: 'Upon breaking open of the Locker, having followed the procedure as set out above, the Notary Public shall prepare inventory of the contents of the Locker and get valuation of the contents done by the Company’s approved Valuer and the contents of the Locker shall be kept in sealed envelope/ bag along with detailed inventory inside a fireproof safe in a tamper-proof way.' },
  { n: '3.3.7', t: 'In addition to the above, the Company shall also record a video of the break open process together with inventory assessment and safe keep and preserve the same so as to provide evidence in case of any dispute or court case in future.' },
  { n: '3.3.8', t: 'Furthermore, the Company shall also ensure that the details of breaking open of locker is documented in the Company’s Core Banking System (CBS) or any other computerized system compliant with the Cyber Security Framework issued by RBI from time to time, apart from locker register.' },
  { n: '3.3.9', t: 'Disposal of the articles of the Locker as recorded in the inventory prepared in the manner as stated in the paragraphs above, shall be done either by sale in public auction and the sale proceeds shall be applied first towards the Customer’s dues to the Company (including outstanding Rent, breaking open charges and any other dues) and balance be refunded to the Customer or held for the disposal at the order of the Customer.' },
  { n: '3.3.10', t: 'Before sale of the contents of the Locker by conducting public auction, a notice of not less than 3 (three) months in writing by registered post/ speed post (and also by (i) email where email id of the Customer is available; and (ii) SMS and/or WhatsApp where the mobile phone number of the Customer is available) shall be issued by the Company to the Customer about the intention of the Company to auction the contents of the locker for recovery of the dues to the Company. The said notice ("Auction Notice") shall contain the date, time and place of auction and a copy of the inventory of the contents of the Locker made in terms hereof.' },

  // 3.4 and 3.5 were MISSING from this file until 2026-09-14 — the version it
  // was built from (the 04-Sep revision) predates them, and both use a
  // number-then-title heading in the source rather than the numbered-bar style
  // the other clauses use, so an earlier heading-by-heading check walked past
  // them. Restored verbatim from "AGREEMENT 08-SEP - LOCKER".
  { head: '3.4 Delay in Payment' },
  { n: '', t: 'Delay in payment of locker rent, beyond 30 days from the due date, will attract an interest @12% p.a compounded quarterly. The Hirer is advised to pay the rent promptly and avoid liability for interest.' },

  { head: '3.5 Event of shifting of branch' },
  { n: '', t: 'In the event of shifting of branch on account or any reason including merger or closure of branch where the locker is located, warranting physical relocation of the lockers, the Company shall give public notice in two newspapers (English and one in vernacular language) in this regard and Customer shall be intimated at least one month in advance along with options for them to change or close the locker.' },


  { head: '5. THE COMPANY’S DISCHARGE FROM OBLIGATIONS AND LIABILITY' },
  { n: '5.1', t: 'the Company shall not be liable for in any case for deterioration or damage to the contents of the Locker whether caused by rain, flood, earthquake, lighting, civil disturbance or commotion, riot or war or in the event of any terrorist attack or by any other similar cause(s).' },
  { n: '5.2', t: 'the Company shall not be liable for any damage/ loss of contents of the Locker arising from any act that is attributable to the fault or negligence of the Customer whatsoever.' },
  { n: '5.3', t: 'the Company shall be discharged of its obligations and shall not be liable for any cost, loss or liability incurred by the Customer (including for any damage and/or loss of contents of Locker) in the event the Locker is broken open and its contents dealt with in keeping with the provisions of this Agreement.' },
  { n: '5.4', t: 'Regardless of the above, the Company’s liability on the Locker shall always be subject to limitation under the applicable law and regulation.' },
  { n: '5.5', t: 'The contents of the Locker shall in no manner be considered insured by the Company, and the Company shall not have any liability to insure the contents of the locker against any risk whatsoever.' },

  { head: '5. LAW AND JURISDICTION' },
  { n: '', t: 'This Agreement is made subject to Indian law and all matters arising out of it shall be subject to the jurisdiction of courts at the place of Coimbatore where the Company’s Head Office is situated.' },
];

/** The English limb of the vernacular undertaking. Tamil and Hindi need a
 *  Unicode font — see the file header. */
const VERNACULAR_EN =
  'I hereby confirm that I have read and understood all the above terms and conditions, or they have been '
  + 'explained to me in the vernacular language, and I unconditionally accept them.';

const PERIOD_OF_LICENCE =
  '1 (One) year from the date of this Agreement which at the end of such one year shall stand automatically '
  + 'extended for a further period of 1 (one) year every time unless terminated in terms hereof.';

const OPERATION_MANDATES = 'Sole / Either or Survivor / Anyone or Survivor / Jointly';

/**
 * How the company's signatory is described ON THIS DOCUMENT.
 *
 * Fixed here rather than read from company_profile.signatory_designation, which
 * holds "CEO" and is shared with the bond certificate and the investment
 * application form. The owner's supplied agreement says "Authorised Signatory"
 * and only this document changes (owner 2026-09-17) — so the other two keep
 * saying CEO, deliberately.
 *
 * It is also the more accurate word on an executed contract: it states the
 * capacity in which the person signs, not the job they hold.
 */
const SIGNATORY_DESIGNATION = 'Authorised Signatory';

/** The DECLARATION that closes the owner's document, verbatim. It sits between
 *  the vernacular undertaking and the signature block. */
const DECLARATION_BULLETS = [
  'I/We request you to allot me/us a Locker in your branch as per particulars furnished in this application.',
  'I/We agree to abide by the rules and regulations of the Company as mentioned herein and in the Safe Deposit Locker Hiring Agreement.',
  'I/We shall not assign or sublet the locker or any part of it, nor permit it to be used for any purpose other than for deposit of documents, jewellery or other valuables.',
  'I/We shall not use the locker for the deposit of any property of an explosive or destructive nature, weapons and / or any other items / things prohibited under law.',
];
const DECLARATION_CLOSING =
  'I / We have read and understood all the terms and conditions governing the hiring of safe deposit locker from '
  + 'your company which are described on this form and agree to be bound by these terms and conditions at all times '
  + 'while the locker is rented to me / us. I / We have also received a copy of the agreement.';

/** A signature box in PDF coordinates (bottom-left origin), for Digio placement. */
export interface LockerSignatureBox { llx: number; lly: number; urx: number; ury: number; }
/** One place a given signer signs. A signer can have more than one: hirer 1 and
 *  the authorised signatory each sign the Schedule AND the closing block. */
export interface LockerSignaturePlacement { box: LockerSignatureBox; page: number }
export interface LockerAgreementResult {
  buffer: Buffer;
  /** Where the CUSTOMER's e-signature goes — hirer 1's closing line. Kept for
   *  callers that only ever sign the primary. */
  hirer: LockerSignatureBox; hirerPage: number;
  /**
   * EVERY hirer, in order, with every box they sign in.
   *
   * A joint hiring is signed by all of them (owner 2026-09-12) and each needs
   * their own coordinates: Digio places one signature per signer and two signers
   * cannot share a box. `placements` is the whole list for that hirer — hirer 1
   * has two (the Schedule's witness table and the closing line, owner
   * 2026-09-14), hirers 2 and 3 have one each (their Schedule column). `box`
   * and `page` are the FIRST placement, so older single-box callers still work.
   */
  hirers: Array<{
    position: number; name: string;
    box: LockerSignatureBox; page: number;
    placements: LockerSignaturePlacement[];
  }>;
  /** Where the company AUTHORISED SIGNATORY (the CEO) e-signs — the closing
   *  block. `signatoryPlacements` adds the Schedule's "For the Company" box,
   *  which the same person signs (owner 2026-09-14). */
  signatory: LockerSignatureBox; signatoryPage: number;
  signatoryPlacements: LockerSignaturePlacement[];
}

export async function lockerAgreementPdf(db: Db, input: AgreementInput): Promise<LockerAgreementResult> {
  const profile = (await db.query<Record<string, unknown>>('SELECT * FROM company_profile WHERE id = 1')).rows[0] ?? null;
  const co = companyHeader(profile);
  const c = input.customer;
  const l = input.locker;
  const when = input.date ?? new Date().toISOString();

  // Captured during the render pass so the caller can place each e-signature.
  let hirerBox!: LockerSignatureBox, hirerPage = 1;
  const hirerBoxes: Array<{
    position: number; name: string;
    box: LockerSignatureBox; page: number; placements: LockerSignaturePlacement[];
  }> = [];
  let signatoryBox!: LockerSignatureBox, signatoryPage = 1;
  let signatoryPlacements: LockerSignaturePlacement[] = [];
  // The Schedule's witness table, filled on page 2 and merged into the signer
  // list once the closing block has been laid out too.
  const scheduleBoxes = new Map<number, LockerSignaturePlacement>();
  let scheduleSignatoryBox: LockerSignaturePlacement | null = null;

  const buffer = await renderToBuffer((doc) => {
    // renderToBuffer doesn't bufferPages, so track the page via the event.
    let pageNo = 1;
    doc.on('pageAdded', () => { pageNo++; });
    const PAGE_H = doc.page.height;
    const W = 495;
    /** Room left before the bottom margin. */
    const room = () => doc.page.height - doc.page.margins.bottom - doc.y;
    const need = (h: number) => { if (room() < h) doc.addPage(); };

    const para = (text: string, opts: { size?: number; bold?: boolean; gap?: number; align?: 'left' | 'justify' } = {}) => {
      need(28);
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 9).fillColor(COLORS.TEXT)
        .text(text, 50, doc.y, { width: W, align: opts.align ?? 'justify', lineGap: 1.4 });
      doc.y += opts.gap ?? 6;
    };

    /**
     * A section bar plus the rows under it, kept together.
     *
     * `section` and `kv` both draw at an ABSOLUTE y. Left unguarded at a page
     * boundary they half-render: the first shipped draft put the "3. LOCKER
     * RENT PER ANNUM" bar on the last line of page 1 and left page 2 holding
     * the words "Rs. (in figures)" and nothing else. `minH` is the room the
     * whole group needs, so it moves as one.
     */
    const sect = (title: string, minH: number) => { need(minH); doc.y = section(doc, doc.y, title); };
    /** A kv row that will not be split from the rows around it. */
    const row = (label: string, value: unknown, bold = false) => {
      need(22);
      doc.y = kv(doc, doc.y, label, value, bold ? { bold: true } : undefined);
    };

    // ── ANNEXURE I — SCHEDULE ────────────────────────────────────────────
    let y = drawHeader(doc, co);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.NAVY)
      .text('ANNEXURE I', 50, y, { width: W });
    y = doc.y + 2;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.NAVY)
      .text('SCHEDULE', 50, y, { width: W, align: 'center' });
    doc.y += 8;

    // The owner's number, not LockerHub's internal id — "mu57ytsh53ldvkg" on a
    // document a customer signs is junk (owner 2026-09-17). The raw id remains
    // the fallback so an agreement never prints a blank where its number goes.
    row('Agreement No.', l.agreement_no || l.lockerhub_application_id, true);
    row('Place', orBlank(input.place ?? l.branch));
    row('Date', fmtDate(when));
    doc.y += 4;

    sect('1. PARTIES TO THIS AGREEMENT', 90);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text('1(A)  THE COMPANY', 50, doc.y, { width: W });
    doc.y += 2;
    para(`${co.legal_name.toUpperCase()}, a company incorporated in India under the Companies Act, 2013 (18 of 2013), `
      + `bearing CIN ${co.cin} and having its Registered office at ${'22/3, 2nd St, Behind CMS School, Nehru Nagar, Ganapathy, Coimbatore, Tamil Nadu 641006'}, `
      + 'hereinafter referred to as the "COMPANY" (which expression shall, unless it be repugnant to the context or meaning thereof, '
      + 'be deemed to mean and include its successors in interest, assigns, holding /subsidiary/associate company/ies) of the OTHER PART '
      + 'and operating in these presents through its branch as stated below');
    row('Branch', orBlank(l.branch), true);

    doc.y += 4;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text('1(B)  THE CUSTOMER', 50, doc.y, { width: W });
    doc.y += 4;

    // Hirer 1 is the customer on file. Holders 2 and 3 are the JOINT hirers the
    // branch added (input.hirers, owner 2026-09-09) — printed here so the people
    // added at enrolment are on the very document the customer e-signs. A
    // position with no joint hirer prints as ruled lines, so a joint hiring can
    // still be completed by hand at the counter.
    // PAN is carried even though the owner's Schedule lists only name, address,
    // email and mobile. It is a particular, not a term — adding it changes no
    // obligation — and the form it replaced printed it. A locker agreement that
    // drops the hirer's PAN is a weaker KYC record than the one we had.
    //
    // Aadhaar stays DELIBERATELY absent: it is not needed to hire a locker, and
    // a full number on a page photocopied at a branch counter is exactly the
    // disclosure the Aadhaar Act s.29 exists to prevent.
    const hirer = (n: number, name: string, pan: string, address: string, email: string, mobile: string) => {
      need(84);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.TEXT).text(`Hirer ${n}`, 50, doc.y, { width: W });
      doc.y += 2;
      row('Name', name, n === 1);
      row('PAN', pan);
      row('Address', address);
      row('Email ID', email);
      row('Mobile Number', mobile);
      doc.y += 4;
    };
    const jointBy = new Map<number, AgreementHirer>();
    for (const h of input.hirers ?? []) jointBy.set(Number(h.position), h);
    const jointHirer = (n: 2 | 3) => {
      const h = jointBy.get(n);
      hirer(n,
        orBlank(h?.full_name), orBlank(h?.pan), orBlank(h?.address),
        orBlank(h?.email), orBlank(h?.phone));
    };
    hirer(1, orBlank(c.full_name), orBlank(c.pan), orBlank(customerAddress(c)), orBlank(c.email), orBlank(c.phone));
    jointHirer(2);
    jointHirer(3);

    need(80);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.TEXT).text('Nomination', 50, doc.y, { width: W });
    doc.y += 2;
    row('Name', orBlank(input.nominee?.name), !!input.nominee?.name);
    // NCD's nominees table holds no address — a ruled line, not a false dash.
    row('Address', orBlank(null));
    row('Email ID', orBlank(null));
    row('Mobile Number', orBlank(input.nominee?.phone));
    row('Relationship', orBlank(input.nominee?.relationship));
    doc.y += 6;

    sect('2. DESCRIPTION OF LOCKER', 90);
    row('Locker Number', orBlank(l.locker_number), true);
    row('Size', orBlank(l.size));
    // The key number is issued at the counter when the locker is handed over.
    row('Key Number', orBlank(null));
    doc.y += 4;

    sect('3. LOCKER RENT PER ANNUM', 100);
    /**
     * The RENT, which is the round figure for the size — M ₹6,000 · L ₹12,000 ·
     * XL ₹20,000 (owner 2026-09-17).
     *
     * LockerHub's rent leg used to win, and it is GST-INCLUSIVE and changes as
     * the application moves: before the standard waiver is applied it reads
     * ₹14,160 on a Large (₹12,000 + 18%), after it reads ₹12,000. So the printed
     * agreement said whatever the leg happened to hold at the moment somebody
     * pressed print — which is how a Large locker went out quoting ₹14,160.
     *
     * The size is fixed for the life of the hire and the rent follows from it,
     * so the contract states that. A premium (rent-free) customer still gets the
     * standard figure: the waiver is a commercial arrangement, not a term of the
     * hire (owner 2026-09-17). What was actually collected lives on the payment
     * record, which is where the GST reduction is shown.
     *
     * A size we hold no figure for (Small, until one is set) falls back to
     * LockerHub rather than printing blank.
     */
    const rent = annualRentForSize(l.size) ?? l.rent_amount;
    row('Rs. (in figures)', rent != null ? fmtINR(rent) : orBlank(null), true);
    row('Rupees (in words)', rent != null ? amountInWords(rent) : orBlank(null));
    need(16);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLORS.MUTED)
      .text('(As may be revised from time to time)   (Payable in advance)', 50, doc.y, { width: W });
    doc.y += 8;

    sect('4. PERIOD OF LICENCE', 90);
    para(PERIOD_OF_LICENCE);
    if (l.lease_start || l.lease_end) {
      row('Lease period',
        `${l.lease_start ? fmtDate(l.lease_start) : '—'}  to  ${l.lease_end ? fmtDate(l.lease_end) : '—'}`);
    }
    doc.y += 2;

    sect('5. LOCKER OPERATION MANDATES', 60);
    para(OPERATION_MANDATES + '     (circle the one that applies)');

    // ── Signatures for the Schedule ──────────────────────────────────────
    //
    // The owner's document puts the witness table here, and EVERY hirer signs
    // in it (owner 2026-09-14: "in the second page in that table - every hirer
    // signs"). Three numbered columns, exactly as supplied — the fourth this
    // file used to draw had no counterpart in the source and is gone.
    //
    // The "For the Company" block below it is signed by the SAME authorised
    // signatory who signs the closing block (owner 2026-09-14), so it is a real
    // e-signature box, not a ruled line for a wet signature.
    need(240);
    doc.y += 6;
    para('IN WITNESS WHEREOF, the Parties hereto have executed this Agreement on this date (date as mentioned above)', { bold: true, gap: 10 });

    /** A cell of the witness table. Returns the rect so a box can be captured. */
    const cell = (x: number, yTop: number, w: number, h: number) => {
      doc.save().rect(x, yTop, w, h).strokeColor(COLORS.RULE).lineWidth(0.6).stroke().restore();
    };
    /** PDF (bottom-left origin) coordinates for a top-left rect, inset so the
     *  signature image sits inside the ruled cell rather than on its border. */
    const boxOf = (x: number, yTop: number, w: number, h: number): LockerSignatureBox => ({
      llx: x + 3, lly: PAGE_H - (yTop + h - 3), urx: x + w - 3, ury: PAGE_H - (yTop + 3),
    });

    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text('For the Customer', 50, doc.y, { width: W });
    doc.y += 4;
    {
      const labelW = 96;
      const colW = (W - labelW) / 3;
      const rowH = { head: 15, sign: 48, name: 20, desig: 20 };
      let top = doc.y;
      const rowTops = {
        head: top,
        sign: top + rowH.head,
        name: top + rowH.head + rowH.sign,
        desig: top + rowH.head + rowH.sign + rowH.name,
      };
      const label = (text: string, yTop: number, h: number) => {
        cell(50, yTop, labelW, h);
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
          .text(text, 54, yTop + h / 2 - 5, { width: labelW - 8 });
      };
      cell(50, rowTops.head, labelW, rowH.head);
      label('Signature', rowTops.sign, rowH.sign);
      label('Name', rowTops.name, rowH.name);
      label('Designation*', rowTops.desig, rowH.desig);

      for (let i = 0; i < 3; i++) {
        const position = i + 1;
        const x = 50 + labelW + i * colW;
        // Column heading: the source numbers them 1, 2, 3.
        cell(x, rowTops.head, colW, rowH.head);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.NAVY)
          .text(String(position), x, rowTops.head + 4, { width: colW, align: 'center' });

        cell(x, rowTops.sign, colW, rowH.sign);
        // A box is captured only for a hirer who actually exists: the screen and
        // the e-sign chain enumerate signers from this list, so recording an
        // empty column 3 would offer a signing button for nobody.
        const who = position === 1
          ? String(c.full_name ?? '').trim()
          : String(jointBy.get(position)?.full_name ?? '').trim();
        if (position === 1 || jointBy.has(position)) {
          scheduleBoxes.set(position, { box: boxOf(x, rowTops.sign, colW, rowH.sign), page: pageNo });
        }

        cell(x, rowTops.name, colW, rowH.name);
        if (who) {
          doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.TEXT)
            .text(who, x + 3, rowTops.name + 6, { width: colW - 6, ellipsis: true, height: 10 });
        }
        cell(x, rowTops.desig, colW, rowH.desig);
      }
      doc.y = rowTops.desig + rowH.desig + 3;
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.MUTED)
        .text('(*in case where the Customer is non individual/ not signing in person)', 50, doc.y, { width: W });
      doc.y += 14;
    }

    need(96);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY)
      .text(`For the Company [${l.branch ?? 'Branch'}]:`, 50, doc.y, { width: W });
    doc.y += 4;
    {
      const labelW = 130;
      const top = doc.y;
      const rows: Array<[string, string, number]> = [
        ['Signature:', '', 44],
        ['Name of the signatory:', orBlank(input.signatoryName), 18],
        ['Designation:', SIGNATORY_DESIGNATION, 18],
      ];
      let yTop = top;
      for (const [lab, val, h] of rows) {
        cell(50, yTop, labelW, h);
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
          .text(lab, 54, yTop + h / 2 - 5, { width: labelW - 8 });
        cell(50 + labelW, yTop, W - labelW, h);
        if (lab === 'Signature:') {
          scheduleSignatoryBox = { box: boxOf(50 + labelW, yTop, W - labelW, h), page: pageNo };
        } else if (val) {
          doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.TEXT)
            .text(val, 50 + labelW + 4, yTop + h / 2 - 5, { width: W - labelW - 8 });
        }
        yTop += h;
      }
      doc.y = yTop + 14;
    }

    // ── ANNEXURE II — the agreement itself ───────────────────────────────
    doc.addPage();
    doc.y = 50;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.NAVY).text('ANNEXURE II', 50, doc.y, { width: W });
    doc.y += 4;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.NAVY)
      .text('SAFE DEPOSIT LOCKER AGREEMENT', 50, doc.y, { width: W, align: 'center' });
    doc.y += 6;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.TEXT)
      .text('THIS LOCKER AGREEMENT IS MADE BETWEEN THE COMPANY AND ITS CUSTOMER AT THE PLACE AND ON THE DATE AS STATED IN THE SCHEDULE HERE TO (THE "AGREEMENT")',
        50, doc.y, { width: W, align: 'center' });
    doc.y += 10;

    para(`${co.legal_name.toUpperCase()}, a company incorporated in India under the Companies Act, 2013 (18 of 2013), `
      + `bearing CIN ${co.cin} and having its registered office at NO: 22/3, 2nd St, Behind CMS School, Nehru Nagar, Ganapathy, Coimbatore, Tamil Nadu 641006, `
      + 'hereinafter referred to as the "COMPANY" (which expression shall, unless it be repugnant to the context or meaning thereof, be deemed to mean and include '
      + 'its successors in interest, assigns, holding /subsidiary/associate company/ies) of the OTHER PART. The expression "the Company" shall include its successors, '
      + 'administrator and assigns and the expression "the Customer" shall include, when the Customer is:');
    for (const [n, t] of [
      ['(a)', 'one or more individuals, his/ her/ their heirs(s), executor(s), administrator(s) and legal representative(s);'],
      ['(b)', 'a proprietorship firm, the proprietor and his/ her heirs(s), executor(s), administrator(s) and legal representative(s);'],
      ['(c)', 'a partnership firm, such firm and its successor, such firm’s partners, the survivor or survivors among them and the heir(s), executor(s), administrator(s), legal representative(s) of each one of them.'],
      ['(d)', 'a Public Limited Company(s), Private limited company(s), Trust(s), Association(s), other applicable legal entity(s) the heir(s), executor(s), administrator(s), legal representative(s) of each one of them.'],
    ] as Array<[string, string]>) {
      need(30);
      const top = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT).text(n, 50, top, { width: 26 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(t, 76, top, { width: W - 26, align: 'justify', lineGap: 1.4 });
      doc.y += 5;
    }
    para('(the Customer are each referred to as a "Party" and collectively as "Parties")');

    para('WHEREAS:', { bold: true, gap: 4 });
    for (const [n, t] of [
      ['(A)', 'The Customer being desirous to avail of safe deposit locker facility, has approached the Company for such facility;'],
      ['(B)', 'the Company is agreeable to provide to the Customer the safe deposit locker facility subject to certain terms and conditions; and'],
      ['(C)', 'The Parties have decided to enter into this Agreement to set out the understanding between them in this regard.'],
    ] as Array<[string, string]>) {
      need(26);
      const top = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT).text(n, 50, top, { width: 26 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(t, 76, top, { width: W - 26, align: 'justify', lineGap: 1.4 });
      doc.y += 5;
    }
    para('IT IS AGREED BY AND BETWEEN THE PARTIES AS FOLLOWS:', { bold: true, gap: 8 });

    for (const cl of TERMS) {
      if ('head' in cl) {
        need(34);
        doc.y += 4;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.NAVY).text(cl.head, 50, doc.y, { width: W });
        doc.y += 5;
        continue;
      }
      need(30);
      const x = 50 + (cl.indent ?? 0) * 18;
      const numW = 40;
      const top = doc.y;
      if (cl.n) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text(cl.n, x, top, { width: numW });
      }
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(cl.t, cl.n ? x + numW : x, top, { width: 545 - (cl.n ? x + numW : x), align: 'justify', lineGap: 1.4 });
      doc.y += 5;
    }

    // ── Vernacular undertaking ───────────────────────────────────────────
    need(120);
    doc.y += 10;
    {
      const top = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY)
        .text('VERNACULAR UNDERTAKING', 58, top + 8, { width: W - 16 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.TEXT)
        .text('English:', 58, doc.y + 4, { width: W - 16 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(VERNACULAR_EN, 58, doc.y + 1, { width: W - 16, align: 'justify', lineGap: 1.4 });
      const bottom = doc.y + 8;
      doc.save().rect(50, top, W, bottom - top).strokeColor(COLORS.GOLD).lineWidth(0.8).stroke().restore();
      doc.y = bottom + 16;
    }

    // ── Declaration ──────────────────────────────────────────────────────
    need(150);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.NAVY)
      .text('DECLARATION', 50, doc.y, { width: W });
    doc.y += 6;
    for (const b of DECLARATION_BULLETS) {
      need(26);
      const top = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT).text('\u2022', 54, top, { width: 12 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(b, 68, top, { width: W - 18, align: 'justify', lineGap: 1.4 });
      doc.y += 4;
    }
    doc.y += 4;
    para(DECLARATION_CLOSING, { gap: 12 });

    // ── Final signatures ─────────────────────────────────────────────────
    // The source's closing block, restored: ONE line, "Signature of Customers/
    // Hirer(s)" on the left and "Authorised Signatory" on the right under "For
    // Dhanam Investment and Finance Pvt.Ltd.,".
    //
    // Only hirer 1 signs here (owner 2026-09-14: "in the last page only the
    // primary - hirer 1 signs and the ceo in the other space"). Hirers 2 and 3
    // have already signed the Schedule's witness table on page 2; this file
    // briefly drew a named line per hirer instead, which was never in the
    // owner's document and is gone.
    need(110);
    const closeTop = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
      .text(`For ${co.legal_name},`, 300, closeTop, { width: 245 });
    // The signing band: hirer 1 on the left, the authorised signatory on the
    // right, both above the rule that carries their labels.
    const bandTop = closeTop + 14;
    const bandH = 40;
    const ruleY = bandTop + bandH;
    doc.save().moveTo(50, ruleY).lineTo(545, ruleY).strokeColor(COLORS.TEXT).lineWidth(0.7).stroke().restore();
    hirerPage = pageNo;
    hirerBox = { llx: 50, lly: PAGE_H - ruleY, urx: 290, ury: PAGE_H - bandTop };
    signatoryPage = pageNo;
    signatoryBox = { llx: 320, lly: PAGE_H - ruleY, urx: 545, ury: PAGE_H - bandTop };
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.MUTED)
      .text('Signature of Customers/ Hirer(s)', 50, ruleY + 4, { width: 240 });
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.MUTED)
      .text(SIGNATORY_DESIGNATION, 320, ruleY + 4, { width: 225, align: 'right' });
    doc.y = ruleY + 22;

    // The Date is the Schedule's (ANNEXURE I), not a blank to write in: the
    // sentence above the signatures says the agreement is executed "on this date
    // (date as mentioned above)", so the person signing should not have to copy a
    // date the document already holds. Same `when`, same formatter, so the two can
    // never disagree. Place stays a ruled line — it is where they sign, which may
    // not be the branch.
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
      .text('Date  ', 50, doc.y, { width: W, continued: true })
      .font('Helvetica-Bold').fillColor(COLORS.TEXT).text(fmtDate(when), { continued: true })
      .font('Helvetica').fillColor(COLORS.MUTED).text('          Place  ______________________');
    doc.y += 14;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
      .text('Branch use: scan the signed agreement and upload it against this locker application in the NCD system.',
        50, doc.y, { width: W });

    // ── Merge the two signing places into one list per signer ────────────
    // Hirer 1 signs the witness table AND this line; hirers 2 and 3 sign the
    // table only. Digio takes a list of boxes per signer, so one request per
    // person still covers every place they sign.
    const roster: Array<{ position: number; name: string }> = [
      { position: 1, name: orBlank(c.full_name) },
      ...(input.hirers ?? [])
        .slice()
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((h) => ({ position: Number(h.position), name: orBlank(h.full_name) })),
    ];
    for (const sgn of roster) {
      const placements: LockerSignaturePlacement[] = [];
      const sched = scheduleBoxes.get(sgn.position);
      if (sched) placements.push(sched);
      if (sgn.position === 1) placements.push({ box: hirerBox, page: hirerPage });
      // A signer with no box at all would be offered a button that Digio cannot
      // place; the roster is built from the same rows the table was, so this is
      // a guard, not an expected branch.
      const first = placements[0];
      if (!first) continue;
      hirerBoxes.push({
        position: sgn.position, name: sgn.name,
        box: first.box, page: first.page, placements,
      });
    }
    signatoryPlacements = [
      ...(scheduleSignatoryBox ? [scheduleSignatoryBox] : []),
      { box: signatoryBox, page: signatoryPage },
    ];

    // ── Page furniture ───────────────────────────────────────────────────
    // "Page N of M" at the top and the company block at the foot of EVERY page,
    // as in the owner's document. Done last, over buffered pages, because M is
    // only known once the clauses have finished paginating.
    //
    // The address is OURS, not the one printed on the supplied PDF: the
    // corporate-office pincode was corrected to 641 062 (owner 2026-08-28) and
    // COMPANY is the single source every other document already prints from.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // text() paginates when it crosses the bottom margin, which would append
      // a blank page per footer. Drawing below the margin needs it out of the way.
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
        .text(`Page ${i + 1} of ${range.count}`, 50, 18, { width: W, align: 'right', lineBreak: false });
      const lines = [
        co.legal_name.toUpperCase(),
        `RBI No: ${COMPANY.rbi_registration_no} | CIN: ${co.cin} | GST: ${COMPANY.gstin}`,
        `Corporate Office: ${co.corporate_office_address}`,
        `Registered Office: ${COMPANY.registered_office_address}`,
        `Contact : ${co.general_phone} | ${co.general_email} | ${co.website}`,
      ];
      let fy = PAGE_H - 46;
      for (const [n, line] of lines.entries()) {
        doc.font(n === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(6)
          .fillColor(n === 0 ? COLORS.GOLD_DEEP : COLORS.MUTED)
          .text(line, 50, fy, { width: W, align: 'center', lineBreak: false });
        fy += 7;
      }
    }
  }, { bufferPages: true });

  return {
    buffer, hirer: hirerBox, hirerPage, hirers: hirerBoxes,
    signatory: signatoryBox, signatoryPage, signatoryPlacements,
  };
}
