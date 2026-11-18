/**
 * NCD Redemption Request letter.
 *
 * This letter is written BY THE CUSTOMER, not by the company: it is addressed
 * "To, The Board of Directors", the body says "the NCD investment made by me in
 * your Company", and the investor signs at the foot. So there is no letterhead,
 * no logo and no CIN on it — the only company facts that appear are the name and
 * address of the addressee. Nothing here is a company document; we are
 * pre-filling a request for the holder to sign.
 *
 * Reproduced from the owner's two Word templates (Format Kiara.docx and
 * Format.docx, supplied 2026-11-18). The two differ ONLY in the addressee block
 * at the top — subject, body, table, bank block and sign-off are word for word
 * identical — so they are one layout here with a swappable addressee, and the
 * two cannot drift apart.
 *
 * The templates carry {{1}} {{2}} {{3}} in the body sentence; they are the
 * holder's name, the series and the amount, which are also three of the four
 * table columns.
 */
import { renderToBuffer } from './shared.js';
import type { AddresseeEra } from './redemption-letter-addressee.js';

export interface RedemptionLetterRow {
  /** ISO yyyy-mm-dd. Prints at the head and foot, and picks the addressee. */
  letter_date: string;
  holder_name: string;
  series: string;
  /** Printed as given — the template's "No. of Debentures" column. */
  debentures: string;
  amount: number;
  bank_name: string;
  account_holder_name: string;
  account_no: string;
  ifsc: string;
}

const PAGE_LEFT = 56;
const PAGE_RIGHT = 56;
const CONTENT_W = 595.28 - PAGE_LEFT - PAGE_RIGHT; // A4 width in points

/** "18-Aug-2025" — the form other Dhanam documents use. */
function letterDate(iso: string): string {
  const dt = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (isNaN(dt.getTime())) return String(iso);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}`;
}

/**
 * Indian digit grouping with no currency prefix: the template writes the "Rs."
 * and the trailing "/-" itself, so this returns only the figure. Whole rupees
 * stay whole — "10,00,000", not "10,00,000.00".
 */
export function plainINR(v: number): string {
  const n = Number(v);
  if (!isFinite(n)) return '';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** The 4-column details table, drawn with the same ruled cells as the Word original. */
function detailsTable(doc: PDFKit.PDFDocument, y: number, row: RedemptionLetterRow): number {
  const headers = ['Name of the NCD Holder', 'No. of Debentures', 'Amount (in Rs.)', 'NCD Series'];
  const values = [row.holder_name, row.debentures, plainINR(row.amount), row.series];
  // The holder's name needs the room; the three short columns share the rest.
  const widths = [CONTENT_W * 0.37, CONTENT_W * 0.21, CONTENT_W * 0.21, CONTENT_W * 0.21];
  const pad = 5;

  const rowHeight = (cells: string[], font: string) => {
    doc.font(font).fontSize(10);
    let tallest = 0;
    cells.forEach((text, i) => {
      const h = doc.heightOfString(text || ' ', { width: widths[i]! - pad * 2 });
      if (h > tallest) tallest = h;
    });
    return tallest + pad * 2;
  };

  const draw = (cells: string[], font: string, top: number): number => {
    const h = rowHeight(cells, font);
    let x = PAGE_LEFT;
    doc.font(font).fontSize(10).fillColor('#000');
    cells.forEach((text, i) => {
      const w = widths[i]!;
      doc.rect(x, top, w, h).lineWidth(0.75).strokeColor('#000').stroke();
      doc.text(text || ' ', x + pad, top + pad, { width: w - pad * 2 });
      x += w;
    });
    return top + h;
  };

  let yy = draw(headers, 'Helvetica-Bold', y);
  yy = draw(values, 'Helvetica', yy);
  return yy;
}

/** Build the redemption request letter for one row. */
export function redemptionLetterPdf(row: RedemptionLetterRow, era: AddresseeEra): Promise<Buffer> {
  return renderToBuffer((doc) => {
    doc.fontSize(11).fillColor('#000');
    let y = 48;

    // ── Date (head) ──────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').text('Date:', PAGE_LEFT, y, { continued: true })
      .font('Helvetica').text(` ${letterDate(row.letter_date)}`);
    y = doc.y + 16;

    // ── Addressee ────────────────────────────────────────────────────────────
    const line = (text: string, font = 'Helvetica') => {
      doc.font(font).fontSize(11).text(text, PAGE_LEFT, y, { width: CONTENT_W });
      y = doc.y;
    };
    line('To,');
    line('The Board of Directors,');
    line(`${era.legal_name},`);
    if (era.formerly) line(`(${era.formerly})`);
    // "Off Address -" is bold in both templates; the street that follows is not.
    doc.font('Helvetica-Bold').text('Off Address -', PAGE_LEFT, y, { continued: true })
      .font('Helvetica').text(` ${era.off_address_line1}`);
    y = doc.y;
    for (const l of era.off_address_rest) line(l);
    if (era.corp_office.length) {
      doc.font('Helvetica-Bold').text('Corp Office:', PAGE_LEFT, y, { continued: true })
        .font('Helvetica').text(` ${era.corp_office[0]}`);
      y = doc.y;
      for (const l of era.corp_office.slice(1)) line(l);
    }

    y += 22;

    // ── Subject (bold, justified in the original) ────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).text(
      'Subject: - Request for Redemption of NCD investment made by me in your Company.',
      PAGE_LEFT, y, { width: CONTENT_W, align: 'justify' });
    y = doc.y + 14;

    line('Dear Sir/Madam,');
    y += 12;

    // ── Body. The emphasis follows the template: "Series", and "Rs.<amt>/-". ─
    doc.font('Helvetica').fontSize(11)
      .text('This is to bring to your kind attention that I am ', PAGE_LEFT, y, {
        width: CONTENT_W, align: 'justify', continued: true,
      })
      .text(row.holder_name, { continued: true })
      .text(', NCD holder in your Company at the time of NCD ', { continued: true })
      .text(row.series, { continued: true })
      // A continued fragment that BEGINS with a space loses it — pdfkit's
      // wordwrapper eats it at the join, which ran "Series" into "Issue". A
      // space of its own survives, so every gap across a font change is one.
      .text(' ', { continued: true })
      .font('Helvetica-Bold').text('Series', { continued: true })
      .font('Helvetica').text(' ', { continued: true })
      .text(
        'Issue, Non-Convertible Debentures was allotted under above mentioned series.'
        + ' I kindly request you to redeem the NCD investment made by me in your Company for ',
        { continued: true })
      .font('Helvetica-Bold').text(`Rs.${plainINR(row.amount)}/-`, { continued: true })
      .font('Helvetica').text('( NCD) under the aforementioned Series of NCDs.', { continued: false });
    y = doc.y + 12;

    doc.font('Helvetica').fontSize(11).text(
      'Due to personal reasons, I am in urgent need of money and thus want my invested money back'
      + ' as early as possible. I would be very grateful to you if you could do the needful at the'
      + ' earliest. The details are as follows: -',
      PAGE_LEFT, y, { width: CONTENT_W, align: 'justify' });
    y = doc.y + 14;

    y = detailsTable(doc, y, row) + 20;

    // ── Bank block ───────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(11).text(
      'Kindly Process the Redemption Request and Credit the Proceeds to the following Bank Account',
      PAGE_LEFT, y, { width: CONTENT_W, align: 'justify' });
    y = doc.y + 8;
    for (const [label, value] of [
      ['Bank Name', row.bank_name],
      ['Account Holder Name', row.account_holder_name],
      ['Account No.', row.account_no],
      ['IFSC Code', row.ifsc],
    ] as const) {
      doc.font('Helvetica').fontSize(11).text(`${label} – ${value}`, PAGE_LEFT, y, { width: CONTENT_W });
      y = doc.y;
    }

    y += 18;
    line('Thanking You');
    y += 14;
    line('Yours faithfully,');

    // Room for the holder's pen, then the signature line and the second date.
    y += 64;
    line('Signature');
    y += 14;
    doc.font('Helvetica-Bold').text('Date:', PAGE_LEFT, y, { continued: true })
      .font('Helvetica').text(` ${letterDate(row.letter_date)}`);
  });
}
