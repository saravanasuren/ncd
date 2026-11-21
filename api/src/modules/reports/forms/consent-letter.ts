/**
 * Consent for Premature Redemption — the document a holder signs to let the
 * Company redeem their NCDs early.
 *
 * Reproduced from the owner's "Consent for Waiver and Redemption from Each NCD
 * Holder.docx" (supplied 2026-11-20). Like the redemption request letter, this
 * is written BY THE HOLDER: "I, <name>, am the registered holder…", and the
 * only signature on it is theirs. So no letterhead and no logo — the Word file
 * has neither, and the company appears only as the issuer named in the opening
 * sentence.
 *
 * IT REPLACES THE REQUEST LETTER IN THE SIGNING FLOW (owner 2026-11-20, asked
 * outright). The request letter from #530 is untouched and the bulk
 * spreadsheet tool goes on printing it; what changed is which document gates a
 * redemption. This one does, because it is the one that actually protects the
 * Company: the waiver, the no-further-claims clause and the Trustee authority
 * are all here and none of them is in the request letter.
 *
 * STRUCTURE IS THE WORD FILE'S, READ OUT OF IT RATHER THAN GUESSED. The six
 * clauses are a decimal-numbered list (numId 1 → "%1."), each opening with a
 * bold lead-in phrase; the three declarations are a bullet list (numId 2). The
 * plain-text extraction loses both, so the numbering was taken from the
 * document's own numbering.xml rather than inferred from how it reads.
 *
 * THE COMPANY NAME IS FIXED, not era-driven. The request letter swings between
 * three addressee blocks by date because the bulk tool back-dates letters for
 * years. This document applies only from 1 November 2026 onward, so every
 * letter it ever prints falls in the current era — and the Word file states
 * that name outright. A second era mechanism here would be a branch nobody
 * crosses.
 */

import { renderToBuffer } from './shared.js';

/**
 * A particular that may be a real value OR free text the operator typed.
 *
 * The bulk tool can cover SEVERAL SERIES in one letter (owner 2026-11-21), and
 * then a single box legitimately holds three dates — "18-04-2025, 20-10-2025,
 * 30-12-2025" — or a mixed "Physical / Demat". There is no date, rate or
 * amount to parse there, and refusing or blanking it threw away the only
 * information the letter had. So: format it when it IS a date or a number,
 * and otherwise print exactly what was typed.
 *
 * The live redemption screen still passes real ISO dates and numbers, so its
 * letters are byte-for-byte what they were.
 */
export type Particular = string | number | null;

export interface ConsentLetterRow {
  /** ISO yyyy-mm-dd — prints nowhere, but dates the file and the audit trail. */
  letter_date: string;
  holder_name: string;
  pan: string;
  series: string;
  /** ISO, free text, or blank. */
  allotment_date: Particular;
  /**
   * When this holding was rolled over — ISO, or blank for the great majority
   * that never were. Asked at redemption time, never derived: see the row
   * itself for why the book cannot answer it.
   */
  rollover_date: Particular;
  original_maturity_date: Particular;
  /** The number being REDEEMED (owner 2026-11-20), not the whole holding. */
  ncd_count: string;
  face_value: Particular;
  coupon_rate_pct: Particular;
  /** 'Demat' | 'Physical' | '' — blank prints the empty box to tick by hand. */
  mode_of_holding: string;
  account_name: string;
  account_no: string;
  bank_and_branch: string;
  ifsc: string;
}

const LEFT = 56;
const RIGHT = 56;
const WIDTH = 595.28 - LEFT - RIGHT; // A4 width in points
const BODY = 10.5;

/** "18-Aug-2025", the form every other Dhanam document uses. Blank stays blank. */
function fmtDay(iso: string): string {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const dt = new Date(`${s}T00:00:00Z`);
  if (isNaN(dt.getTime())) return '';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}`;
}

/** Indian grouping, no symbol — the template writes its own ₹. */
function plainINR(v: number | null): string {
  if (v == null || !isFinite(Number(v))) return '';
  const n = Number(v);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** The rate as the template writes it: "12.5%", not "12.5000". */
function ratePct(v: number | null): string {
  if (v == null || !isFinite(Number(v))) return '';
  const n = Number(v);
  return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
}

/** A date when it is one, otherwise the text as typed. */
function dateOrText(v: Particular): string {
  const raw = v == null ? '' : String(v).trim();
  if (!raw) return '';
  return fmtDay(raw) || raw;
}

/** Indian-grouped money when it is a number, otherwise the text as typed. */
function moneyOrText(v: Particular): string {
  if (v == null) return '';
  if (typeof v === 'number') return plainINR(v);
  const raw = String(v).trim();
  if (!raw) return '';
  const n = Number(raw.replace(/[,\s]/g, ''));
  return raw !== '' && Number.isFinite(n) && /^[\d.,\s]+$/.test(raw) ? plainINR(n) : raw;
}

/** "12.5%" when it is a rate, otherwise the text as typed. */
function rateOrText(v: Particular): string {
  if (v == null) return '';
  if (typeof v === 'number') return ratePct(v);
  const raw = String(v).trim();
  if (!raw) return '';
  const n = Number(raw.replace(/[%\s]/g, ''));
  return /^[\d.\s%]+$/.test(raw) && Number.isFinite(n) ? ratePct(n) : raw;
}

export function consentLetterPdf(row: ConsentLetterRow): Promise<Buffer> {
  return renderToBuffer((doc) => {
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    let y = 46;

    /**
     * Start a new page when the next block will not fit.
     *
     * This document runs longer than the request letter — a table, six
     * clauses, a declaration and a sign-off — so unlike that one it genuinely
     * spans pages for some holders. Measuring each block BEFORE drawing it is
     * what keeps a heading off the bottom of one page with its paragraph on
     * the next, and keeps the signature with the sign-off it belongs to.
     */
    const room = (needed: number) => {
      if (y + needed > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    };
    const measure = (text: string, font: string, size: number, width = WIDTH) => {
      doc.font(font).fontSize(size);
      return doc.heightOfString(text, { width });
    };
    const para = (text: string, opts?: { font?: string; size?: number; gap?: number; align?: 'left' | 'justify' }) => {
      const font = opts?.font ?? 'Helvetica';
      const size = opts?.size ?? BODY;
      room(measure(text, font, size) + 2);
      doc.font(font).fontSize(size).fillColor('#000')
        .text(text, LEFT, y, { width: WIDTH, align: opts?.align ?? 'left' });
      y = doc.y + (opts?.gap ?? 0);
    };

    // ── Title ────────────────────────────────────────────────────────────────
    para('Consent for Premature Redemption', { font: 'Helvetica-Bold', size: 13.5, gap: 14 });

    // ── Opening sentence. The company is named here and nowhere else. ────────
    para(
      `I, ${row.holder_name || '[Full name of NCD Holder]'}, am the registered holder of the following`
      + ' Non-Convertible Debentures ("NCDs") issued by Dhanam Investment and Finance Limited'
      + ' (Formerly Kiara Microcredit Private Limited) ("the Company"):',
      { align: 'justify', gap: 12 });

    // ── Particulars table ────────────────────────────────────────────────────
    y = particulars(doc, y, row, room);
    y += 16;

    // ── Consent and waiver ───────────────────────────────────────────────────
    para('Consent and waiver', { font: 'Helvetica-Bold', size: 11.5, gap: 8 });

    // Each clause: a decimal number, a bold lead-in, then the rest in regular.
    // Wording is the owner's, verbatim; only the blanks are filled.
    const clauses: [string, string][] = [
      ['Consent to premature redemption.',
        ` I hereby give my free, unconditional and irrevocable consent to the Company to redeem all `
        + `${row.ncd_count || '__________'} NCDs held by me under Series /Rollover Series `
        + `${row.series || '____________'} before their scheduled maturity date.`],
      ['Redemption amount.',
        ' I agree to accept, in full and final settlement, the face value of the NCDs together with'
        + ' coupon/interest accrued up to the day before the Early Redemption Date, less applicable TDS.'],
      ['Waiver of 2% additional premium.',
        ' I understand that the Debenture Trust Deed provides for an additional premium of 2% (two per'
        + ' cent) on premature redemption. I hereby voluntarily and irrevocably waive my right to receive'
        + ' this 2% additional premium, and any other prepayment premium, penalty or charge payable on'
        + ' premature redemption.'],
      ['No further claims.',
        ' On receipt of the redemption amount in my registered bank account, I shall have no further'
        + ' claim against the Company or the Debenture Trustee for principal, interest, premium or any'
        + ' other amount relating to these NCDs.'],
      ['Payment account.',
        ' Please credit the redemption amount to:'],
      ['Authority to Trustee.',
        ' I authorise the Debenture Trustee to treat this letter as my consent for the premature'
        + ' redemption and the waiver above, and to take all steps needed with the Depository / RTA to'
        + ' extinguish the NCDs.'],
    ];

    const NUM_W = 18;
    const TEXT_W = WIDTH - NUM_W;
    clauses.forEach(([lead, rest], i) => {
      room(measure(lead + rest, 'Helvetica', BODY, TEXT_W) + 8);
      doc.font('Helvetica').fontSize(BODY).fillColor('#000').text(`${i + 1}.`, LEFT, y, { width: NUM_W });
      doc.font('Helvetica-Bold').fontSize(BODY)
        .text(lead, LEFT + NUM_W, y, { width: TEXT_W, align: 'justify', continued: true })
        .font('Helvetica').text(rest, { align: 'justify' });
      y = doc.y + 6;

      // The bank block belongs to clause 5 and is indented under it.
      if (i === 4) {
        // LABEL AND VALUE IN TWO COLUMNS, no separator between them. The Word
        // file lists these as bare labels with a trailing space and nothing
        // after — whoever fills it in writes the value there. An em dash or a
        // colon would be punctuation this document does not have, so the value
        // is positioned instead, which is the layout the template implies.
        const labelX = LEFT + NUM_W + 12;
        const valueX = labelX + 108;
        for (const [label, value] of [
          ['Account name', row.account_name],
          ['Account No.', row.account_no],
          ['Bank & Branch', row.bank_and_branch],
          ['IFSC', row.ifsc],
        ] as const) {
          room(16);
          doc.font('Helvetica').fontSize(BODY).fillColor('#000')
            .text(label, labelX, y, { width: 104 });
          if (value) {
            doc.text(value, valueX, y, { width: WIDTH - (valueX - LEFT) });
          }
          y = doc.y + 2;
        }
        y += 6;
      }
    });

    y += 10;

    // ── Declaration ──────────────────────────────────────────────────────────
    //
    // THE DECLARATION AND THE SIGN-OFF BREAK TOGETHER, measured as one block
    // before either is drawn.
    //
    // Without this the document ran to two pages whose second page held
    // "Thanking you", a rule, "Signature", a name and a PAN — and nothing
    // else. A page carrying only a signature is a page that can be detached
    // from what it is supposed to be consenting to, which on a waiver of
    // claims is the one thing worth getting right. Breaking at the Declaration
    // instead gives a second page that reads as a page: what the holder is
    // confirming, then where they sign it.
    const declarationPoints = [
      'I am the lawful holder of the NCDs listed above, and they are free from any pledge, lien or'
      + ' encumbrance.',
      'I have read and understood the terms of the NCD issue, including the early-redemption and'
      + ' premium clauses.',
      'I give this consent and waiver of my own free will, without any coercion or undue influence.',
    ];
    const declarationH = measure('Declaration', 'Helvetica-Bold', 11.5) + 4
      + measure('I confirm that:', 'Helvetica', BODY) + 6
      + declarationPoints.reduce((h, p) => h + measure(p, 'Helvetica', BODY, WIDTH - 18) + 5, 0);
    room(declarationH + 14 + 150);

    para('Declaration', { font: 'Helvetica-Bold', size: 11.5, gap: 4 });
    para('I confirm that:', { gap: 6 });
    for (const point of [
      'I am the lawful holder of the NCDs listed above, and they are free from any pledge, lien or'
      + ' encumbrance.',
      'I have read and understood the terms of the NCD issue, including the early-redemption and'
      + ' premium clauses.',
      'I give this consent and waiver of my own free will, without any coercion or undue influence.',
    ]) {
      room(measure(point, 'Helvetica', BODY, WIDTH - NUM_W) + 6);
      doc.font('Helvetica').fontSize(BODY).fillColor('#000').text('•', LEFT + 4, y, { width: 12 });
      doc.text(point, LEFT + NUM_W, y, { width: WIDTH - NUM_W, align: 'justify' });
      y = doc.y + 5;
    }

    // ── Sign-off, kept together ──────────────────────────────────────────────
    //
    // One block, measured as one: "Thanking you" at the foot of a page with the
    // signature overleaf is not a signed document. 150pt covers the sign-off,
    // the pen gap and the three identification lines.
    y += 14;
    room(150);
    doc.font('Helvetica').fontSize(BODY).fillColor('#000').text('Thanking you,', LEFT, y, { width: WIDTH });
    y = doc.y + 10;
    doc.text('Yours faithfully,', LEFT, y, { width: WIDTH });
    y = doc.y + 46;
    doc.text('________', LEFT, y, { width: WIDTH });
    y = doc.y + 2;
    doc.text('Signature', LEFT, y, { width: WIDTH });
    y = doc.y + 10;
    doc.text(`Name: ${row.holder_name || ''}`, LEFT, y, { width: WIDTH });
    y = doc.y + 4;
    doc.text(`PAN: ${row.pan || ''}`, LEFT, y, { width: WIDTH });
  });
}

/**
 * The Particulars / Details table, two columns, eight rows.
 *
 * Drawn by hand because pdfkit has no table primitive and every other form in
 * this folder draws its own. A row whose value is unknown prints an EMPTY cell
 * rather than a dash or a guess: this is a document somebody signs, and a blank
 * invites the obvious correction where "—" reads like a settled fact.
 */
function particulars(
  doc: PDFKit.PDFDocument, top: number, row: ConsentLetterRow, room: (n: number) => void,
): number {
  const rows: [string, string][] = [
    ['Series / Tranche', row.series],
    ['Date of allotment', dateOrText(row.allotment_date)],
    // ASKED, NOT DERIVED, and blank for almost everyone.
    //
    // This row is in the owner's Word file and was missing from the first
    // version of this generator. It cannot be filled from the book: the
    // rollover feature here has never been used (the `rollovers` table is
    // empty, nothing has source = 'rollover'), real rollovers exist only as
    // six series named "NCD 05 Rollover" … "NCD 10 Rollover", and the
    // pre-rollover investment is not in the book at all — so the one date we
    // hold for a rolled-over holding is already printing as Date of allotment
    // above. Repeating it here under a second label would read as a second
    // fact. Staff are asked instead, and an unanswered row prints empty.
    ['Date of Rollover', dateOrText(row.rollover_date)],
    // "Date of Maturity", the Word file's own wording (owner 2026-11-21). It
    // read "Original maturity date" — a phrase that appears nowhere in the
    // format. The FIELD keeps its name: it is internal, nothing reads it by
    // label, and renaming it would churn four files to change no one's
    // experience.
    ['Date of Maturity', dateOrText(row.original_maturity_date)],
    ['Number of NCDs held', row.ncd_count],
    // "Rs." NOT "₹". The Word file writes the rupee sign, but Helvetica has no
    // glyph for it and pdfkit's WinAnsi encoding rendered it as a superscript
    // one — "Face value per NCD ( ¹)" — on a document a customer signs. Every
    // other Dhanam PDF writes "Rs." for exactly this reason (fmtINR in
    // shared.ts), so this follows them rather than embedding a second font for
    // one character. Flagged to the owner as a forced deviation.
    ['Face value per NCD (Rs.)', moneyOrText(row.face_value)],
    ['Coupon rate (% p.a.)', rateOrText(row.coupon_rate_pct)],
    // Blank unless staff answered it. The owner chose to be ASKED at redemption
    // time rather than have it inferred: demat details were only ever synced
    // for about a third of the book, so an empty record does not mean physical,
    // and printing "Physical" on a demat holder's consent is a false statement
    // on something they are signing.
    ['Mode of holding', row.mode_of_holding],
  ];
  const LABEL_W = 190;
  const VALUE_W = WIDTH - LABEL_W;
  const pad = 5;

  const heights = rows.map(([l, v]) => {
    doc.font('Helvetica').fontSize(BODY);
    return Math.max(18, doc.heightOfString(l, { width: LABEL_W - pad * 2 }) + pad * 2,
      doc.heightOfString(v || ' ', { width: VALUE_W - pad * 2 }) + pad * 2);
  });
  const headerH = 20;
  room(headerH + heights.reduce((a, b) => a + b, 0));

  let y = top;
  // Header — bold in the template.
  doc.rect(LEFT, y, LABEL_W, headerH).lineWidth(0.6).strokeColor('#000').stroke();
  doc.rect(LEFT + LABEL_W, y, VALUE_W, headerH).lineWidth(0.6).strokeColor('#000').stroke();
  doc.font('Helvetica-Bold').fontSize(BODY).fillColor('#000')
    .text('Particulars', LEFT + pad, y + pad, { width: LABEL_W - pad * 2 })
    .text('Details', LEFT + LABEL_W + pad, y + pad, { width: VALUE_W - pad * 2 });
  y += headerH;

  rows.forEach(([label, value], i) => {
    const h = heights[i]!;
    doc.rect(LEFT, y, LABEL_W, h).lineWidth(0.6).strokeColor('#000').stroke();
    doc.rect(LEFT + LABEL_W, y, VALUE_W, h).lineWidth(0.6).strokeColor('#000').stroke();
    doc.font('Helvetica').fontSize(BODY).fillColor('#000')
      .text(label, LEFT + pad, y + pad, { width: LABEL_W - pad * 2 });
    if (value) {
      doc.text(value, LEFT + LABEL_W + pad, y + pad, { width: VALUE_W - pad * 2 });
    }
    y += h;
  });
  return y;
}

export { fmtDay as _consentFmtDay, plainINR as _consentPlainINR, ratePct as _consentRatePct };
