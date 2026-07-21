/**
 * Investment Acknowledgement — faithful port of the wealth app's
 * pdf-acknowledgment.js. Generated when funds are confirmed received; the
 * customer's record that the money is credited and the investment is in-process.
 *
 * NCD schema differences vs wealth: single `address` (no split line/pin), no
 * per-application collection-bank or collection-confirmed timestamp, so those
 * lines are omitted; application_date maps to created_at.
 */
import type { Db } from '../../../db/types.js';
import { errors } from '../../../lib/errors.js';
import { existsSync } from 'node:fs';
import { getCompanyProfile } from '../../products/service.js';
import {
  COLORS, companyHeader, drawHeader, section, kv, fmtDate, fmtINR, amountInWords, renderToBuffer, SIGNATURE_PATH,
} from './shared.js';

export async function acknowledgmentPdf(db: Db, applicationId: number): Promise<Buffer> {
  const a = (await db.query<Record<string, unknown>>(
    `SELECT a.application_no, a.total_amount, a.amount_received, a.date_money_received,
            a.collection_method, a.collection_reference,
            c.full_name AS customer_name, c.customer_code, c.address, c.city, c.state, c.email, c.pan,
            s.code AS series_code, s.name AS series_name
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  const co = companyHeader(await getCompanyProfile(db));

  return renderToBuffer((doc) => {
    let y = drawHeader(doc, co);

    doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.GOLD_DEEP)
      .text('INVESTMENT ACKNOWLEDGMENT', 50, y, { width: 495, align: 'center' });
    y += 24;
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.MUTED)
      .text(`Ack-Ref: ${a.application_no} · Issued: ${fmtDate(new Date())}`, 50, y, { width: 495, align: 'center' });
    y += 22;
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.TEXT).text(
      'This is to acknowledge receipt of your investment towards the Non-Convertible Debenture (NCD) issue of '
      + co.legal_name + '.  The details of the investment are as follows:', 50, y, { width: 495, align: 'justify' });
    y = doc.y + 12;

    y = section(doc, y, '1. INVESTOR DETAILS');
    y = kv(doc, y, 'Name', a.customer_name, { bold: true });
    y = kv(doc, y, 'Customer Code', a.customer_code);
    if (a.pan) y = kv(doc, y, 'PAN', a.pan);
    const addr = [a.address, a.city, a.state].filter(Boolean).join(', ');
    if (addr) y = kv(doc, y, 'Address', addr);
    if (a.email) y = kv(doc, y, 'Email', a.email);
    y += 4;

    y = section(doc, y, '2. INVESTMENT DETAILS');
    y = kv(doc, y, 'Application No', a.application_no, { bold: true });
    y = kv(doc, y, 'NCD Series', `${a.series_code ?? ''} — ${a.series_name ?? ''}`);
    // total_amount is the true (possibly clubbed) value; fall back to amount_received.
    const amt = Number(a.total_amount) > 0 ? a.total_amount : a.amount_received;
    y = kv(doc, y, 'Investment Amount', fmtINR(amt), { bold: true });
    y = kv(doc, y, 'Amount (in words)', amountInWords(amt));
    y += 4;

    y = section(doc, y, '3. PAYMENT RECEIPT');
    y = kv(doc, y, 'Date Money Received', fmtDate(a.date_money_received));
    y = kv(doc, y, 'Payment Method', (a.collection_method as string) ?? '—');
    if (a.collection_reference) y = kv(doc, y, 'UTR / Reference', a.collection_reference);
    y += 8;

    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.MUTED).text(
      'This acknowledgment is a record of the receipt of your investment money.  The formal NCD allotment, '
      + 'bond certificate and interest schedule will be issued upon series allotment.  Please retain this document '
      + 'for your records.', 50, y, { width: 495, align: 'justify' });
    y = doc.y + 18;

    // Signature block, anchored near the page bottom.
    y = Math.max(y, doc.page.height - 180);
    const sigX = 380;
    if (existsSync(SIGNATURE_PATH)) {
      try { doc.image(SIGNATURE_PATH, sigX, y, { fit: [140, 50], align: 'center', valign: 'center' }); } catch { /* optional */ }
      y += 54;
    } else y += 60;
    doc.moveTo(sigX, y).lineTo(sigX + 150, y).lineWidth(0.5).strokeColor(COLORS.TEXT).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.TEXT).text(co.signatory_designation, sigX, y + 3, { width: 150 });
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.MUTED).text(co.legal_name, sigX, y + 15, { width: 200 });
  });
}
