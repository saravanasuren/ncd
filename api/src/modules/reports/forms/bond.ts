/**
 * Debenture (Bond) Certificate — faithful port of the wealth app's
 * pdf-bond-certificate.js. Gold-bordered A4 certificate: letterhead, title +
 * subtitle pill, a 12-field detail table, the "For Value Received…" legal
 * paragraph, a TDS note, and three director signature blocks.
 *
 * Owner decision 2026-07-21: NCD issues the bond right after eSign, before
 * allotment — so the certificate number and allotment/redemption dates stay
 * blank ("—") until the series is allotted. Series uses `deemed_date` (no
 * close/allotted_at). The certificate number is NCD's own (migration 031),
 * assigned lazily on first generation.
 *
 * The holder's address is built by `customerAddress` (shared.ts) so it matches
 * the reports: street, city, DISTRICT, state, PINCODE. This file used to select
 * and join only address/city/state — the header even claimed NCD had "no
 * district/pin" — so both certificates printed an address missing the district
 * and pincode the customer profile clearly showed (fixed 2026-08-08).
 */
import PDFDocument from 'pdfkit';
import type { Db } from '../../../db/types.js';
import { errors } from '../../../lib/errors.js';
import { nextSeq, isUniqueViolation } from '../../../lib/sequences.js';
import { formatNumber, DEFAULT_NUMBER_FORMATS } from '../../../lib/numbering.js';
import { getCompanyProfile, getBondSignature } from '../../products/service.js';
import { companyHeader, companyAsAt, COMPANY, LOGO_PATH, HAS_LOGO, customerAddress, addressColumns, amountInWords } from './shared.js';

/** Only an issued investment carries a certificate — a pending application must
 * never burn a certificate number (mirrors wealth's gate). */
const ISSUABLE = new Set(['Active', 'Matured', 'Redeemed', 'RolledOver']);

/**
 * The subordinate-debt series (owner 2026-10-31). These three are unsecured
 * subordinated bonds and take ICL-style wording: "Subordinate Debt Certificate",
 * "Bond Holder", "Number of Bonds". Every OTHER series keeps the Debenture
 * Certificate it has always had, because those are secured debentures and
 * relabelling them would make the certificate say something untrue about where
 * the holder ranks if the company fails.
 *
 * Read from `series.is_subordinate`, NOT from the code or the name. It used to
 * match a hardcoded set of three codes, which meant any series added later — and
 * the owner is now adding one per month — fell through to the Debenture
 * Certificate and told the holder something untrue about where they rank.
 */
export const isSubordinate = (series: { is_subordinate?: unknown } | null | undefined): boolean =>
  series?.is_subordinate === true;

/** Subordinate-debt certificate number: SD-2026-0001 (owner 2026-11-02), on its
 *  own counter so it can never collide with the BC- numbers already issued. */
const SUBORDINATE_SERIAL_KEY = 'subordinate_debt';

/** Consolidated certificate number. Its own run, so it can never collide with
 * the per-investment `BC-` series even though both count from 1. */
const CONSOLIDATED_BOND_FORMAT = 'CB-{yyyy}-{seq:6}';

/**
 * How many numbers we will step past before giving up. Only ever consumed when
 * the counter is sitting behind numbers already issued, which migration 067
 * heals — so in practice the first attempt always wins.
 */
const MAX_SERIAL_ATTEMPTS = 50;

/**
 * Allocate a certificate number and claim it, with the hard guarantee the owner
 * asked for (2026-08-10): **a number is never issued twice**.
 *
 * Three things have to be true at once, and each is enforced by a different
 * layer, so no single mistake can produce a duplicate:
 *
 *   1. The counter hands out one value per call — `nextSeq` is a single atomic
 *      UPDATE … RETURNING, so two simultaneous requests cannot read the same
 *      number.
 *   2. The DATABASE refuses a repeat — a unique index on each serial column
 *      (031 for applications, 067 for consolidated_bonds). This is the part that
 *      makes the guarantee absolute: even a bug here cannot write a duplicate,
 *      the write simply fails.
 *   3. If (2) does fire — only possible when the counter has drifted BELOW the
 *      book, e.g. a restore from an older dump or a hand-edited sequence — we
 *      step to the next number instead of failing the print or, far worse,
 *      silently reusing one.
 *
 * `claim` returns the serial it wrote, or null when the TARGET record already
 * holds one (a concurrent generation beat us); `existing` then supplies that
 * number so both callers converge on a single certificate number.
 *
 * A retry leaves the skipped number unused. That is deliberate: a gap in the
 * run is harmless, a duplicate is not.
 */
async function allocateSerial(
  db: Db,
  key: string,
  template: string,
  year: number,
  claim: (candidate: string) => Promise<string | null>,
  existing: () => Promise<string | null>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SERIAL_ATTEMPTS; attempt++) {
    const candidate = formatNumber(template, { seq: await nextSeq(db, key), year });
    try {
      const claimed = await claim(candidate);
      if (claimed) return claimed;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      continue;                       // that number is taken — advance, never reuse
    }
    const cur = await existing();     // someone else claimed the target first
    if (cur) return cur;
  }
  throw new Error(`could not allocate a unique '${key}' certificate number after ${MAX_SERIAL_ATTEMPTS} attempts`);
}

/**
 * Certificate number, assigned LAZILY on first generation (wealth parity:
 * `BC-{year}-{seq:6}`). Deliberately uses a conditional UPDATE rather than its
 * own transaction: this runs standalone AND inside the eSign-completion
 * transaction, so opening one here would nest. If a concurrent generation wins
 * the race we simply adopt the number it assigned.
 */
async function ensureBondSerial(db: Db, applicationId: number, a: Record<string, unknown>, subordinate = false): Promise<string | null> {
  if (a.bond_serial_no) return String(a.bond_serial_no);
  if (!ISSUABLE.has(String(a.status))) return null; // not issued yet → prints "—"
  const year = new Date(String(a.allotment_date ?? new Date().toISOString())).getUTCFullYear();
  // A number already issued is never re-minted (the guard above), so the 8 BC-
  // numbers already on subordinate investments keep the number on the paper.
  const [key, format] = subordinate
    ? [SUBORDINATE_SERIAL_KEY, DEFAULT_NUMBER_FORMATS.subordinate_debt]
    : ['bond', DEFAULT_NUMBER_FORMATS.bond];
  return allocateSerial(
    db, key, format, year,
    async (candidate) => (await db.query<{ bond_serial_no: string }>(
      'UPDATE applications SET bond_serial_no = $1 WHERE id = $2 AND bond_serial_no IS NULL RETURNING bond_serial_no',
      [candidate, applicationId])).rows[0]?.bond_serial_no ?? null,
    async () => (await db.query<{ bond_serial_no: string | null }>(
      'SELECT bond_serial_no FROM applications WHERE id = $1', [applicationId])).rows[0]?.bond_serial_no ?? null,
  );
}

const C = { GOLD: '#c9a227', GOLD_DEEP: '#a8851f', NAVY: '#1a2540', TEXT: '#1a1a1a', MUTED: '#666666', TINT: '#fcf6e3' };
// The NCD's own term: three years. It is the fallback term for a line that
// carries none, and — since 2026-11-06 — the term the NCD form states when it
// is drawn for a subordinate holding (see _consolidatedBondPage).
const BOND_REDEMPTION_MONTHS = 36;
// Directors named on the certificate (as in wealth's production bond).
const DIRECTORS = [
  { name: 'Avinash Gopalakrishnan', title: 'Director' },
  { name: 'Gokul Govindarajan', title: 'Director' },
  { name: 'Sankar Venkataraman', title: 'Director' },
];

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

function _drawTitle(doc: Doc, y: number, subordinate = false, faceValue?: number): number {
  const title = subordinate ? 'Subordinate Debt Certificate' : 'Debenture Certificate';
  doc.fillColor(C.TEXT).font('Helvetica-Bold').fontSize(24).text(title, 0, y, { align: 'center', width: doc.page.width });
  y = doc.y + 8;
  // The subordinate subtitle carries the denomination, as ICL's does. Note it
  // does NOT say "Unsecured" — owner's wording, 2026-10-29.
  const subtitle = subordinate
    ? `(Non-Convertible, Redeemable, Subordinate Bonds of face value ${faceValue != null ? _fmtINR(faceValue) : 'Rs. 1,00,000'}/- each)`
    : '(Secured, Redeemable, Non-Convertible Debentures)';
  // 10pt for the longer subordinate wording, which overruns the pill at 11.
  doc.fontSize(subordinate ? 10 : 11).font('Helvetica-Bold');
  const pillW = doc.widthOfString(subtitle) + 36, pillX = (doc.page.width - pillW) / 2, pillH = 22;
  doc.save();
  doc.roundedRect(pillX, y, pillW, pillH, 11).fillAndStroke(C.TINT, C.GOLD);
  doc.fillColor(C.NAVY).font('Helvetica-Bold').fontSize(subordinate ? 10 : 11).text(subtitle, pillX, y + 6, { width: pillW, align: 'center' });
  doc.restore();
  return y + pillH + 18;
}

function _drawDetailTable(doc: Doc, y: number, rows: Array<[string, string, number?]>, upper = false): number {
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
    // Owner 2026-10-29: on the SUBORDINATE form the filled-in details print in
    // capitals; labels keep their normal case. Scoped to that form so the
    // Debenture Certificate the other series get is left exactly as it was.
    const value = String(rows[i]![1] || '—');
    // ...except the rupee prefix, which is an abbreviation and not part of the
    // filled-in detail: it reads "Rs." here as it does everywhere else on the
    // page — the pill, the legal paragraph and the labels (owner 2026-11-04,
    // "its RS both in capital - we need it like Rs."). Anchored to the start and
    // to a following figure so it can only ever catch the prefix _fmtINR puts
    // there, never an address that opens "RS PURAM" or "RS. NO 45".
    const shown = upper ? value.toUpperCase().replace(/^RS\.(?= [\d—])/, 'Rs.') : value;
    doc.font('Helvetica-Bold').text(shown, x + labelW + 12, rowY + 7, { width: valueW - 24 });
    rowY += rowH;
  }
  doc.restore();
  return y + totalH + 18;
}

/**
 * The promise-to-pay paragraph printed on every bond certificate — the
 * operative legal text of the instrument.
 *
 * Exported, and kept as a pure string builder, so the WORDING can be tested
 * directly. Inside the PDF it is compressed and ungreppable, which would leave
 * the one part of this document that actually binds the Company as the one part
 * no test could see.
 *
 * Owner-supplied wording, 2026-08-28. Two substantive changes beyond
 * punctuation, both deliberate:
 *   · the sum now appears in WORDS as well as figures — the standard protection
 *     against a misread or altered figure on a negotiable instrument. Uses the
 *     same amountInWords as the acknowledgment, so two documents can never word
 *     the same amount differently.
 *   · principal and interest are stated SEPARATELY. The old text promised the
 *     principal "including interest at the rate specified above", which read as
 *     though interest were paid together with the principal at redemption. It is
 *     not: interest is paid on the monthly payout run, principal at redemption.
 *     The certificate now says exactly what the system actually does.
 *
 * Owner 2026-09-09: the closing sentence incorporating the Private Placement
 * Offer Letter by reference ("The NCD is issued subject to and with the benefit
 * of the conditions mentioned in the Private Placement Offer Letter, which shall
 * be binding on the Company, the NCD Holders, and persons claiming by, through,
 * or under any of them.") was REMOVED at their instruction. The paragraph now
 * ends with the TDS undertaking. Nothing else in the wording changed.
 */
export function bondLegalParagraph(legalName: string, corporateOffice: string, totalAmount: number, subordinate = false): string {
  return `For Value Received, ${legalName}, having its Corporate Office at ${corporateOffice}, `
    + `promises to pay to the person(s) named herein as the holder(s), or their order, the sum of `
    + `Rs. ${Number(totalAmount).toLocaleString('en-IN')} (${amountInWords(totalAmount)}) upon presentation `
    + `and discharge of this ${subordinate ? 'Bond' : 'NCD'} Certificate on the date of redemption as mentioned above. `
    + `The principal amount shall be payable on redemption, while interest shall be paid separately at the `
    + `rate specified above, subject to deduction of tax at source at the rate prevailing from time to time `
    + `under the provisions of the Income-tax Act, 1961, or any statutory modification or re-enactment thereof.`;
}

function _drawLegalAndSign(doc: Doc, y: number, co: ReturnType<typeof companyHeader>, totalAmount: number, signatures: Array<Buffer | null>, subordinate = false) {
  const x = 50, w = doc.page.width - 100;
  doc.fillColor(C.TEXT).font('Helvetica').fontSize(9.5).text(
    bondLegalParagraph(co.legal_name, co.corporate_office_address, totalAmount, subordinate),
    x, y, { width: w, align: 'justify' });
  y = doc.y + 10;
  doc.font('Helvetica-Oblique').fontSize(9).text('*Will be subject to deduction of TDS on interest and applicable Government levies', x, y, { width: w });
  y = doc.y + 36;
  const colW = w / 3, signLineY = y, sigImgH = 32, sigPadX = 30;
  for (let i = 0; i < 3; i++) {
    const colX = x + i * colW;
    const sig = signatures[i];
    try { if (sig) doc.image(sig, colX + sigPadX, signLineY - sigImgH - 2, { fit: [colW - sigPadX * 2, sigImgH], align: 'center', valign: 'bottom' }); } catch { /* a corrupt/unreadable image must never break the certificate */ }
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
            a.status, a.bond_serial_no, a.date_money_received, a.interest_start_date,
            c.full_name, ${addressColumns('c.')},
            s.code AS series_code, s.name AS series_name, s.deemed_date, s.isin,
            s.is_subordinate, s.close_date AS series_close_date
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  // Decided BEFORE the number is minted: the two must agree, or a subordinate
  // bond would be stamped with a BC- number from the wrong run.
  const subSeries = isSubordinate(a);

  // A subordinate series issues ONE bond per customer per series, so there is no
  // per-investment certificate to issue here (owner 2026-11-03). Refused before
  // anything can mint a number.
  //
  // One already issued still prints: 8 of these were handed out under the older
  // rule and a reprint of a document a customer holds must keep working. Only a
  // NEW one is refused, and the message points at the document that replaces it.
  if (subSeries && !a.bond_serial_no) {
    throw errors.badRequest(
      'This series issues one bond covering all of a customer\'s investments in it. Print the series bond for this customer instead.');
  }

  const certificateNo = await ensureBondSerial(db, applicationId, a, subSeries);
  const nominee = (await db.query<Record<string, unknown>>('SELECT full_name, relationship FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 1', [a.customer_id])).rows[0];
  const line = (await db.query<Record<string, unknown>>(
    `SELECT al.amount, COALESCE(al.coupon_rate_pct, sch.coupon_rate_pct) AS coupon_rate_pct, al.tenure_months,
            COALESCE(sch.face_value, 100000) AS face_value, sch.name AS scheme_name
       FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
      WHERE al.application_id = $1 ORDER BY al.id LIMIT 1`, [applicationId])).rows[0] ?? {};
  // The company as it was when THIS SERIES was allotted, not as it is today —
  // but only on the subordinate form. The Debenture Certificate keeps whatever
  // the profile says, untouched (owner: "dont ever touch ncd 27 or 28").
  const coNow = companyHeader(await getCompanyProfile(db));
  const co = isSubordinate(a)
    ? companyAsAt(coNow, (a.series_close_date ?? a.deemed_date) as string | null)
    : coNow;

  const invested = Number(a.total_amount || 0);
  const faceValue = Number(line.face_value || 100000);
  const numNcds = invested > 0 ? Math.round(invested / faceValue) : null;
  const tenureMonths = Number(line.tenure_months) || BOND_REDEMPTION_MONTHS;
  const rateLabel = line.coupon_rate_pct != null ? `${Number(line.coupon_rate_pct).toFixed(2)}% per annum` : '—';
  const allotmentDate = a.allotment_date || a.deemed_date || null; // blank until allotted
  const redemptionDate = a.maturity_date || (allotmentDate ? _addMonths(allotmentDate, tenureMonths) : null);
  const fullAddress = customerAddress(a) || '—';

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  const sub = subSeries;

  _drawBorder(doc);
  let y = _drawHeader(doc, co);
  y = _drawTitle(doc, y, sub, faceValue);

  const addrColW = doc.page.width - 100 - 180 - 24;
  doc.font('Helvetica-Bold').fontSize(10);
  const addrRowH = Math.max(24, Math.ceil(doc.heightOfString(fullAddress, { width: addrColW })) + 14);

  const holder = sub ? 'Bond Holder' : 'NCD Holder';
  const unit = sub ? 'Bond' : 'NCD';
  // Nominee reads "NAME (RELATIONSHIP)" on the subordinate form, as ICL's does.
  const nomineeLabel = nominee?.full_name
    ? `${nominee.full_name as string}${sub && nominee.relationship ? ` (${nominee.relationship as string})` : ''}`
    : '—';
  // Scheme: the scheme's own name plus its terms, so the holder can see what
  // they bought without decoding a series code.
  const schemeLabel = line.scheme_name
    ? `${String(line.scheme_name)} (${tenureMonths} MONTH ${line.coupon_rate_pct != null ? Number(line.coupon_rate_pct).toFixed(2) : '—'}%)`
    : '—';
  // Effective Date = the series' own closing date, the SAME for every bond in the
  // series (owner 2026-11-02: "i decide to have the series close date to be the
  // months last date and accordingly it is to be the date of application. or we
  // can also rename it as effective date").
  //
  // Renamed rather than left as "Date of Application" because it is no longer
  // that: the holder applied on the day their money landed, which is earlier.
  // Interest still accrues from that earlier day — the line's own
  // date_money_received drives the schedule and is untouched by this.
  //
  // Falls back to the money-received date for a subordinate series with no close
  // date set, so the row can never print blank.
  const applicationDate = a.series_close_date || a.date_money_received || a.interest_start_date || null;

  const rows: Array<[string, string, number?]> = sub
    ? [
      // Subordinate debt: no Category, no Bond Id, no Date of Allotment
      // (owner 2026-10-29/30 — it prints as "—" until the series is allotted
      // and Date of Application now covers the question it was there to answer).
      ['Certificate No', certificateNo || '—'],
      // Which tranche of the subordinate book this bond belongs to (owner
      // 2026-11-04). The certificate number alone does not say: SD- numbers run
      // in one sequence across every subordinate series. The series NAME, since
      // that is what reads on a document a holder keeps ("Subordinate Debt 3",
      // not "SD3"); the code is only a fallback for a series left unnamed.
      ['Series', String(a.series_name || a.series_code || '—')],
      [`Name of ${holder}`, (a.full_name as string) || '—'],
      [`Address of ${holder}`, fullAddress, addrRowH],
      ['Nominee', nomineeLabel],
      ['Scheme', schemeLabel],
      ['Investment Value (Rs.)', _fmtINR(invested)],
      [`Number of ${unit}s`, numNcds != null ? String(numNcds) : '—'],
      ['Coupon Rate', rateLabel],
      ['Effective Date', _fmtDate(applicationDate as string | null)],
      ['Date of Redemption', _fmtDate(redemptionDate)],
      [`Face Value per ${unit} (Rs.)`, _fmtINR(faceValue)],
      // The asterisk anchors the TDS footnote below, which pointed at nothing
      // before (ICL anchors theirs on "Maturity Value*").
      ['Redemption Value* (Rs.)', _fmtINR(invested)],
    ]
    : [
      ['Category', `${a.series_code || a.series_name || '—'} Series`],
      ['Certificate No', certificateNo || '—'], // assigned on first generation once the investment is live
      ['Name of NCD Holder', (a.full_name as string) || '—'],
      ['Address of NCD Holder', fullAddress, addrRowH],
      ['Nominee', nomineeLabel],
      ['Investment Value (Rs.)', _fmtINR(invested)],
      ['Number of NCDs', numNcds != null ? String(numNcds) : '—'],
      ['Coupon Rate', rateLabel],
      ['Date of Allotment', _fmtDate(allotmentDate)],
      ['Date of Redemption', _fmtDate(redemptionDate)],
      ['Face Value per NCD (Rs.)', _fmtINR(faceValue)],
      ['Redemption Value (Rs.)', _fmtINR(invested)], // equals principal, per spec
    ];
  y = _drawDetailTable(doc, y, rows, sub);
  const signatures = await Promise.all([0, 1, 2].map((i) => getBondSignature(db, i).then((s) => s?.buffer ?? null)));
  _drawLegalAndSign(doc, y, co, invested, signatures, sub);

  doc.end();
  return done;
}

/**
 * Consolidated bond serial per (customer, series) — the single filing bond's
 * number, assigned LAZILY on first generation (mirrors ensureBondSerial). Own
 * sequence + `CB-{yyyy}-{seq}` so it never collides with the per-app `BC-` run.
 */
async function ensureConsolidatedBondSerial(db: Db, customerId: number, seriesId: number, year: number, subordinate = false): Promise<string> {
  const readExisting = async () => (await db.query<{ bond_serial_no: string }>(
    'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2',
    [customerId, seriesId])).rows[0]?.bond_serial_no ?? null;
  const existing = await readExisting();
  if (existing) return existing;
  // ON CONFLICT names the (customer, series) pair only, so a clash on the
  // SERIAL's own unique index (067) still raises — which is what allocateSerial
  // catches to step to the next number rather than reuse one.
  // On a subordinate series this document IS the bond, so it carries the SD-
  // run the owner asked for rather than the CB- one. Separate counters, so the
  // two can never collide; an existing number is returned above and never
  // re-minted, so nothing already issued changes.
  const [key, format] = subordinate
    ? [SUBORDINATE_SERIAL_KEY, DEFAULT_NUMBER_FORMATS.subordinate_debt]
    : ['consolidated_bond', CONSOLIDATED_BOND_FORMAT];
  return allocateSerial(
    db, key, format, year,
    async (candidate) => (await db.query<{ bond_serial_no: string }>(
      `INSERT INTO consolidated_bonds (customer_id, series_id, bond_serial_no) VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, series_id) DO NOTHING RETURNING bond_serial_no`,
      [customerId, seriesId, candidate])).rows[0]?.bond_serial_no ?? null,
    readExisting,
  );
}

/**
 * Consolidated debenture certificate for one customer's whole holding in a
 * series — ONE bond, total value, total units, plus the breakup of the small
 * investments it comprises. Document-only: the underlying investments and their
 * interest/redemption are unchanged.
 */
/**
 * Draw ONE customer's consolidated bond onto an existing document.
 *
 * Split out of consolidatedBondCertificatePdf (owner 2026-08-28) so a whole
 * series can be produced as one printable file without duplicating any of the
 * layout. The single-bond export below is this function plus a document, so the
 * two can never drift apart.
 *
 * NB: this MINTS a certificate number for a customer who has none.
 */
/**
 * Which of the two forms to DRAW. Only the drawing changes — the certificate
 * NUMBER always follows the series itself (see below), so a series cannot end
 * up with two numbers or a number from the wrong run.
 *
 *   'auto'      — the series decides, as it always has.
 *   'debenture' — draw the NCD / Debenture form even on a subordinate series
 *                 (owner 2026-11-06: a subordinate holding is to be printable
 *                 in both forms, from two buttons on the customer's page).
 */
export type BondTemplate = 'auto' | 'debenture';

async function _consolidatedBondPage(
  db: Db, doc: Doc, customerId: number, seriesId: number, template: BondTemplate = 'auto',
): Promise<void> {
  const apps = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.total_amount, a.allotment_date, a.maturity_date, a.status,
            a.date_money_received,
            l.coupon_rate_pct, l.tenure_months, l.face_value, l.scheme_name
       FROM applications a
       JOIN LATERAL (
         SELECT COALESCE(al.coupon_rate_pct, sch.coupon_rate_pct) AS coupon_rate_pct, al.tenure_months,
                COALESCE(sch.face_value, 100000) AS face_value, sch.name AS scheme_name
           FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
          WHERE al.application_id = a.id ORDER BY al.id LIMIT 1
       ) l ON TRUE
      WHERE a.customer_id = $1 AND a.series_id = $2 AND a.status = ANY($3::text[])
      ORDER BY a.date_money_received NULLS LAST, a.id`,
    [customerId, seriesId, [...ISSUABLE]])).rows;
  if (!apps.length) throw errors.notFound('No issued investments for this customer in this series');

  const cust = (await db.query<Record<string, unknown>>(`SELECT full_name, ${addressColumns()} FROM customers WHERE id = $1`, [customerId])).rows[0];
  const series = (await db.query<Record<string, unknown>>('SELECT code, name, deemed_date, is_subordinate, close_date FROM series WHERE id = $1', [seriesId])).rows[0];
  if (!cust || !series) throw errors.notFound('Customer or series not found');
  const nominee = (await db.query<Record<string, unknown>>('SELECT full_name, relationship FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 1', [customerId])).rows[0];
  // As above: the name as at the SERIES' date, subordinate form only. Falling
  // back to the deemed date covers a subordinate series with no close date, and
  // to the earliest money in the holding if it has neither.
  const coNow = companyHeader(await getCompanyProfile(db));
  const co = isSubordinate(series)
    ? companyAsAt(coNow, (series.close_date ?? series.deemed_date
        ?? apps.map((a) => a.date_money_received).filter(Boolean).sort()[0]) as string | null)
    : coNow;

  // A subordinate series issues exactly ONE bond per customer per series — the
  // consolidated certificate IS its bond (owner 2026-11-03: "consolidate at the
  // Customer ID plus Series level ... generate only one bond document per
  // series"). The transactions stay recorded separately underneath; only the
  // document is merged.
  //
  // This can state ONE coupon rate and ONE redemption date truthfully because
  // the series makes it so: no customer's own investments inside a series
  // disagree on rate or term (checked against production), and since migration
  // 108 every investment in a series matures on the series close date + tenure.
  const subordinateSeries = isSubordinate(series);
  // WHAT IS DRAWN vs WHAT IS MINTED.
  //
  // `sub` below drives the wording only. The certificate NUMBER is minted from
  // `subordinateSeries` — the series' own standing — whichever form was asked
  // for, and ensureConsolidatedBondSerial returns the number already on the
  // (customer, series) pair before it ever mints. So the two forms print the
  // SAME certificate number: one holding, one number, two renderings. Minting
  // off the requested form instead would have let whoever downloaded first
  // decide which run the number came from, and a subordinate bond would wear a
  // CB- number because somebody pressed the other button.
  const drawDebenture = template === 'debenture';

  const totalInvested = apps.reduce((s, a) => s + Number(a.total_amount || 0), 0);
  const faceValue = Number(apps[0]!.face_value || 100000);
  const numNcds = faceValue > 0 ? Math.round(totalInvested / faceValue) : null;
  const tenureMonths = Number(apps[0]!.tenure_months) || BOND_REDEMPTION_MONTHS;
  const uniq = (v: unknown[]) => [...new Set(v.filter((x) => x != null).map(String))];

  const coupons = uniq(apps.map((a) => (a.coupon_rate_pct != null ? Number(a.coupon_rate_pct).toFixed(2) : null)));
  const rateLabel = coupons.length === 1 ? `${coupons[0]}% per annum` : coupons.length ? 'As per breakup below' : '—';
  const allotDates = uniq(apps.map((a) => (a.allotment_date ? _fmtDate(a.allotment_date) : null)));
  const allotLabel = allotDates.length === 1 ? allotDates[0]! : allotDates.length ? 'As per breakup below' : '—';
  const redDates = uniq(apps.map((a) => {
    const rd = a.maturity_date || (a.allotment_date ? _addMonths(a.allotment_date, Number(a.tenure_months) || tenureMonths) : null);
    return rd ? _fmtDate(rd) : null;
  }));
  const redLabel = redDates.length === 1 ? redDates[0]! : redDates.length ? 'As per breakup below' : '—';
  const schemeNames = uniq(apps.map((a) => a.scheme_name ?? null));
  const cSchemeLabel = schemeNames.length === 1 ? schemeNames[0]! : schemeNames.length ? schemeNames.join(' / ') : '—';

  // ── THE NCD FORM ON A SUBORDINATE HOLDING STATES THE NCD'S OWN TERM ──────
  //
  // Owner 2026-11-06, on the first certificate printed from the new button:
  // "NCD is 3 years tenure, so redemption date will be 3 years from" the
  // allotment date — plain calendar months, no working-day shift ("not last
  // working day").
  //
  // NOTHING BELOW TOUCHES THE MONEY. The holding is 60-month subordinated debt:
  // application_lines carry tenure_months = 60, the interest schedule is
  // materialised for 60 months and the redemption row sits at close + 60. Only
  // the DRAWING of the parallel NCD form changes, which is why the two buttons
  // print different redemption dates for one holding. That is the owner's
  // decision and is recorded here so it is not "corrected" back by the next
  // reader — and it is the reason this is a pro-forma rendering, not a second
  // instrument: there is still one certificate number and one schedule.
  //
  // Allotment is read off the SERIES, for the same reason the subordinate form
  // already reads series.close_date: since migration 108 the series close date
  // IS the date of allotment. applications.allotment_date is stamped only by
  // the separate batch-allotment step (modules/allotments), which has not been
  // run for the SD series, so reading it printed a blank row.
  const ncdForm = subordinateSeries && drawDebenture;
  const ncdAllotLabel = _fmtDate(series.close_date as string | null);
  const ncdRedLabel = _fmtDate(_addMonths(series.close_date, BOND_REDEMPTION_MONTHS));

  const anyAllot = apps.map((a) => a.allotment_date).find(Boolean) ?? series.deemed_date ?? null;
  const year = new Date(String(anyAllot ?? new Date().toISOString())).getUTCFullYear();
  const certificateNo = await ensureConsolidatedBondSerial(db, customerId, seriesId, year, subordinateSeries);
  const fullAddress = customerAddress(cust) || '—';

  const sub = subordinateSeries && !drawDebenture;

  _drawBorder(doc);
  let y = _drawHeader(doc, co);
  y = _drawTitle(doc, y, sub, faceValue);
  const addrColW = doc.page.width - 100 - 180 - 24;
  doc.font('Helvetica-Bold').fontSize(10);
  const addrRowH = Math.max(24, Math.ceil(doc.heightOfString(fullAddress, { width: addrColW })) + 14);

  const cHolder = sub ? 'Bond Holder' : 'NCD Holder';
  const cUnit = sub ? 'Bond' : 'NCD';
  const cNominee = nominee?.full_name
    ? `${nominee.full_name as string}${sub && nominee.relationship ? ` (${nominee.relationship as string})` : ''}`
    : '—';

  const rows: Array<[string, string, number?]> = sub
    ? [
      // A consolidated certificate covers several investments, so there is no
      // single application date to print — the per-investment certificates
      // carry those. Everything else matches the subordinate form.
      ['Certificate No', certificateNo],
      // As above — the tranche this bond belongs to.
      ['Series', String(series.name || series.code || '—')],
      [`Name of ${cHolder}`, (cust.full_name as string) || '—'],
      [`Address of ${cHolder}`, fullAddress, addrRowH],
      ['Nominee', cNominee],
      // The scheme the holding is on (owner 2026-11-03). Every investment a
      // customer holds in one series shares a rate and a term, so this is a
      // single value; the uniq() guard only shows if that ever stops being true.
      ['Scheme', cSchemeLabel],
      ['Investment Value (Rs.)', _fmtINR(totalInvested)],
      [`Number of ${cUnit}s`, numNcds != null ? String(numNcds) : '—'],
      ['Coupon Rate', rateLabel],
      // The series' own close date, identical for every bond in the series —
      // the same row the per-investment form carries. It is the allotment date
      // (owner 2026-11-03), and every investment here matures on it + tenure,
      // which is what lets a single document state one redemption date.
      ['Effective Date', _fmtDate(series.close_date as string | null)],
      ['Date of Redemption', redLabel],
      [`Face Value per ${cUnit} (Rs.)`, _fmtINR(faceValue)],
      ['Redemption Value* (Rs.)', _fmtINR(totalInvested)],
    ]
    : [
      ['Category', `${series.code || series.name || '—'} Series`],
      ['Certificate No', certificateNo],
      ['Name of NCD Holder', (cust.full_name as string) || '—'],
      ['Address of NCD Holder', fullAddress, addrRowH],
      ['Nominee', cNominee],
      ['Investment Value (Rs.)', _fmtINR(totalInvested)],
      ['Number of NCDs', numNcds != null ? String(numNcds) : '—'],
      ['Coupon Rate', rateLabel],
      ['Date of Allotment', ncdForm ? ncdAllotLabel : allotLabel],
      ['Date of Redemption', ncdForm ? ncdRedLabel : redLabel],
      ['Face Value per NCD (Rs.)', _fmtINR(faceValue)],
      ['Redemption Value (Rs.)', _fmtINR(totalInvested)],
    ];
  y = _drawDetailTable(doc, y, rows, sub);
  const signatures = await Promise.all([0, 1, 2].map((i) => getBondSignature(db, i).then((s) => s?.buffer ?? null)));
  _drawLegalAndSign(doc, y, co, totalInvested, signatures, sub);
}

/** One customer's consolidated bond for a series. */
export async function consolidatedBondCertificatePdf(
  db: Db, customerId: number, seriesId: number, template: BondTemplate = 'auto',
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  await _consolidatedBondPage(db, doc, customerId, seriesId, template);
  doc.end();
  return done;
}

/**
 * Every customer's consolidated bond for a series, in ONE printable file (owner
 * 2026-08-28: "a button which says download all bonds").
 *
 * Bonds are drawn in the order given, one per page. Minting is the caller's
 * decision to have made: producing these permanently allocates a certificate
 * number to every customer who lacked one, and the UI warns with the count
 * before it is clicked.
 */
export async function consolidatedBondsForSeriesPdf(
  db: Db, seriesId: number, customerIds: number[],
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  for (const [i, customerId] of customerIds.entries()) {
    if (i > 0) doc.addPage();
    await _consolidatedBondPage(db, doc, customerId, seriesId);
  }
  doc.end();
  return done;
}
