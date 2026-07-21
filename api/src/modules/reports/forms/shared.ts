/**
 * Shared helpers for the wealth-faithful investment documents (acknowledgement,
 * application form, bond certificate). Ported from the wealth app's pdf-*.js
 * services so the NCD documents match what customers already receive.
 *
 * pdfkit's built-in Helvetica has no ₹ (U+20B9) glyph, so money is rendered
 * "Rs. …" (as wealth does). Company header facts are stable constants (wealth's
 * COMPANY_DEFAULTS) overlaid with whatever the DB company_profile provides.
 */
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Print logo (git-tracked at api/assets); resolves the same from src or dist. */
export const LOGO_PATH = fileURLToPath(new URL('../../../../assets/dhanam-logo.png', import.meta.url));
export const HAS_LOGO = (() => { try { return existsSync(LOGO_PATH); } catch { return false; } })();
/** Optional Authorised-Signatory signature image; drop one here to have it
 *  embedded on the acknowledgement / bond. Absent by default → signature line. */
export const SIGNATURE_PATH = fileURLToPath(new URL('../../../../assets/authorised-signature.png', import.meta.url));

export const COLORS = {
  GOLD: '#C9A227', GOLD_DEEP: '#5e4708', NAVY: '#0B1730',
  TEXT: '#1a2540', MUTED: '#74798c', BORDER: '#ECE9E0', RULE: '#D7D2C0',
};

/** Stable company facts (wealth COMPANY_DEFAULTS). NCD's company_profile lacks
 *  CIN/address/contact, so these back the header; DB values override where set. */
export const COMPANY = {
  legal_name: 'Dhanam Investment and Finance Private Limited',
  cin: 'U64920TZ2016PTC031308',
  rbi_registration_no: 'N-07.00831',
  corporate_office_address: '2/191B, 2nd Floor, Darshini Business Centre, Mylampatty Road, Karayampalayam, Chinniyampalayam, Coimbatore, TN - 641 048',
  registered_office_address: '22/3, 2nd Street, Nehru Nagar, Behind CMS School, Ganapathy, Coimbatore, TN - 641 006',
  website: 'www.dhanamfinance.com',
  general_email: 'contact@dhanam.finance',
  general_phone: '1800 202 5180',
  signatory_designation: 'Authorised Signatory',
} as const;

export interface CompanyHeader {
  legal_name: string; cin: string; corporate_office_address: string;
  general_phone: string; general_email: string; website: string; signatory_designation: string;
}
/** Overlay the DB company_profile onto the constants for header rendering. */
export function companyHeader(profile: Record<string, unknown> | null | undefined): CompanyHeader {
  const p = profile ?? {};
  const pick = (k: string, d: string) => (typeof p[k] === 'string' && (p[k] as string).trim() ? (p[k] as string) : d);
  return {
    legal_name: pick('legal_name', COMPANY.legal_name),
    cin: pick('cin', COMPANY.cin),
    corporate_office_address: pick('corporate_office_address', COMPANY.corporate_office_address),
    general_phone: pick('general_phone', COMPANY.general_phone),
    general_email: pick('general_email', COMPANY.general_email),
    website: pick('website', COMPANY.website),
    signatory_designation: pick('signatory_designation', COMPANY.signatory_designation),
  };
}

export function fmtDate(d: unknown): string {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(String(d));
  if (isNaN(dt.getTime())) return '—';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}`;
}
export function fmtINR(v: unknown): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return 'Rs. ' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Indian rupee amount → words (up to crores). Ported from wealth. */
export function amountInWords(input: unknown): string {
  const n = Number(String(input).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const under1k = (x: number): string => {
    if (x === 0) return '';
    if (x < 20) return units[x]!;
    if (x < 100) return tens[Math.floor(x / 10)]! + (x % 10 ? ' ' + units[x % 10] : '');
    return units[Math.floor(x / 100)]! + ' Hundred' + (x % 100 ? ' and ' + under1k(x % 100) : '');
  };
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thou = Math.floor((n % 100000) / 1000);
  const rest = Math.floor(n % 1000);
  const parts: string[] = [];
  if (crore) parts.push(under1k(crore) + ' Crore');
  if (lakh) parts.push(under1k(lakh) + ' Lakh');
  if (thou) parts.push(under1k(thou) + ' Thousand');
  if (rest) parts.push(under1k(rest));
  return 'Rupees ' + parts.join(' ').trim() + ' Only';
}

/** Run a pdfkit builder and collect the output into a Buffer. */
export function renderToBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 30, bottom: 50, left: 50, right: 50 } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { build(doc); doc.end(); } catch (e) { reject(e as Error); }
  });
}

/** Dhanam letterhead: logo top-left, company name/CIN/address/contact top-right,
 *  gold rule beneath. Returns the y to continue from. */
export function drawHeader(doc: PDFKit.PDFDocument, co: CompanyHeader): number {
  if (HAS_LOGO) {
    try { doc.image(LOGO_PATH, 50, 36, { width: 50, height: 50 }); } catch { /* logo optional */ }
  }
  const xR = 110;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.GOLD_DEEP).text(co.legal_name.toUpperCase(), xR, 36, { width: 440 });
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.TEXT).text('CIN: ' + co.cin, xR, 53);
  doc.text('Corporate Office: ' + co.corporate_office_address, xR, 64, { width: 440 });
  doc.text([
    co.general_phone ? 'Toll-Free: ' + co.general_phone : null,
    co.general_email ? 'Email: ' + co.general_email : null,
    co.website || null,
  ].filter(Boolean).join('   ·   '), xR, 88, { width: 440 });
  doc.moveTo(50, 110).lineTo(545, 110).lineWidth(1).strokeColor(COLORS.GOLD).stroke();
  return 122;
}

/** Navy section bar. Returns the y beneath it. */
export function section(doc: PDFKit.PDFDocument, y: number, title: string): number {
  doc.rect(50, y, 495, 16).fill(COLORS.NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff').text(title, 56, y + 4, { width: 485 });
  return y + 22;
}

/** Label/value row that advances past however many lines the value wrapped to. */
export function kv(doc: PDFKit.PDFDocument, y: number, label: string, value: unknown, opts?: { bold?: boolean; labelW?: number }): number {
  const labelW = opts?.labelW ?? 170;
  doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.MUTED).text(label, 50, y, { width: labelW });
  const labelEndY = doc.y;
  doc.font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(COLORS.TEXT)
    .text(String(value == null || value === '' ? '—' : value), 50 + labelW, y, { width: 495 - labelW });
  return Math.max(labelEndY, doc.y) + 4;
}
