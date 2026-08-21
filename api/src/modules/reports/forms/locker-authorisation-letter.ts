/**
 * Locker authorised-user consent letter (owner 2026-08-22). The locker HOLDER
 * signs this to authorise another named person to operate the locker. It is the
 * document Digio e-signs; the holder's signature box is returned in PDF
 * coordinates (bottom-left origin) so the caller can place the eSignature there.
 */
import type { Db } from '../../../db/types.js';
import { renderToBuffer, drawHeader, section, kv, companyHeader, fmtDate, COLORS } from './shared.js';

const PAGE_H = 842; // A4 height in points — for the top-left → bottom-left flip

export interface SignatureBox { llx: number; lly: number; urx: number; ury: number; }
export interface AuthLetterInput {
  owner: { full_name: string; customer_code?: string | null; pan?: string | null; phone?: string | null };
  authorised: { name: string; pan?: string | null; aadhaar?: string | null; phone?: string | null };
  locker: { locker_no?: string | null; branch?: string | null; size?: string | null; lockerhub_application_id: string };
  date?: string;
}
export interface AuthLetterResult { buffer: Buffer; signatureBox: SignatureBox; signaturePage: number; }

export async function authorisedUserConsentPdf(db: Db, input: AuthLetterInput): Promise<AuthLetterResult> {
  const profile = (await db.query<Record<string, unknown>>('SELECT * FROM company_profile WHERE id = 1')).rows[0] ?? null;
  const co = companyHeader(profile);
  let box: SignatureBox = { llx: 50, lly: 60, urx: 270, ury: 100 };
  const buffer = await renderToBuffer((doc) => {
    let y = drawHeader(doc, co);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.NAVY).text('LOCKER AUTHORISED-USER CONSENT', 50, y, { width: 495, align: 'center' });
    y = doc.y + 8;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.MUTED).text(`Date: ${fmtDate(input.date ?? new Date().toISOString())}`, 50, y);
    y = doc.y + 8;

    y = section(doc, y, 'LOCKER');
    y = kv(doc, y, 'Locker number', input.locker.locker_no ?? '—');
    y = kv(doc, y, 'Branch', input.locker.branch ?? '—');
    y = kv(doc, y, 'Size', input.locker.size ?? '—');
    y = kv(doc, y, 'Application', input.locker.lockerhub_application_id);

    y = section(doc, y + 6, 'LOCKER HOLDER (giving consent)');
    y = kv(doc, y, 'Name', input.owner.full_name, { bold: true });
    if (input.owner.customer_code) y = kv(doc, y, 'Customer code', input.owner.customer_code);
    if (input.owner.pan) y = kv(doc, y, 'PAN', input.owner.pan);
    if (input.owner.phone) y = kv(doc, y, 'Phone', input.owner.phone);

    y = section(doc, y + 6, 'AUTHORISED USER');
    y = kv(doc, y, 'Name', input.authorised.name, { bold: true });
    if (input.authorised.pan) y = kv(doc, y, 'PAN', input.authorised.pan);
    if (input.authorised.aadhaar) y = kv(doc, y, 'Aadhaar', input.authorised.aadhaar);
    if (input.authorised.phone) y = kv(doc, y, 'Phone', input.authorised.phone);

    y = section(doc, y + 6, 'DECLARATION');
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.TEXT).text(
      `I, ${input.owner.full_name}, the holder of the locker described above, hereby authorise the person named above to be an authorised user of this locker. They may operate and access the locker in accordance with the locker agreement and the branch's operating rules. This authorisation remains in force until I withdraw it in writing. I confirm that the details stated above are true and correct.`,
      50, y + 2, { width: 495, align: 'justify', lineGap: 2 });
    y = doc.y + 34;

    const sigW = 220, sigH = 40, sigTopY = y;
    doc.save().rect(50, y, sigW, sigH).strokeColor(COLORS.GOLD).lineWidth(0.6).stroke().restore();
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED).text('Signature of the locker holder', 50, y + sigH + 3, { width: sigW });
    box = { llx: 50, lly: Math.round(PAGE_H - (sigTopY + sigH)), urx: 50 + sigW, ury: Math.round(PAGE_H - sigTopY) };
  });
  // Single-page letter, so the signature is always on page 1.
  return { buffer, signatureBox: box, signaturePage: 1 };
}
