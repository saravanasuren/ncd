/**
 * NCD Application Form — faithful port of the wealth app's pdf-ncd-application.js
 * (the canonical 2-page private-placement form), remapped to NCD's schema.
 *
 * Returns the PDF buffer AND the sole/1st-applicant signature-box coordinates
 * (PDF bottom-left origin, 1-indexed page) so Digio can place the eSignature in
 * the box — see integrations/digio. Full Aadhaar is printed when stored.
 *
 * NCD schema notes: bank details come from customer_bank_accounts (wealth kept
 * them on customers); holding_mode, series open/close dates and bank account
 * type aren't tracked in NCD, so those stay blank.
 */
import PDFDocument from 'pdfkit';
import type { Db } from '../../../db/types.js';
import { errors } from '../../../lib/errors.js';
import { getCompanyProfile } from '../../products/service.js';
import { companyHeader, COMPANY, LOGO_PATH, HAS_LOGO } from './shared.js';

export interface SignatureBox { llx: number; lly: number; urx: number; ury: number; }
export interface ApplicationFormResult { buffer: Buffer; signatureBox: SignatureBox | null; signaturePage: number; }

// ── Brand (wealth palette) ──
const NAVY = '#1a2540', GOLD = '#c9a227', GOLD_D = '#a8851f', TINT = '#f5f0e0', TXT = '#1a1a1a', MUT = '#74798c', BDR = '#d8c890';
const LX = 36, RX = 559, CW = 523, PAGE_H = 841.89;

const _dt = (d: unknown): string => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(String(d));
  if (isNaN(dt.getTime())) return typeof d === 'string' ? d : '';
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
};
const _inr = (n: unknown): string => (n == null ? '' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
function _words(input: unknown): string {
  const num = Number(input);
  if (input == null || !Number.isFinite(num)) return '';
  let v = Math.floor(num);
  if (v === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const u100 = (x: number): string => (x < 20 ? ones[x]! : tens[Math.floor(x / 10)]! + (x % 10 ? ' ' + ones[x % 10] : ''));
  const u1k = (x: number): string => (x < 100 ? u100(x) : ones[Math.floor(x / 100)]! + ' Hundred' + (x % 100 ? ' ' + u100(x % 100) : ''));
  const p: string[] = [];
  const cr = Math.floor(v / 10000000); v %= 10000000;
  const lk = Math.floor(v / 100000); v %= 100000;
  const th = Math.floor(v / 1000); v %= 1000;
  if (cr) p.push(u1k(cr) + ' Crore');
  if (lk) p.push(u100(lk) + ' Lakh');
  if (th) p.push(u1k(th) + ' Thousand');
  if (v) p.push(u1k(v));
  return p.join(' ');
}

type Doc = PDFKit.PDFDocument;
const _hr = (doc: Doc, y: number, x1: number, x2: number, color: string, w: number) => { doc.save().lineWidth(w).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore(); };
function _navyBar(doc: Doc, y: number, label: string): number {
  doc.save().rect(LX, y, CW, 14).fill(NAVY).restore();
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(label, LX + 6, y + 3, { width: CW - 12, lineBreak: false });
  return y + 16;
}
function _charBoxes(doc: Doc, x: number, y: number, count: number, value: unknown, sz = 13): number {
  const val = String(value ?? '');
  for (let i = 0; i < count; i++) {
    const bx = x + i * (sz + 1);
    doc.save().rect(bx, y, sz, sz).strokeColor(BDR).lineWidth(0.4).stroke().restore();
    if (val[i]) doc.font('Helvetica-Bold').fontSize(8).fillColor(TXT).text(val[i]!.toUpperCase(), bx + 2, y + 2, { width: sz - 3, lineBreak: false });
  }
  return x + count * (sz + 1);
}
function _tick(doc: Doc, x: number, y: number, label: string, checked: boolean, lw = 65) {
  doc.save().rect(x, y, 8, 8).strokeColor(BDR).lineWidth(0.5).stroke().restore();
  if (checked) doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY).text('X', x + 1.5, y + 0.5, { width: 8, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text(label, x + 11, y + 0.5, { width: lw, lineBreak: false });
}
const _inputLine = (doc: Doc, x: number, y: number, w: number) => { doc.save().lineWidth(0.3).strokeColor(BDR).moveTo(x, y).lineTo(x + w, y).stroke().restore(); };
const _fieldLabel = (doc: Doc, x: number, y: number, label: string, w = 200) => { doc.font('Helvetica').fontSize(6).fillColor(MUT).text(label, x, y, { width: w, lineBreak: false }); };

function _drawHeader(doc: Doc, co: ReturnType<typeof companyHeader>): number {
  if (HAS_LOGO) { try { doc.image(LOGO_PATH, (595.28 - 60) / 2, 18, { width: 60, height: 60 }); } catch { /* optional */ } }
  const ty = HAS_LOGO ? 80 : 26;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('DHANAM INVESTMENT AND FINANCE PRIVATE LIMITED', LX, ty, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor(TXT).text(COMPANY.registered_office_address, LX, ty + 18, { width: CW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUT).text(`CIN: ${co.cin}  |  RBI Reg. No.: ${COMPANY.rbi_registration_no}`, LX, ty + 30, { width: CW, align: 'center' });
  _hr(doc, ty + 42, LX, RX, GOLD, 1);
  return ty + 46;
}

interface Row { [k: string]: unknown }

export async function applicationFormPdf(db: Db, applicationId: number): Promise<ApplicationFormResult> {
  const a = (await db.query<Row>(
    `SELECT a.id, a.customer_id, a.application_no, a.total_amount, a.created_at AS application_date,
            a.amount_received, a.date_money_received, a.collection_method,
            c.full_name, c.customer_code, c.pan, c.aadhaar, c.aadhaar_last4,
            c.phone AS phone_primary, c.email, c.dob AS date_of_birth, c.gender,
            c.address AS address_line, c.city, c.state,
            c.demat_dp_id, c.demat_client_id, c.depository, c.tds_applicable,
            s.code AS series_code, s.name AS series_name
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  const jh = (await db.query<Row>('SELECT full_name, pan FROM joint_holders WHERE customer_id = $1 ORDER BY id', [a.customer_id])).rows;
  const noms = (await db.query<Row>('SELECT full_name, relationship, dob AS date_of_birth FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 3', [a.customer_id])).rows;
  const bank = (await db.query<Row>('SELECT account_number AS bank_account_number, ifsc AS bank_ifsc, bank_name, branch_name FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY is_active DESC, id LIMIT 1', [a.customer_id])).rows[0] ?? {};
  let lines = (await db.query<Row>(
    `SELECT al.amount, al.coupon_rate_pct, al.payout_frequency, al.tenure_months,
            COALESCE(sch.face_value, 100000) AS face_value, sch.min_ticket AS min_ticket_amount
       FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
      WHERE al.application_id = $1 ORDER BY al.id`, [applicationId])).rows;
  if (!lines.length) lines = [{ tenure_months: null, coupon_rate_pct: null, payout_frequency: null, face_value: 100000, min_ticket_amount: 100000, amount: null }];
  const co = companyHeader(await getCompanyProfile(db));

  const doc = new PDFDocument({ size: 'A4', margins: { top: 12, bottom: 4, left: 36, right: 36 }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  // ── PAGE 1 ──
  let y = _drawHeader(doc, co);
  doc.save().rect(LX, y, CW, 18).fill(NAVY).restore();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text('NCD APPLICATION FORM  ·  PRIVATE PLACEMENT', LX + 10, y + 4, { width: 360, lineBreak: false });
  const afnX = RX - 130;
  doc.save().rect(afnX, y + 1, 126, 16).fill(TINT).stroke().restore();
  doc.font('Helvetica').fontSize(6.5).fillColor(MUT).text('Application Form No.', afnX + 4, y + 2, { width: 120, lineBreak: false });
  if (a.application_no) doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TXT).text(String(a.application_no), afnX + 4, y + 9, { width: 120, lineBreak: false });
  y += 20;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(`Series: ${a.series_code || '____'}`, LX, y + 1, { continued: true })
    .font('Helvetica').fillColor(TXT).text(`  ${a.series_name || ''}`, { width: 400 });
  y += 13;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GOLD_D).text('PLEASE FILL IN BLOCK LETTERS', LX, y, { width: CW, align: 'center' });
  y += 12;

  // 1. APPLICANT
  y = _navyBar(doc, y, '1.  APPLICANT DETAILS  (Sole / First Applicant)');
  _fieldLabel(doc, LX, y, 'Name (Mr./Ms./M/s.)');
  _inputLine(doc, LX, y + 17, CW);
  if (a.full_name) doc.font('Helvetica-Bold').fontSize(9).fillColor(TXT).text(String(a.full_name), LX + 2, y + 8, { width: CW - 4, lineBreak: false });
  y += 20;
  // DOB char boxes
  _fieldLabel(doc, LX, y, 'Date of Birth');
  const dobStr = _dt(a.date_of_birth); const dobChars = dobStr ? dobStr.replace(/\//g, '') : '';
  const dobSz = 12, ddX = LX + 2, mmX = ddX + 2 * (dobSz + 1) + 4, yyyyX = mmX + 2 * (dobSz + 1) + 4;
  _charBoxes(doc, ddX, y + 9, 2, dobChars.slice(0, 2), dobSz);
  _charBoxes(doc, mmX, y + 9, 2, dobChars.slice(2, 4), dobSz);
  _charBoxes(doc, yyyyX, y + 9, 4, dobChars.slice(4, 8), dobSz);
  const dlY = y + 9 + dobSz + 2;
  const _dl = (ch: string, bx: number) => doc.font('Helvetica').fontSize(5.5).fillColor(MUT).text(ch, bx + 4, dlY, { lineBreak: false });
  ['D', 'D'].forEach((c, i) => _dl(c, ddX + i * (dobSz + 1)));
  ['M', 'M'].forEach((c, i) => _dl(c, mmX + i * (dobSz + 1)));
  ['Y', 'Y', 'Y', 'Y'].forEach((c, i) => _dl(c, yyyyX + i * (dobSz + 1)));
  // Gender
  const gx = LX + 160, gen = String(a.gender || '').toLowerCase();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Gender:', gx, y + 11.5, { width: 42, lineBreak: false });
  _tick(doc, gx + 42, y + 11, 'Male', gen === 'male' || gen === 'm', 30);
  _tick(doc, gx + 84, y + 11, 'Female', gen === 'female' || gen === 'f', 36);
  _tick(doc, gx + 132, y + 11, 'Other', gen === 'other' || gen === 'o', 28);
  // Category from PAN 4th char
  const cx = LX + 330, hasPan = !!(a.pan && String(a.pan).trim().length >= 4), p4 = String(a.pan || '').toUpperCase().charAt(3);
  const isHUF = hasPan && p4 === 'H', isCo = hasPan && p4 === 'C', isTr = hasPan && p4 === 'T', isInd = hasPan && !isHUF && !isCo && !isTr;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Category:', cx, y + 11.5, { width: 48, lineBreak: false });
  _tick(doc, cx + 48, y + 11, 'Individual', isInd, 42);
  _tick(doc, cx + 100, y + 11, 'HUF', isHUF, 20);
  _tick(doc, cx + 130, y + 11, 'Company', isCo, 38);
  _tick(doc, cx + 178, y + 11, 'Trust', isTr, 25);
  y += 28;
  // PAN + Aadhaar (full when stored)
  _fieldLabel(doc, LX, y, 'PAN (mandatory)');
  _charBoxes(doc, LX, y + 9, 10, a.pan, 14);
  const aaX = LX + 260; _fieldLabel(doc, aaX, y, 'Aadhaar (mandatory)');
  const aFull = a.aadhaar && /^\d{12}$/.test(String(a.aadhaar)) ? String(a.aadhaar) : null;
  const aL4 = a.aadhaar_last4 && /^\d{4}$/.test(String(a.aadhaar_last4)) ? String(a.aadhaar_last4) : null;
  // All 12 digits are printed whenever we hold them (owner: print full Aadhaar).
  // When only the legacy last-4 is on file the first eight boxes are left BLANK
  // rather than dotted — the number was never captured, and dots read as though
  // we were deliberately masking a number we actually have.
  _charBoxes(doc, aaX, y + 9, 12, aFull ? aFull : (aL4 ? '        ' + aL4 : ''), 14);
  y += 26;
  // Address
  _fieldLabel(doc, LX, y, 'Address');
  _inputLine(doc, LX, y + 15, CW); _inputLine(doc, LX, y + 25, CW);
  const addr = String(a.address_line || '').replace(/\r/g, ' ').replace(/\n/g, ', ').trim();
  if (addr) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(addr, LX + 2, y + 7, { width: CW - 4, height: 18, ellipsis: true, lineGap: 1 });
  y += 28;
  // City / Pin / State / Cust code
  const cityW = 240, pinW = 80, stW = 80;
  _fieldLabel(doc, LX, y, 'City / Town'); _inputLine(doc, LX, y + 14, cityW);
  if (a.city) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(a.city), LX + 2, y + 6, { width: cityW - 4, lineBreak: false });
  const pinX = LX + cityW + 6; _fieldLabel(doc, pinX, y, 'Pin Code'); _inputLine(doc, pinX, y + 14, pinW);
  const stX = pinX + pinW + 6; _fieldLabel(doc, stX, y, 'State'); _inputLine(doc, stX, y + 14, stW);
  if (a.state) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(a.state), stX + 2, y + 6, { width: stW - 4, lineBreak: false });
  const ccX = stX + stW + 6; _fieldLabel(doc, ccX, y, 'Cust. Code');
  _charBoxes(doc, ccX, y + 5, 6, a.customer_code ? String(a.customer_code).replace(/^DHN/i, '') : '', 12);
  y += 18;
  // Mobile / Email
  const halfW = (CW - 6) / 2;
  _fieldLabel(doc, LX, y, 'Mobile / Telephone'); _inputLine(doc, LX, y + 14, halfW);
  if (a.phone_primary) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(a.phone_primary), LX + 2, y + 6, { width: halfW - 4, lineBreak: false });
  const emX = LX + halfW + 6; _fieldLabel(doc, emX, y, 'Email'); _inputLine(doc, emX, y + 14, halfW);
  if (a.email) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(a.email), emX + 2, y + 6, { width: halfW - 4, lineBreak: false });
  y += 18;

  // 2. JOINT APPLICANTS
  y = _navyBar(doc, y, '2.  JOINT APPLICANTS  (Optional — up to 2 additional holders)');
  const jh2 = jh[0] ?? null, jh3 = jh[1] ?? null;
  for (const [label, j] of [['2nd Applicant', jh2], ['3rd Applicant', jh3]] as const) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text(label, LX, y + 1, { width: 70, lineBreak: false });
    _fieldLabel(doc, LX + 75, y, 'Full Name (Mr./Ms.)'); _inputLine(doc, LX + 75, y + 12, 280);
    if (j?.full_name) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(j.full_name), LX + 77, y + 4, { width: 275, lineBreak: false });
    _fieldLabel(doc, RX - 140, y, 'PAN'); _charBoxes(doc, RX - 140, y + 8, 10, j?.pan || '', 12);
    y += 22;
  }
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Mode of Holding:', LX, y + 1, { width: 85, lineBreak: false });
  _tick(doc, LX + 88, y, 'Single', false, 40);
  _tick(doc, LX + 145, y, 'Either or Survivor', false, 85);
  _tick(doc, LX + 248, y, 'Jointly', false, 38);
  _tick(doc, LX + 302, y, 'Anyone or Survivor', false, 95);
  y += 14;

  // 3. DEPOSITORY
  y = _navyBar(doc, y, '3.  DEPOSITORY DETAILS  (NSDL: 8-digit DP ID + 8-digit Client ID / CDSL: 16-digit Client ID)');
  const dpRaw = String(a.demat_dp_id || '').trim().toUpperCase(), depo = String(a.depository || '').toUpperCase();
  const isNsdl = depo === 'NSDL' || dpRaw.startsWith('IN'), isCdsl = depo === 'CDSL' || (!!dpRaw && !isNsdl);
  _tick(doc, LX, y, 'NSDL', isNsdl, 32); _tick(doc, LX + 55, y, 'CDSL', isCdsl, 32);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('DP ID', LX + 105, y + 1, { width: 30, lineBreak: false });
  _charBoxes(doc, LX + 133, y - 1, 8, a.demat_dp_id, 14);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Client / Beneficiary ID', LX + 260, y + 1, { width: 110, lineBreak: false });
  _charBoxes(doc, LX + 370, y - 1, 16, a.demat_client_id, 9);
  y += 18;

  // 4. INVESTMENT TABLE
  y = _navyBar(doc, y, '4.  INVESTMENT DETAILS');
  const ncdW = 70, amtW = 143, cols = [65, 60, 65, 60, 60, ncdW, amtW];
  const hdrs = ['Tenure', 'Coupon\n% p.a.', 'Payout\nFrequency', 'Face\nValue', 'Minimum\nAmount', 'No. of NCDs\nApplied', 'Amount Payable\n(Rs)'];
  let tx = LX;
  doc.save().rect(LX, y, CW, 20).fill(TINT).strokeColor(BDR).lineWidth(0.3).stroke().restore();
  for (let i = 0; i < hdrs.length; i++) {
    doc.font('Helvetica-Bold').fontSize(6).fillColor(NAVY).text(hdrs[i]!, tx + 3, y + 2, { width: cols[i]! - 6, align: 'center' });
    if (i < hdrs.length - 1) doc.save().moveTo(tx + cols[i]!, y).lineTo(tx + cols[i]!, y + 20).strokeColor(BDR).lineWidth(0.3).stroke().restore();
    tx += cols[i]!;
  }
  const lastX = LX + cols[0]! + cols[1]! + cols[2]! + cols[3]! + cols[4]!;
  y += 22;
  let totalNcds = 0;
  for (const ln of lines) {
    doc.save().rect(LX, y, CW, 14).strokeColor(BDR).lineWidth(0.3).stroke().restore();
    let rx = LX; const fv = Number(ln.face_value || 100000); const ncdCount = ln.amount ? Math.round(Number(ln.amount) / fv) : 0; totalNcds += ncdCount;
    const vals = [
      ln.tenure_months ? `${ln.tenure_months}M` : '',
      ln.coupon_rate_pct != null ? `${Number(ln.coupon_rate_pct).toFixed(3)}%` : '',
      String(ln.payout_frequency || ''),
      `Rs${_inr(fv)}`, `Rs${_inr(ln.min_ticket_amount || fv)}`,
      ncdCount ? String(ncdCount) : '', ln.amount ? `Rs${_inr(ln.amount)}` : '',
    ];
    for (let i = 0; i < vals.length; i++) {
      doc.font(i >= 5 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(TXT).text(vals[i]!, rx + 3, y + 3, { width: cols[i]! - 6, align: i === vals.length - 1 ? 'right' : 'center', lineBreak: false });
      if (i < vals.length - 1) doc.save().moveTo(rx + cols[i]!, y).lineTo(rx + cols[i]!, y + 14).strokeColor(BDR).lineWidth(0.2).stroke().restore();
      rx += cols[i]!;
    }
    y += 14;
  }
  doc.save().rect(LX, y, CW, 14).fill(TINT).strokeColor(BDR).lineWidth(0.3).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY).text('Grand Total', LX + 4, y + 3, { width: 80, lineBreak: false });
  doc.text('Total No. of NCDs:', LX + 130, y + 3, { width: 110, lineBreak: false });
  const grandNcds = totalNcds || (a.total_amount ? Math.round(Number(a.total_amount) / 100000) : 0);
  if (grandNcds) doc.text(String(grandNcds), LX + 240, y + 3, { width: 50, lineBreak: false });
  doc.text('Total Amount Payable (Rs):', lastX - 20, y + 3, { width: 150, lineBreak: false });
  if (a.total_amount) doc.text(`Rs${_inr(a.total_amount)}`, lastX + ncdW + 3, y + 3, { width: amtW - 6, align: 'right', lineBreak: false });
  y += 16;
  doc.save().rect(LX, y, CW, 14).fill('#fdf6e3').strokeColor(GOLD).lineWidth(0.4).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(NAVY).text('Premature redemption of the NCD is not permitted, and the investment shall remain locked in for the entire tenure period.', LX + 6, y + 3, { width: CW - 12, lineBreak: false });
  y += 16;

  // 5. PAYMENT
  y = _navyBar(doc, y, '5.  PAYMENT DETAILS');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('PAY TO:', LX, y + 1, { width: 45, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text(`Beneficiary: ${co.legal_name}`, LX + 48, y + 1, { width: CW - 50, lineBreak: false });
  y += 11;
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text('A/C: 44886972753   IFSC: SBIN0012778   Bank: State Bank of India   Branch: Maniyakarampalayam', LX + 48, y, { width: CW - 50, lineBreak: false });
  y += 13;
  const cm = String(a.collection_method || '').toLowerCase();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Mode:', LX, y + 1, { width: 35, lineBreak: false });
  _tick(doc, LX + 38, y, 'NEFT / RTGS', cm.includes('neft') || cm.includes('rtgs'), 58);
  _tick(doc, LX + 120, y, 'IMPS', cm.includes('imps'), 28);
  _tick(doc, LX + 175, y, 'Cheque / DD', cm.includes('cheque'), 55);
  _tick(doc, LX + 250, y, 'UPI / QR', cm.includes('upi'), 42);
  y += 14;
  const aw1 = 140, aw2 = 230, aw3 = CW - aw1 - aw2 - 12;
  _fieldLabel(doc, LX, y, 'Amount Paid (Rs in figures)'); _inputLine(doc, LX, y + 14, aw1);
  if (a.amount_received) doc.font('Helvetica-Bold').fontSize(8).fillColor(TXT).text(`Rs${_inr(a.amount_received)}`, LX + 2, y + 6, { width: aw1 - 4, lineBreak: false });
  _fieldLabel(doc, LX + aw1 + 6, y, 'Amount in Words'); _inputLine(doc, LX + aw1 + 6, y + 14, aw2);
  if (a.amount_received) doc.font('Helvetica').fontSize(7).fillColor(TXT).text(`Rupees ${_words(a.amount_received)} Only`, LX + aw1 + 8, y + 6, { width: aw2 - 4, lineBreak: false });
  _fieldLabel(doc, LX + aw1 + aw2 + 12, y, 'Date (DD/MM/YYYY)'); _inputLine(doc, LX + aw1 + aw2 + 12, y + 14, aw3);
  if (a.date_money_received) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(_dt(a.date_money_received), LX + aw1 + aw2 + 14, y + 6, { width: aw3 - 4, lineBreak: false });
  y += 18;

  // 6. BANK ACCOUNT
  y = _navyBar(doc, y, '6.  BANK ACCOUNT DETAILS  (For interest and redemption credit — must match KYC records)');
  _fieldLabel(doc, LX, y, 'Bank Account Number (up to 20 digits)');
  _charBoxes(doc, LX, y + 9, 20, bank.bank_account_number, 14);
  const ifscX = LX + 20 * 15 + 20; _fieldLabel(doc, ifscX, y, 'IFSC Code'); _charBoxes(doc, ifscX, y + 9, 11, bank.bank_ifsc, 14);
  y += 26;
  const bnW = 200, brW = 140;
  _fieldLabel(doc, LX, y, 'Bank Name'); _inputLine(doc, LX, y + 14, bnW);
  if (bank.bank_name) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(bank.bank_name), LX + 2, y + 6, { width: bnW - 4, lineBreak: false });
  _fieldLabel(doc, LX + bnW + 6, y, 'Branch'); _inputLine(doc, LX + bnW + 6, y + 14, brW);
  if (bank.branch_name) doc.font('Helvetica').fontSize(8).fillColor(TXT).text(String(bank.branch_name), LX + bnW + 8, y + 6, { width: brW - 4, lineBreak: false });
  const typeX = LX + bnW + brW + 20;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text('Type:', typeX, y + 8.5, { width: 30, lineBreak: false });
  _tick(doc, typeX + 32, y + 8, 'SB', false, 20); _tick(doc, typeX + 62, y + 8, 'CA', false, 20); _tick(doc, typeX + 92, y + 8, 'NRO', false, 25);
  y += 18;

  // 7. NOMINEE
  y = _navyBar(doc, y, '7.  NOMINEE DETAILS  (Optional — maximum 3 nominees)');
  for (let ni = 0; ni < 3; ni++) {
    const nm = (noms[ni] ?? {}) as Row; const label = ['1st', '2nd', '3rd'][ni];
    doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text(`${label}:`, LX, y + 1, { width: 22, lineBreak: false });
    _fieldLabel(doc, LX + 22, y, 'Full Name'); _inputLine(doc, LX + 22, y + 16, 220);
    if (nm.full_name) doc.font('Helvetica').fontSize(7.5).fillColor(TXT).text(String(nm.full_name), LX + 24, y + 8, { width: 215, lineBreak: false });
    const relX = LX + 250; _fieldLabel(doc, relX, y, 'Relationship'); _inputLine(doc, relX, y + 16, 140);
    if (nm.relationship) doc.font('Helvetica').fontSize(7.5).fillColor(TXT).text(String(nm.relationship), relX + 2, y + 8, { width: 136, lineBreak: false });
    const dbX = relX + 148; _fieldLabel(doc, dbX, y, 'DOB'); _inputLine(doc, dbX, y + 16, 89);
    if (nm.date_of_birth) doc.font('Helvetica').fontSize(7.5).fillColor(TXT).text(_dt(nm.date_of_birth), dbX + 2, y + 8, { width: 85, lineBreak: false });
    else doc.font('Helvetica').fontSize(5.5).fillColor(MUT).text('DD/MM/YYYY', dbX + 2, y + 10, { width: 85, lineBreak: false });
    y += 22;
  }

  // 8. DECLARATION & SIGNATURES
  y = _navyBar(doc, y, '8.  DECLARATION & SIGNATURES');
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text(
    `I/We hereby apply for allotment of Non-Convertible Debentures of ${co.legal_name} and confirm that I/We have read and understood the terms of the Disclosure Document. The amount stated above is remitted herewith. I/We confirm that I/We am/are an Indian national(s) resident in India and the investment is from lawfully acquired funds. I/We agree that allotment is at the sole discretion of the company.`,
    LX, y, { width: CW, align: 'justify' });
  y = doc.y + 6;
  const sigW = (CW - 12) / 3, sigH = 30, sigTopY = y;
  const sigLabels = ['Signature / Thumb Impression\nof Sole / 1st Applicant', 'Signature of\n2nd Applicant', 'Signature of\n3rd Applicant'];
  for (let si = 0; si < 3; si++) {
    const sx = LX + si * (sigW + 6);
    doc.save().rect(sx, y, sigW, sigH).strokeColor(BDR).lineWidth(0.4).stroke().restore();
    doc.font('Helvetica').fontSize(5.5).fillColor(MUT).text(sigLabels[si]!, sx + 4, y + sigH + 2, { width: sigW - 8, align: 'center' });
  }
  const signaturePage = doc.bufferedPageRange().start + doc.bufferedPageRange().count; // 1-indexed
  const signatureBox: SignatureBox = {
    llx: Math.round(LX), lly: Math.round(PAGE_H - (sigTopY + sigH)), urx: Math.round(LX + sigW), ury: Math.round(PAGE_H - sigTopY),
  };

  // ── PAGE 2 ──
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('DHANAM INVESTMENT AND FINANCE PRIVATE LIMITED', LX, 24, { width: CW, align: 'center' });
  let y2 = 44;
  y2 = _navyBar(doc, y2, "APPLICANT'S UNDERTAKING  —  I/We hereby agree and confirm that:") + 2;
  const undertakings = [
    `I/We have read, understood and agreed to the contents and terms and conditions of the Disclosure Document / Information Memorandum of ${co.legal_name}.`,
    'I/We hereby apply for allotment of the NCDs and the amount payable on application is remitted herewith.',
    'I/We agree to accept the NCDs applied for or such lesser number as may be allotted in accordance with the Disclosure Document.',
    'I am/We are Indian national(s) resident in India and I/we are not applying as nominee(s) of any person resident outside India.',
    'The application made by me/us does not exceed the investment limit applicable under statutory and/or regulatory requirements.',
    'In making this investment decision I/we have relied on my/our own examination of the Issuer and the terms of the Disclosure Document.',
    'I/We have obtained all necessary statutory and/or regulatory permissions/approvals for applying for and subscribing to the NCDs.',
    'By submitting this form I/we confirm that the investment is from lawfully acquired funds and all information provided is accurate.',
  ];
  for (let i = 0; i < undertakings.length; i++) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(TXT).text(`${i + 1}.`, LX, y2, { width: 16, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(TXT).text(undertakings[i]!, LX + 16, y2, { width: CW - 16, align: 'justify' });
    y2 = doc.y + 3;
  }
  y2 += 4;
  y2 = _navyBar(doc, y2, 'TERMS AND CONDITIONS') + 2;
  const terms = [
    'Application is for NCDs issued by way of Private Placement under Section 42 of the Companies Act, 2013 and the rules thereunder.',
    'Minimum application: Rs1,00,000 (1 NCD). Thereafter in multiples of Rs1,00,000.',
    "NCDs will be allotted in dematerialised form. Physical certificates may be issued at the company's discretion upon written request.",
    'Interest will be paid before the end of every month (adjusted for banking holidays to the preceding working day). TDS will be deducted as applicable under the Income Tax Act, 1961.',
    'Submission of PAN, Aadhaar and Demat ID is mandatory. Eligible investors may submit Form 15G/15H (Form 121) to claim TDS exemption. TDS certificates (Form 16A) are available from TRACES after Dhanam files Form 26Q quarterly.',
    'Redemption will be credited to the registered bank account. Investors must keep bank details updated with Dhanam.',
    'NCD investments are subject to a mandatory lock-in for the entire tenure period, and premature withdrawal or redemption shall not be permitted.',
    'NCDs are secured by a first-ranking pari passu charge on the specified assets of the company as described in the Disclosure Document.',
    'Interest rates are fixed for the tenure.',
    'Allotment is subject to acceptance by the Board / Allotment Committee.',
    'The company reserves the right to reject incomplete or illegible applications without assigning reasons.',
    'For disputes, the exclusive jurisdiction shall be the NCLT in Chennai, Tamil Nadu.',
    'All future communication regarding your investment should be addressed to the company at the address below.',
  ];
  for (let i = 0; i < terms.length; i++) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TXT).text(`${i + 1}.`, LX, y2, { width: 16, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(TXT).text(terms[i]!, LX + 16, y2, { width: CW - 16 });
    y2 = doc.y + 2;
  }
  y2 += 6;
  y2 = _navyBar(doc, y2, 'ISSUER  &  DEBENTURE TRUSTEE  /  REGISTRAR') + 4;
  const colW3 = Math.floor((CW - 10) / 3), gap3 = 5, c1x = LX, c2x = LX + colW3 + gap3, c3x = LX + (colW3 + gap3) * 2, pad = 8, iw = colW3 - pad * 2, bH = 183;
  doc.save().rect(c1x, y2, colW3, bH).strokeColor(BDR).lineWidth(0.4).stroke().restore();
  doc.save().rect(c2x, y2, colW3, bH).strokeColor(BDR).lineWidth(0.4).stroke().restore();
  doc.save().rect(c3x, y2, colW3, bH).strokeColor(BDR).lineWidth(0.4).stroke().restore();
  let cy1 = y2 + pad;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('DEBENTURE TRUSTEE', c1x + pad, cy1, { width: iw }); cy1 = doc.y + 4;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TXT).text('Catalyst Trusteeship Limited', c1x + pad, cy1, { width: iw }); cy1 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('SEBI-registered debenture trustee for the NCD issue.  Address and contact details are stated in the Information Memorandum / Disclosure Document for the relevant series.', c1x + pad, cy1, { width: iw, lineGap: 3 }); cy1 = doc.y + 16;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('901, 9th Floor, Tower-B, Peninsula\nBusiness Park, Senapati Bapat Marg,\nLower Parel (W), Mumbai – 400 013\nPhone: +91 (022) 4922 0555\nEmail: dt.mumbai@ctltrustee.com', c1x + pad, cy1, { width: iw, lineGap: 6 });
  let cy2 = y2 + pad;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('REGISTRAR TO THE ISSUE', c2x + pad, cy2, { width: iw }); cy2 = doc.y + 4;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TXT).text('Integrated Registry Management Services Private Limited', c2x + pad, cy2, { width: iw }); cy2 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('#30, Ramana Residency,\n4th Cross, Sampige Road,\nMalleswaram,\nBangalore – 560 003\nPhone: (080) 23460815 to 23460818\nCategory I Registrar And Share Transfer Agent\nSEBI Regd. INR000000544\nCIN: U74900TN2015PTC101466', c2x + pad, cy2, { width: iw, lineGap: 5 });
  let cy3 = y2 + pad;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('ISSUER / COMPANY ADDRESSES', c3x + pad, cy3, { width: iw }); cy3 = doc.y + 3;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text(co.legal_name, c3x + pad, cy3, { width: iw }); cy3 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('Registered office:', c3x + pad, cy3, { width: iw }); cy3 = doc.y + 1;
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text(COMPANY.registered_office_address, c3x + pad, cy3, { width: iw, lineGap: 1 }); cy3 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('Corporate office:', c3x + pad, cy3, { width: iw }); cy3 = doc.y + 1;
  doc.font('Helvetica').fontSize(7).fillColor(TXT).text(co.corporate_office_address, c3x + pad, cy3, { width: iw, lineGap: 1 }); cy3 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text(`RBI Reg. No.: ${COMPANY.rbi_registration_no}`, c3x + pad, cy3, { width: iw }); cy3 = doc.y + 2;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text(`CIN: ${co.cin}`, c3x + pad, cy3, { width: iw }); cy3 = doc.y + 4;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('Email: ', c3x + pad, cy3, { width: iw, continued: true });
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text(co.general_email, { width: iw }); cy3 = doc.y + 2;
  doc.font('Helvetica').fontSize(7).fillColor(MUT).text('Toll Free: ', c3x + pad, cy3, { width: iw, continued: true });
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TXT).text(co.general_phone, { width: iw });
  y2 += bH + 6;
  doc.font('Helvetica-Oblique').fontSize(6).fillColor(MUT).text(`${co.legal_name}  ·  For agent / branch use — not for public circulation`, LX, 828, { width: CW, align: 'center', lineBreak: false });

  doc.end();
  const buffer = await done;
  return { buffer, signatureBox, signaturePage };
}

/** Buffer-only convenience for the download route. */
export async function applicationFormBuffer(db: Db, applicationId: number): Promise<Buffer> {
  return (await applicationFormPdf(db, applicationId)).buffer;
}
