/**
 * The locker agreement, PRE-FILLED, for physical signing (owner 2026-09-03:
 * "it should not be a blank application form, everything should be pre filled.
 * only the signing we have 2 ways").
 *
 * This is the same agreement the customer would e-Sign, printed with every
 * detail we already hold already on it — name, PAN, address, locker, branch,
 * lease dates, rent, deposit, nominee. The customer is handed a finished
 * document and writes one thing on it: their signature. Nothing is left for
 * them to fill in that the branch already knows, because a field the customer
 * hand-writes is a field that arrives back wrong.
 *
 * Anything genuinely missing prints as a ruled blank line rather than a dash,
 * so it reads as "write here" on paper instead of looking like an error.
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
}

/** A value we hold, or a ruled line to write on. Never a dash: on a printed
 *  form a dash reads as "not applicable", a rule reads as "fill this in". */
const orBlank = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return s === '' ? '_______________________' : s;
};

/** The terms. Numbered because they are referred to by number when a branch
 *  queries a clause — the numbering carries meaning, it is not decoration. */
const TERMS: string[] = [
  'The locker is let on hire for the lease period stated above and is renewable on payment of the rent then in force.',
  'The security deposit is held for the duration of the tenancy, does not carry interest, and is refunded on surrender of the locker and both keys, after deduction of any amount due.',
  'Rent is payable annually in advance. The Company may revise the rent on notice, effective from the next renewal.',
  'The locker may be operated by the hirer, or by an authorised user recorded with the branch on a signed consent, during the branch working hours notified from time to time.',
  'The Company does not know and is not required to know the contents of the locker. The hirer must not keep in the locker anything illegal, hazardous, perishable, or prohibited by law.',
  'The Company is not liable for loss or damage to the contents except where such loss arises from its own negligence or from a deficiency in the services it has undertaken to provide.',
  'The keys issued remain the property of the Company. Loss of a key must be reported to the branch at once; breaking open and replacing the lock is at the hirer’s cost.',
  'On the death of the hirer the locker is released to the nominee recorded above, or to the legal representatives, on production of the documents the Company requires.',
  'Either party may terminate the hiring on notice in writing. On termination the locker must be emptied and the keys returned.',
  'The hirer confirms that the particulars printed above are true and correct, and undertakes to inform the branch in writing of any change to them.',
];

/**
 * Build the agreement. Two pages by design: the particulars and the terms on
 * page 1-2, with the signature blocks at the end so the signed page always
 * carries the terms above it.
 */
export async function lockerAgreementPdf(db: Db, input: AgreementInput): Promise<Buffer> {
  const profile = (await db.query<Record<string, unknown>>('SELECT * FROM company_profile WHERE id = 1')).rows[0] ?? null;
  const co = companyHeader(profile);
  const c = input.customer;
  const l = input.locker;

  return renderToBuffer((doc) => {
    let y = drawHeader(doc, co);

    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.NAVY)
      .text('SAFE DEPOSIT LOCKER AGREEMENT', 50, y, { width: 495, align: 'center' });
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.MUTED)
      .text('To be signed by the hirer. All particulars below are already recorded — please check them and tell the branch of any correction.',
        50, y, { width: 495, align: 'center' });
    y = doc.y + 10;

    doc.font('Helvetica').fontSize(9).fillColor(COLORS.MUTED)
      .text(`Date: ${fmtDate(input.date ?? new Date().toISOString())}`, 50, y);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.MUTED)
      .text(`Application: ${l.lockerhub_application_id}`, 300, y, { width: 245, align: 'right' });
    y = doc.y + 8;

    // ── Locker ──
    y = section(doc, y, 'THE LOCKER');
    y = kv(doc, y, 'Locker number', orBlank(l.locker_number), { bold: true });
    y = kv(doc, y, 'Size', orBlank(l.size));
    y = kv(doc, y, 'Branch', orBlank(l.branch));
    y = kv(doc, y, 'Lease period', l.lease_start || l.lease_end
      ? `${l.lease_start ? fmtDate(l.lease_start) : '—'}  to  ${l.lease_end ? fmtDate(l.lease_end) : '—'}`
      : orBlank(null));
    if (l.rent_amount != null) y = kv(doc, y, 'Annual rent', `${fmtINR(l.rent_amount)}  (${amountInWords(l.rent_amount)})`);
    if (l.deposit_amount != null) y = kv(doc, y, 'Security deposit', `${fmtINR(l.deposit_amount)}  (${amountInWords(l.deposit_amount)})`);

    // ── Hirer ──
    y = section(doc, y + 6, 'THE HIRER');
    y = kv(doc, y, 'Name', orBlank(c.full_name), { bold: true });
    if (c.customer_code) y = kv(doc, y, 'Customer code', c.customer_code);
    y = kv(doc, y, 'PAN', orBlank(c.pan));
    y = kv(doc, y, 'Date of birth', c.dob ? fmtDate(c.dob) : orBlank(null));
    if (c.father_name) y = kv(doc, y, 'Father / spouse', c.father_name);
    if (c.occupation) y = kv(doc, y, 'Occupation', c.occupation);
    y = kv(doc, y, 'Phone', orBlank(c.phone));
    if (c.email) y = kv(doc, y, 'Email', c.email);
    // Aadhaar is DELIBERATELY absent. It is not needed to hire a locker, and a
    // full number printed on a page that is photocopied at a branch counter is
    // exactly the disclosure the Aadhaar Act §29 exists to prevent.
    y = kv(doc, y, 'Address', orBlank(customerAddress(c)));

    // ── Nominee ──
    y = section(doc, y + 6, 'NOMINEE');
    if (input.nominee?.name) {
      y = kv(doc, y, 'Name', input.nominee.name, { bold: true });
      y = kv(doc, y, 'Relationship', orBlank(input.nominee.relationship));
      if (input.nominee.phone) y = kv(doc, y, 'Phone', input.nominee.phone);
    } else {
      // No nominee on file: ruled lines so it can be completed at the counter,
      // rather than a printed "—" that quietly says none is wanted.
      y = kv(doc, y, 'Name', orBlank(null));
      y = kv(doc, y, 'Relationship', orBlank(null));
      y = kv(doc, y, 'Phone', orBlank(null));
    }

    // ── Terms ──
    doc.addPage();
    y = 50;
    y = section(doc, y, 'TERMS OF HIRING');
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT);
    TERMS.forEach((t, i) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.NAVY).text(`${i + 1}.`, 50, y, { width: 18 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.TEXT)
        .text(t, 68, y, { width: 477, align: 'justify', lineGap: 1.5 });
      y = doc.y + 7;
    });

    // ── Declaration + signatures ──
    y = section(doc, y + 8, 'DECLARATION');
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.TEXT).text(
      `I, ${c.full_name}, have read and accept the terms of hiring set out above. I confirm that the particulars printed in this agreement are true and correct, and I agree to hire the safe deposit locker described above on those terms.`,
      50, y + 2, { width: 495, align: 'justify', lineGap: 2 });
    y = doc.y + 30;

    const boxW = 210, boxH = 46;
    const drawSig = (x: number, caption: string, sub: string) => {
      doc.save().rect(x, y, boxW, boxH).strokeColor(COLORS.GOLD).lineWidth(0.6).stroke().restore();
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
        .text(caption, x, y + boxH + 3, { width: boxW });
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
        .text(sub, x, y + boxH + 13, { width: boxW });
    };
    drawSig(50, 'Signature of the hirer', c.full_name);
    drawSig(310, `For ${co.legal_name}`, co.signatory_designation || 'Authorised signatory');
    y += boxH + 34;

    doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED)
      .text(`Date  ______________________          Place  ______________________`, 50, y, { width: 495 });
    y = doc.y + 14;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.MUTED)
      .text('Branch use: scan the signed agreement and upload it against this locker application in the NCD system.',
        50, y, { width: 495 });
  });
}
