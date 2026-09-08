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
 * ─── Two things the owner must decide, flagged rather than silently settled ──
 *
 * 1. CLAUSE 4 (Security Deposit) says the hirer pays a deposit at allotment.
 *    NCD lockers are RENT-ONLY (owner 2026-08-12) — no deposit is quoted or
 *    collected, and every application 100%-waives the one LockerHub prices. The
 *    clause is reproduced verbatim because it is the owner's legal text and
 *    editing someone's contract unasked is not our call; the Schedule carries no
 *    deposit field, so nothing here ASSERTS a payment. If lockers stay rent-only
 *    this clause should be struck from the source document.
 *
 * 2. The VERNACULAR UNDERTAKING is Tamil / English / Hindi. Only the English is
 *    rendered: PDFKit ships the 14 standard PDF fonts, all Latin-1, and no
 *    Unicode font exists in this repo — Tamil and Devanagari would come out as
 *    blanks or mojibake, which on a declaration that the customer understood the
 *    terms is worse than absent. Adding Noto Sans Tamil + Noto Sans Devanagari
 *    (SIL OFL) to api/assets and registering them makes all three printable.
 */
import type { Db } from '../../../db/types.js';
import {
  renderToBuffer, drawHeader, section, kv, companyHeader, fmtDate, fmtINR,
  customerAddress, amountInWords, COLORS,
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
export interface AgreementInput {
  customer: AgreementCustomer;
  locker: AgreementLocker;
  nominee?: AgreementNominee | null;
  date?: string;
  /** Where it is signed. Defaults to the branch. */
  place?: string | null;
}

/** A value we hold, or a ruled line to write on. Never a dash: on a printed
 *  form a dash reads as "not applicable", a rule reads as "fill this in". */
const orBlank = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return s === '' ? '_______________________' : s;
};

/**
 * ANNEXURE II, verbatim. A clause is [number, text]; an empty number is a
 * continuation paragraph, and a text-only heading is marked with `head`.
 *
 * The numbering is the SOURCE document's and is reproduced exactly, including
 * the fact that "THE COMPANY'S DISCHARGE FROM OBLIGATIONS AND LIABILITY" and
 * "LAW AND JURISDICTION" are both numbered 5. Clauses are cited by number when
 * a branch queries one, so silently renumbering them here would make our
 * printed copy disagree with the signed originals already in circulation.
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
  { n: '(a)', t: 'Recover the Rent and any other cost incurred by the Company in relation to the security deposit amount will be adjusted, in the event the same is not paid by the Customer, when due; and', indent: 1 },
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
  { n: '3.3.2', t: 'Before exercising the right to break open the Locker, the Company shall send to the Customer a notice (in addition to the Termination Notice under Clause 3.2.1 above) in writing of not less than 3 (three) months by registered post/ speed post (and also by (i) email where email id of the Customer is available; and (ii) SMS and/or WhatsApp where the mobile phone number of the Customer is available) of the Company’s proposed action of breaking open of the Locker ("Break Open Notice").' },
  { n: '3.3.3', t: 'Notwithstanding, anything contained under this Agreement the Company shall take all possible efforts to contact the Customer by sending messages on mobile phone of the Customer, sending a personal messenger to the Customer’s address, making phone calls on the Customer’s land line/ mobile phone etc. before breaking open of the Locker.' },
  { n: '3.3.4', t: 'In case the Termination Notice and the Breaking Open Notice as foresaid sent by the Company is returned undelivered or the Customer is not found to be traceable despite the Company having taken reasonable efforts including those stated under Clause 3.3.2 and 3.3.3 above, the Company shall, before breaking open the Locker, issue a public notice about the Company’s intention to break open the Locker, in minimum 2 (two) newspapers (one in English and another in local language) in the same location where the Customer resides as evidenced by the Customer’s address as stated in the Agreement or as further communicated by the Customer to the Company.' },
  { n: '3.3.5', t: 'The breaking open of a Locker shall be carried out in the presence of one authorized officer of the Company, two independent witnesses, and a Notary Public (Advocate), who shall prepare an inventory of the contents. The Company shall also record the entire locker-breaking process. In the case of electronically operated Lockers (including Smart Vaults), access for opening the Locker using the "Vault Administrator" password shall be assigned only to a senior official. A complete audit trail of all access and activities related to the opening of the Locker shall be maintained and preserved by the Company.' },
  { n: '3.3.6', t: 'Upon breaking open of the Locker, having followed the procedure as set out above, the Notary Public shall prepare inventory of the contents of the Locker and the contents done by the Company’s approved Valuer and the contents of the Locker shall be kept in sealed envelope/ bag along with detailed inventory inside a fireproof safe in a tamper-proof way.' },
  { n: '3.3.7', t: 'In addition to the above, the Company shall also record a video of the break open process together with inventory assessment and safe keep and preserve the same so as to provide evidence in case of any dispute or court case in future.' },
  { n: '3.3.8', t: 'Furthermore, the Company shall also ensure that the details of breaking open of locker is documented in the Company’s Core Banking System (CBS) or any other computerized system compliant with the Cyber Security Framework issued by RBI from time to time, apart from locker register.' },
  { n: '3.3.9', t: 'Disposal of the articles of the Locker as recorded in the inventory prepared in the manner as stated in the paragraphs above, shall be done either by sale in public auction and the sale proceeds shall be applied first towards the Customer’s dues to the Company (including outstanding Rent, breaking open charges and any other dues) and balance be refunded to the Customer or held for the disposal at the order of the Customer.' },
  { n: '3.3.10', t: 'Before sale of the contents of the Locker by conducting public auction, a notice of not less than 3 (three) months in writing by registered post/ speed post (and also by (i) email where email id of the Customer is available; and (ii) SMS and/or WhatsApp where the mobile phone number of the Customer is available) shall be issued by the Company to the Customer about the intention of the Company to auction the contents of the locker for recovery of the dues to the Company. The said notice ("Auction Notice") shall contain the date, time and place of auction and a copy of the inventory of the contents of the Locker made in terms hereof.' },

  { head: '4. Security Deposit' },
  { n: '', t: 'The Hirer shall pay the prescribed security deposit to the NBFC at the time of allotment of the locker. The security deposit shall be retained by the Company as security towards the Hirer’s obligations under this Agreement, including locker rent, applicable charges, damages or any other outstanding dues. The security deposit shall not carry any interest and shall not be treated as payment of locker rent unless otherwise specified by the Company. Upon surrender or closure of the locker, the security deposit shall be refunded to the Hirer after adjustment of all outstanding dues, charges or liabilities, if any, subject to the terms and conditions of the locker agreement and applicable RBI guidelines.' },

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

export async function lockerAgreementPdf(db: Db, input: AgreementInput): Promise<Buffer> {
  const profile = (await db.query<Record<string, unknown>>('SELECT * FROM company_profile WHERE id = 1')).rows[0] ?? null;
  const co = companyHeader(profile);
  const c = input.customer;
  const l = input.locker;
  const when = input.date ?? new Date().toISOString();

  return renderToBuffer((doc) => {
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

    row('Agreement No.', l.lockerhub_application_id, true);
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

    // Hirer 1 is the customer on file. NCD holds ONE hirer per locker; 2 and 3
    // print as ruled lines so a joint hiring can still be completed at the
    // counter rather than being silently impossible on our form.
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
    hirer(1, orBlank(c.full_name), orBlank(c.pan), orBlank(customerAddress(c)), orBlank(c.email), orBlank(c.phone));
    hirer(2, orBlank(null), orBlank(null), orBlank(null), orBlank(null), orBlank(null));
    hirer(3, orBlank(null), orBlank(null), orBlank(null), orBlank(null), orBlank(null));

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
    row('Rs. (in figures)', l.rent_amount != null ? fmtINR(l.rent_amount) : orBlank(null), true);
    row('Rupees (in words)', l.rent_amount != null ? amountInWords(l.rent_amount) : orBlank(null));
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
    need(190);
    doc.y += 6;
    para('IN WITNESS WHEREOF, the Parties hereto have executed this Agreement on this date (date as mentioned above)', { bold: true, gap: 10 });

    const sigBox = (x: number, w: number, yTop: number, h: number) => {
      doc.save().rect(x, yTop, w, h).strokeColor(COLORS.RULE).lineWidth(0.6).stroke().restore();
    };
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text('For the Customer', 50, doc.y, { width: W });
    doc.y += 4;
    {
      const top = doc.y;
      const colW = W / 4;
      for (let i = 0; i < 4; i++) {
        sigBox(50 + i * colW, colW, top, 60);
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
          .text(String(i + 1), 50 + i * colW + 4, top + 3, { width: colW - 8 });
      }
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
        .text('Signature', 52, top + 62, { width: colW });
      doc.y = top + 60;
      const labels = top + 72;
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
        .text('Name  ______________   Designation*  ______________', 50, labels, { width: W });
      doc.y = labels + 12;
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORS.MUTED)
        .text('(*in case where the Customer is non individual / not signing in person)', 50, doc.y, { width: W, align: 'center' });
      doc.y += 14;
    }

    need(110);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY)
      .text(`For the Company [${l.branch ?? 'Branch'}]`, 50, doc.y, { width: W });
    doc.y += 4;
    {
      const top = doc.y;
      sigBox(50, W, top, 56);
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED).text('Signature', 54, top + 3);
      doc.y = top + 60;
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
        .text(`Name of the signatory  ______________________          Designation  ${co.signatory_designation}`,
          50, doc.y, { width: W });
      doc.y += 14;
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

    // ── Final signatures ─────────────────────────────────────────────────
    need(130);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
      .text('_________________________________________________________________', 50, doc.y, { width: W });
    doc.y += 2;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.MUTED)
      .text('Signature of Customers / Hirer(s)', 50, doc.y, { width: W });
    doc.y += 24;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
      .text(`For ${co.legal_name},`, 50, doc.y, { width: W });
    doc.y += 40;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.MUTED)
      .text(co.signatory_designation, 50, doc.y, { width: W });
    doc.y += 18;
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
      .text(`Date  ______________________          Place  ______________________`, 50, doc.y, { width: W });
    doc.y += 14;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
      .text('Branch use: scan the signed agreement and upload it against this locker application in the NCD system.',
        50, doc.y, { width: W });
  });
}
