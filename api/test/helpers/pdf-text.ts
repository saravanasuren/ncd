import { inflateSync } from 'node:zlib';

/**
 * The visible text of a PDFKit-generated PDF, with no external tools.
 *
 * `pdftotext` is not on the CI runner, so anything that shells out to it passes
 * locally and fails there. This reads the document directly.
 *
 * PDFKit deflates its content streams, so reading the raw bytes finds nothing —
 * and a `not.toContain` against those raw bytes PASSES for every string on
 * earth, which is how the first cut of the Aadhaar test passed while proving
 * nothing. Inflate every stream and pull the literals out of the text
 * operators, so both the positive and the negative assertions mean something.
 */
/**
 * PDFKit writes its standard fonts in WinAnsi, not Latin-1, and the two differ
 * over 0x80-0x9F — the range holding the smart punctuation this document is
 * full of. Decoding Latin-1 turns every ’ in "the Company's" into a control
 * character, so a search for "Company's" finds nothing and a search for
 * "Companys" finds nothing either: the assertion fails whichever way it is
 * written, and the obvious "fix" is to give up on the apostrophe. Translate the
 * range instead.
 */
const WINANSI_80_9F =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const fromWinAnsi = (s: string) =>
  s.replace(/[\u0080-\u009f]/g, (c) => WINANSI_80_9F[c.charCodeAt(0) - 0x80]!);

export function extractText(pdf: Buffer): string {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); }
    catch { continue; }
    // An embedded font inflates cleanly too, and its binary contains plenty of
    // parenthesised byte runs — harvesting those produced convincing garbage.
    // A CONTENT stream is the one with a BT/ET text block in it.
    if (!body.includes('BT')) continue;
    // PDFKit emits the text as HEX strings inside a TJ array —
    // [<48454c4c4f> 0] TJ — not as (literal) strings, which is why the obvious
    // paren-matching extraction reads an empty document. Handle both.
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = t[1]!.replace(/\s+/g, '');
      if (hex.length % 2) continue;
      out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const t of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      out.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    }
  }
  return fromWinAnsi(out.join(''));
}
