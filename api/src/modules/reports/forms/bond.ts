/**
 * Debenture (Bond) Certificate — faithful port of the wealth app's
 * pdf-bond-certificate.js. Gold-bordered A4 certificate: letterhead, title +
 * subtitle pill, a 12-field detail table, the "For Value Received…" legal
 * paragraph, a TDS note, and three director signature blocks.
 *
 * Owner decision 2026-07-21: NCD issues the bond right after eSign, before
 * allotment — so the certificate number and allotment/redemption dates stay
 * blank ("—") until the series is allotted. NCD schema: single `address`
 * (no district/pin), series `deemed_date` (no close/allotted_at), no bond serial.
 */
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import type { Db } from '../../../db/types.js';
import { errors } from '../../../lib/errors.js';
import { getCompanyProfile } from '../../products/service.js';
import { companyHeader, COMPANY, LOGO_PATH, HAS_LOGO } from './shared.js';

const C = { GOLD: '#c9a227', GOLD_DEEP: '#a8851f', NAVY: '#1a2540', TEXT: '#1a1a1a', MUTED: '#666666', TINT: '#fcf6e3' };
const BOND_REDEMPTION_MONTHS = 36;
// Directors named on the certificate (as in wealth's production bond).
const DIRECTORS = [
  { name: 'Avinash Gopalakrishnan', title: 'Director' },
  { name: 'Gokul Govindarajan', title: 'Director' },
  { name: 'Sankar Venkataraman', title: 'Director' },
];
const BOND_SIG_PATHS = [
  new URL('../../../../assets/bond-sig-compliance-officer.png', import.meta.url),
  new URL('../../../../assets/bond-sig-authorised-signatory.png', import.meta.url),
  new URL('../../../../assets/bond-sig-director.png', import.meta.url),
].map((u) => decodeURIComponent(u.pathname));

type Doc = PDFKit.PDFDocument;
const _fmtDate = (d: unknown): string => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(String(d));
  if (isNaN(dt.getTime())) return '—';
  return `${String(dt.getUTCDate()).padStart(2, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${dt.getUTCFullYear()}`;
};
const _fmtINR = (n: unknown): string => (n == null || !isFinite(Number(n)) ? 'Rs. —' : 'Rs. ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
function _addMonths(d: unknown, n: number): Date | null {
  if (!d) return null;
  const dt = d instanceof Date ? new Date(d.getTime()) : new Date(String(d));
  if (isNaN(dt.getTime())) return null;
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return dt;
}

function _drawBorder(doc: Doc) {
  const W = doc.page.width, H = doc.page.height, m = 18;
  doc.save();
  doc.lineWidth(6).strokeColor(C.GOLD).rect(m, m, W - 2 * m, H - 2 * m).stroke();
  doc.lineWidth(1).strokeColor(C.GOLD_DEEP).rect(m + 8, m + 8, W - 2 * (m + 8), H - 2 * (m + 8)).stroke();
  doc.restore();
}

function _drawHeader(doc: Doc, co: ReturnType<typeof companyHeader>): number {
  const logoSize = 90, logoX = 50, logoY = 45;
  if (HAS_LOGO) { try { doc.image(LOGO_PATH, logoX, logoY, { fit: [logoSize, logoSize] }); } catch { /* optional */ } }
  const textX = 150, textW = doc.page.width - textX - 50;
  let y = 50;
  doc.fillColor(C.GOLD_DEEP).font('Helvetica-Bold').fontSize(15).text(co.legal_name.toUpperCase(), textX, y, { width: textW });
  y = doc.y + 4;
  doc.fillColor(C.NAVY).font('Helvetica-Bold').fontSize(7.5).text(`RBI NO: ${COMPANY.rbi_registration_no}  |  CIN : ${co.cin}`, textX, y, { width: textW });
  y = doc.y + 4;
  doc.fillColor(C.TEXT).font('Helvetica').fontSize(7.5);
  doc.text(`Corporate Office : ${co.corporate_office_address}`, textX, y, { width: textW }); y = doc.y + 1;
  doc.text(`Registered Office : ${COMPANY.registered_office_address}`, textX, y, { width: textW }); y = doc.y + 1;
  doc.text(`Toll Free : ${co.general_phone}`, textX, y, { width: textW }); y = doc.y + 1;
  doc.text(`Email ID : ${co.general_email}   |   website : ${co.website}`, textX, y, { width: textW });
  return Math.max(doc.y + 14, logoY + logoSize + 8);
}

function _drawTitle(doc: Doc, y: number): number {
  doc.fillColor(C.TEXT).font('Helvetica-Bold').fontSize(24).text('Debenture Certificate', 0, y, { align: 'center', width: doc.page.width });
  y = doc.y + 8;
  const subtitle = '(Secured, Non-Convertible, Redeemable Debentures)';
  doc.fontSize(11).font('Helvetica-Bold');
  const pillW = doc.widthOfString(subtitle) + 36, pillX = (doc.page.width - pillW) / 2, pillH = 22;
  doc.save();
  doc.roundedRect(pillX, y, pillW, pillH, 11).fillAndStroke(C.TINT, C.GOLD);
  doc.fillColor(C.NAVY).font('Helvetica-Bold').fontSize(11).text(subtitle, pillX, y + 6, { width: pillW, align: 'center' });
  doc.restore();
  return y + pillH + 18;
}

function _drawDetailTable(doc: Doc, y: number, rows: Array<[string, string, number?]>): number {
  const x = 50, w = doc.page.width - 100, labelW = 180, valueW = w - labelW, defaultRowH = 24;
  const heights = rows.map((r) => (r[2] && r[2] > defaultRowH ? r[2] : defaultRowH));
  const totalH = heights.reduce((a, b) => a + b, 0);
  doc.save();
  doc.lineWidth(0.8).strokeColor(C.GOLD).rect(x, y, w, totalH).stroke();
  let rowY = y;
  for (let i = 0; i < rows.length; i++) {
    const rowH = heights[i]!;
    if (i > 0) doc.moveTo(x, rowY).lineTo(x + w, rowY).strokeColor(C.GOLD).stroke();
    doc.moveTo(x + labelW, rowY).lineTo(x + labelW, rowY + rowH).strokeColor(C.GOLD).stroke();
    doc.fillColor(C.TEXT).font('Helvetica').fontSize(10).text(rows[i]![0], x + 12, rowY + 7, { width: labelW - 24 });
    doc.font('Helvetica-Bold').text(String(rows[i]![1] || '—'), x + labelW + 12, rowY + 7, { width: valueW - 24 });
    rowY += rowH;
  }
  doc.restore();
  return y + totalH + 18;
}

function _drawLegalAndSign(doc: Doc, y: number, co: ReturnType<typeof companyHeader>, totalAmount: number) {
  const x = 50, w = doc.page.width - 100;
  doc.fillColor(C.TEXT).font('Helvetica').fontSize(9.5).text(
    `For Value Received ${co.legal_name} having its Corporate Office at ${co.corporate_office_address} promises to pay the person(s) named as holder(s) or to their order the sum of Rs. ${Number(totalAmount).toLocaleString('en-IN')} upon presentation and discharge of this NCD Certificate on the date of redemption as mentioned above including interest at the rate specified above subject to Deduction of tax at source at the rate prevailing from time to time under the provisions of Indian Income Tax Act-1961 or any statutory modifications (or reenactment thereof). The NCD is issued subject to and with the benefit of conditions mentioned in Private Placement Offer Letter which shall be binding on the Company and the NCD Holders and persons claiming by, through or under any of them.`,
    x, y, { width: w, align: 'justify' });
  y = doc.y + 10;
  doc.font('Helvetica-Oblique').fontSize(9).text('*Will be subject to deduction of TDS on interest and applicable Government levies', x, y, { width: w });
  y = doc.y + 36;
  const colW = w / 3, signLineY = y, sigImgH = 32, sigPadX = 30;
  for (let i = 0; i < 3; i++) {
    const colX = x + i * colW;
    try { if (existsSync(BOND_SIG_PATHS[i]!)) doc.image(BOND_SIG_PATHS[i]!, colX + sigPadX, signLineY - sigImgH - 2, { fit: [colW - sigPadX * 2, sigImgH], align: 'center', valign: 'bottom' }); } catch { /* optional */ }
    doc.lineWidth(0.6).strokeColor(C.TEXT).moveTo(colX + 20, signLineY).lineTo(colX + colW - 20, signLineY).stroke();
  }
  for (let i = 0; i < 3; i++) {
    const cx = x + i * colW;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.TEXT).text(DIRECTORS[i]!.name, cx, signLineY + 8, { width: colW, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(C.MUTED).text(DIRECTORS[i]!.title, cx, signLineY + 21, { width: colW, align: 'center' });
  }
}

export async function bondCertificatePdf(db: Db, applicationId: number): Promise<Buffer> {
  const a = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.customer_id, a.application_no, a.total_amount, a.allotment_date, a.maturity_date,
            c.full_name, c.address, c.city, c.state,
            s.code AS series_code, s.name AS series_name, s.deemed_date, s.isin
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  const nominee = (await db.query<Record<string, unknown>>('SELECT full_name FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 1', [a.customer_id])).rows[0];
  const line = (await db.query<Record<string, unknown>>(
    `SELECT al.amount, COALESCE(al.coupon_rate_pct, sch.coupon_rate_pct) AS coupon_rate_pct, al.tenure_months,
            COALESCE(sch.face_value, 100000) AS face_value
       FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
      WHERE al.application_id = $1 ORDER BY al.id LIMIT 1`, [applicationId])).rows[0] ?? {};
  const co = companyHeader(await getCompanyProfile(db));

  const invested = Number(a.total_amount || 0);
  const faceValue = Number(line.face_value || 100000);
  const numNcds = invested > 0 ? Math.round(invested / faceValue) : null;
  const tenureMonths = Number(line.tenure_months) || BOND_REDEMPTION_MONTHS;
  const rateLabel = line.coupon_rate_pct != null ? `${Number(line.coupon_rate_pct).toFixed(2)}% per annum` : '—';
  const allotmentDate = a.allotment_date || a.deemed_date || null; // blank until allotted
  const redemptionDate = a.maturity_date || (allotmentDate ? _addMonths(allotmentDate, tenureMonths) : null);
  const fullAddress = [a.address, a.city, a.state].filter(Boolean).join(', ') || '—';

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  _drawBorder(doc);
  let y = _drawHeader(doc, co);
  y = _drawTitle(doc, y);

  const addrColW = doc.page.width - 100 - 180 - 24;
  doc.font('Helvetica-Bold').fontSize(10);
  const addrRowH = Math.max(24, Math.ceil(doc.heightOfString(fullAddress, { width: addrColW })) + 14);

  const rows: Array<[string, string, number?]> = [
    ['Category', `${a.series_code || a.series_name || '—'} Series`],
    ['Certificate No', '—'], // NCD assigns no bond serial pre-allotment (owner: bond issues after eSign)
    ['Name of NCD Holder', (a.full_name as string) || '—'],
    ['Address of NCD Holder', fullAddress, addrRowH],
    ['Nominee', (nominee?.full_name as string) || '—'],
    ['Investment Value (Rs.)', _fmtINR(invested)],
    ['Number of NCDs', numNcds != null ? String(numNcds) : '—'],
    ['Coupon Rate', rateLabel],
    ['Date of Allotment', _fmtDate(allotmentDate)],
    ['Date of Redemption', _fmtDate(redemptionDate)],
    ['Face Value per NCD (Rs.)', _fmtINR(faceValue)],
    ['Redemption Value (Rs.)', _fmtINR(invested)], // equals principal, per spec
  ];
  y = _drawDetailTable(doc, y, rows);
  _drawLegalAndSign(doc, y, co, invested);

  doc.end();
  return done;
}
