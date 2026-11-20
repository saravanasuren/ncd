/**
 * Bulk redemption letters — the parts that decide what a signed document says.
 *
 * Two of these matter more than the rest. Which company the letter is addressed
 * to is read off the letter's own date, so a boundary that is off by a day
 * names the wrong company on a legal document. And a typed date is ambiguous:
 * 08/09/2025 is 8 September in India and 9 August in America, and the two fall
 * on opposite sides of a boundary often enough to matter.
 */
import { describe, it, expect } from 'vitest';
import {
  addresseeFor, eras, DEFAULT_DHANAM_FROM,
} from '../src/modules/reports/forms/redemption-letter-addressee.js';
import { redemptionLetterPdf, plainINR } from '../src/modules/reports/forms/redemption-letter.js';
import { parseDateCell, parseAmount, displayDate, IFSC_RE, parseUpload } from '../src/modules/bulk-letters/parse.js';
import { makeZip, crc32, safeFilename } from '../src/modules/bulk-letters/zip.js';
import ExcelJS from 'exceljs';

const KIARA = 'Kiara Microcredit Private Limited';
const DHANAM_PVT = 'Dhanam Investment and Finance Private Limited';
const DHANAM_LTD = 'Dhanam Investment and Finance Limited';

describe('which company the letter is addressed to', () => {
  it('names Kiara up to and including 17 August 2025', () => {
    expect(addresseeFor('2024-01-01').legal_name).toBe(KIARA);
    expect(addresseeFor('2025-08-17').legal_name).toBe(KIARA);
  });

  it('names Dhanam from 18 August 2025 — the boundary day belongs to Dhanam', () => {
    expect(addresseeFor('2025-08-18').legal_name).toBe(DHANAM_PVT);
    expect(addresseeFor('2025-08-19').legal_name).toBe(DHANAM_PVT);
  });

  it('drops "Private" from 29 September 2026, the day the company was renamed', () => {
    expect(addresseeFor('2026-09-28').legal_name).toBe(DHANAM_PVT);
    expect(addresseeFor('2026-09-29').legal_name).toBe(DHANAM_LTD);
    expect(addresseeFor('2026-11-18').legal_name).toBe(DHANAM_LTD);
  });

  it('follows a moved boundary, because it is a setting', () => {
    // The owner can shift the Kiara/Dhanam line without a release.
    expect(addresseeFor('2025-06-01', '2025-01-01').legal_name).toBe(DHANAM_PVT);
    expect(addresseeFor('2025-10-01', '2025-12-31').legal_name).toBe(KIARA);
  });

  it('only the Dhanam letters carry the "formerly" line and a corp office', () => {
    const kiara = addresseeFor('2025-01-01');
    expect(kiara.formerly).toBeUndefined();
    expect(kiara.corp_office).toHaveLength(0);

    const dhanam = addresseeFor('2026-01-01');
    expect(dhanam.formerly).toContain('Kiara');
    expect(dhanam.corp_office.length).toBeGreaterThan(0);
  });

  it('both letters give the same street number — the owner settled 22/3', () => {
    // The supplied templates disagreed: Kiara said 22/2, Dhanam 22/3.
    for (const date of ['2025-01-01', '2026-01-01', '2026-11-18']) {
      expect(addresseeFor(date).off_address_line1).toContain('22/3');
      expect(addresseeFor(date).off_address_line1).not.toContain('22/2');
    }
  });

  it('spells the corp office correctly, with the template typos corrected', () => {
    const corp = addresseeFor('2026-11-18').corp_office.join(' ');
    expect(corp).toContain('Chinniyampalayam');
    expect(corp).not.toContain('Chinntyampalayam');
    // The template ran commas straight into the next word.
    expect(corp).not.toMatch(/,\S/);
  });

  it('says the city and the pincode once each, and loses no part of the address', () => {
    // The template repeated both; the owner asked for it trimmed (2026-11-18).
    const corp = addresseeFor('2026-11-18').corp_office.join(' ');
    expect(corp.match(/641062/g)).toHaveLength(1);
    expect(corp.match(/Coimbatore/g)).toHaveLength(1);
    for (const part of ['2/191 B.', 'Mylampatty Road', 'Karayampalayam',
      'Mylampatty Post', 'Chinniyampalayam', 'Coimbatore South', 'Tamil Nadu', 'India']) {
      expect(corp, `should still name ${part}`).toContain(part);
    }
  });

  it('every era is reachable and they run oldest first', () => {
    const list = eras(DEFAULT_DHANAM_FROM);
    expect(list.map((e) => e.legal_name)).toEqual([KIARA, DHANAM_PVT, DHANAM_LTD]);
    expect(list[0]!.from).toBeNull();
  });
});

describe('reading a date out of a cell', () => {
  it('takes a real Excel date exactly as it stands', () => {
    expect(parseDateCell(new Date(Date.UTC(2025, 7, 18)))).toBe('2025-08-18');
  });

  it('reads a typed d/m/y DAY first, as India writes it', () => {
    // The whole point: 08/09/2025 is 8 September, and would otherwise land in
    // August — on the far side of the Kiara boundary.
    expect(parseDateCell('08/09/2025')).toBe('2025-09-08');
    expect(parseDateCell('17/08/2025')).toBe('2025-08-17');
    expect(parseDateCell('18-08-2025')).toBe('2025-08-18');
  });

  it('reads an unambiguous form whichever way it is written', () => {
    expect(parseDateCell('2025-08-18')).toBe('2025-08-18');
    expect(parseDateCell('18-Aug-2025')).toBe('2025-08-18');
    expect(parseDateCell('18 August 2025')).toBe('2025-08-18');
    expect(parseDateCell('1-Sep-25')).toBe('2025-09-01');
  });

  it('reads an Excel serial number', () => {
    // 45887 is 18 Aug 2025 in Excel's 1900 system.
    expect(parseDateCell(45887)).toBe('2025-08-18');
  });

  it('refuses a date that does not exist, rather than rolling it over', () => {
    expect(parseDateCell('31/02/2025')).toBe('');
    expect(parseDateCell('32/01/2025')).toBe('');
    expect(parseDateCell('18/13/2025')).toBe('');
    expect(parseDateCell('not a date')).toBe('');
    expect(parseDateCell(null)).toBe('');
  });

  it('echoes a parsed date back unambiguously for the operator to check', () => {
    expect(displayDate('2025-09-08')).toBe('08-Sep-2025');
  });
});

describe('reading an amount', () => {
  it('accepts the ways money gets typed', () => {
    expect(parseAmount(1000000)).toBe(1000000);
    expect(parseAmount('10,00,000')).toBe(1000000);
    expect(parseAmount('Rs.10,00,000/-')).toBe(1000000);
    expect(parseAmount('₹ 1000000')).toBe(1000000);
    expect(parseAmount('1000000.50')).toBe(1000000.5);
  });
  it('rejects what is not a number', () => {
    expect(parseAmount('ten lakh')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('IFSC shape', () => {
  it('accepts a real one and rejects the near misses', () => {
    expect(IFSC_RE.test('SBIN0000123')).toBe(true);
    expect(IFSC_RE.test('HDFC0CAGSBK')).toBe(true);
    expect(IFSC_RE.test('SBIN1000123')).toBe(false); // 5th char must be 0
    expect(IFSC_RE.test('SBI00000123')).toBe(false); // 3-letter bank code
    expect(IFSC_RE.test('SBIN000012')).toBe(false);  // too short
  });
});

const CANONICAL = [
  'Letter Date', 'Name of the NCD Holder', 'NCD Series', 'No. of Debentures',
  'Amount (in Rs.)', 'Bank Name', 'Account Holder Name', 'Account No.', 'IFSC Code', 'Customer Code',
];

/**
 * Build a workbook in memory so the parser is exercised the way it runs.
 *
 * `rows` are always keyed by the CANONICAL header names; `headers` only changes
 * the text written on the header line, so a test can spell the headers
 * differently without having to re-key its data.
 */
async function sheet(rows: Record<string, unknown>[], headers?: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  const written = headers ?? CANONICAL;
  ws.addRow(written);
  // Only the columns this sheet actually has, in the order it has them.
  const keys = CANONICAL.slice(0, written.length);
  for (const r of rows) ws.addRow(keys.map((k) => r[k] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const GOOD = {
  'Letter Date': new Date(Date.UTC(2026, 9, 27)),
  'Name of the NCD Holder': 'Sundaramam K S',
  'NCD Series': '29',
  'No. of Debentures': 10,
  'Amount (in Rs.)': 1000000,
  'Bank Name': 'State Bank of India',
  'Account Holder Name': 'Sundaramam K S',
  'Account No.': '30012345678',
  'IFSC Code': 'SBIN0000123',
};

describe('checking an uploaded sheet', () => {
  it('passes a complete row', async () => {
    const { rows, header_errors } = await parseUpload(await sheet([GOOD]), 'x.xlsx');
    expect(header_errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.letter_date).toBe('2026-10-27');
  });

  it('reports the SPREADSHEET row number, so the operator can find it', async () => {
    const { rows } = await parseUpload(await sheet([GOOD, { ...GOOD, 'IFSC Code': 'nope' }]), 'x.xlsx');
    // Header is row 1, so the second record is row 3.
    expect(rows[1]!.row_no).toBe(3);
    expect(rows[1]!.errors.join(' ')).toMatch(/IFSC/);
  });

  it('names every missing field at once rather than stopping at the first', async () => {
    const { rows } = await parseUpload(await sheet([{ 'Letter Date': new Date(Date.UTC(2026, 0, 1)) }]), 'x.xlsx');
    const joined = rows[0]!.errors.join(' | ');
    for (const field of ['Name of the NCD Holder', 'NCD Series', 'No. of Debentures',
      'Amount (in Rs.)', 'Bank Name', 'Account Holder Name', 'Account No.', 'IFSC Code']) {
      expect(joined, `should mention ${field}`).toContain(field);
    }
  });

  it('refuses a part-debenture and a zero amount', async () => {
    const { rows } = await parseUpload(await sheet([
      { ...GOOD, 'No. of Debentures': 2.5 },
      { ...GOOD, 'Amount (in Rs.)': 0 },
    ]), 'x.xlsx');
    expect(rows[0]!.errors.join(' ')).toMatch(/whole number/);
    expect(rows[1]!.errors.join(' ')).toMatch(/above zero/);
  });

  it('warns when the series repeats the word NCD, which would print twice', async () => {
    // The sentence already reads "at the time of NCD <series> Series Issue".
    const { rows } = await parseUpload(await sheet([{ ...GOOD, 'NCD Series': 'NCD 29' }]), 'x.xlsx');
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.cautions.join(' ')).toMatch(/NCD NCD 29 Series/);
  });

  it('cautions — but does not block — when the account is in another name', async () => {
    const { rows } = await parseUpload(
      await sheet([{ ...GOOD, 'Account Holder Name': 'Someone Else' }]), 'x.xlsx');
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.cautions.join(' ')).toMatch(/differs from the NCD holder/);
  });

  it('says which column is missing instead of failing obscurely', async () => {
    const { header_errors } = await parseUpload(
      await sheet([], ['Letter Date', 'Name of the NCD Holder']), 'x.xlsx');
    expect(header_errors.join(' ')).toContain('NCD Series');
  });

  it('matches headers whatever the case and spacing', async () => {
    const cols = ['letter date', 'NAME OF THE NCD HOLDER', 'ncd  series', 'No of Debentures',
      'amount (in rs)', 'bank name', 'account holder name', 'account no', 'ifsc code', 'customer code'];
    const { header_errors, rows } = await parseUpload(await sheet([GOOD], cols), 'x.xlsx');
    expect(header_errors).toEqual([]);
    expect(rows[0]!.errors).toEqual([]);
  });

  it('ignores blank rows rather than calling them errors', async () => {
    const { rows } = await parseUpload(await sheet([GOOD, {}, GOOD]), 'x.xlsx');
    expect(rows).toHaveLength(2);
  });

  it('reads a CSV as well as a workbook', async () => {
    const csv = Buffer.from(
      'Letter Date,Name of the NCD Holder,NCD Series,No. of Debentures,Amount (in Rs.),'
      + 'Bank Name,Account Holder Name,Account No.,IFSC Code,Customer Code\n'
      + '27/10/2026,"Sundaramam K S",29,10,1000000,State Bank of India,"Sundaramam K S",30012345678,SBIN0000123,\n');
    const { rows, header_errors } = await parseUpload(csv, 'x.csv');
    expect(header_errors).toEqual([]);
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.letter_date).toBe('2026-10-27');
  });
});

describe('the letter itself', () => {
  const row = {
    letter_date: '2026-10-27', holder_name: 'Sundaramam K S', series: '29',
    debentures: '10', amount: 1000000, bank_name: 'State Bank of India',
    account_holder_name: 'Sundaramam K S', account_no: '30012345678', ifsc: 'SBIN0000123',
  };

  it('renders a one-page PDF', async () => {
    const pdf = await redemptionLetterPdf(row, addresseeFor(row.letter_date));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('uses bold as the template does — both fonts are in the file', async () => {
    const pdf = await redemptionLetterPdf(row, addresseeFor(row.letter_date));
    const s = pdf.toString('latin1');
    expect(s).toContain('/Helvetica-Bold');
    expect(s).toContain('/BaseFont /Helvetica');
  });

  it('writes money the Indian way, with no currency word of its own', () => {
    // The template supplies "Rs." and "/-" around the figure.
    expect(plainINR(1000000)).toBe('10,00,000');
    expect(plainINR(2500000)).toBe('25,00,000');
    expect(plainINR(1234.5)).toBe('1,234.50');
  });
});

describe('the zip bundle', () => {
  it('is a real archive with the file stored whole', () => {
    const data = Buffer.from('%PDF-1.3 pretend');
    const zip = makeZip([{ name: 'a.pdf', data }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);            // local header
    expect(zip.subarray(zip.length - 22).readUInt32LE(0)).toBe(0x06054b50); // end record
    expect(zip.readUInt16LE(8)).toBe(0);                     // method 0 = stored
    // Stored means the bytes are in there untouched.
    expect(zip.includes(data)).toBe(true);
  });

  it('counts its entries', () => {
    const zip = makeZip([
      { name: 'a.pdf', data: Buffer.from('a') },
      { name: 'b.pdf', data: Buffer.from('b') },
      { name: 'c.pdf', data: Buffer.from('c') },
    ]);
    const end = zip.subarray(zip.length - 22);
    expect(end.readUInt16LE(8)).toBe(3);
    expect(end.readUInt16LE(10)).toBe(3);
  });

  it('keeps both letters when two customers share a name', () => {
    // Otherwise one of the two is lost on unpacking.
    const zip = makeZip([
      { name: 'Ravi Kumar - 01-Jan-2026.pdf', data: Buffer.from('first') },
      { name: 'Ravi Kumar - 01-Jan-2026.pdf', data: Buffer.from('second') },
    ]);
    const s = zip.toString('latin1');
    expect(s).toContain('Ravi Kumar - 01-Jan-2026.pdf');
    expect(s).toContain('Ravi Kumar - 01-Jan-2026 (2).pdf');
    expect(zip.includes(Buffer.from('first'))).toBe(true);
    expect(zip.includes(Buffer.from('second'))).toBe(true);
  });

  it('computes the CRC the zip format expects', () => {
    // The standard check value for "123456789".
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('makes a filename safe on every platform', () => {
    expect(safeFilename('A/B:C*D?"<>|')).not.toMatch(/[\\/:*?"<>|]/);
    expect(safeFilename('   ')).toBe('letter');
    expect(safeFilename('..hidden')).toBe('hidden');
    expect(safeFilename('trailing.')).toBe('trailing');
  });
});

// ── The 2% premium waiver (owner 2026-11-20) ────────────────────────────────
//
// A clause where the holder signs away a payment right, so these tests hold it
// to the owner's wording character for character. Fixture names are neutral and
// word-only: assertions below search the rendered text for "Waiver", "premium"
// and "Thanking You", and a customer called "Premium Holder" would satisfy one
// of those searches without the clause being on the page at all.
const waiverRow = (holder = 'Holder Alpha', date = '2026-11-20') => ({
  letter_date: date,
  holder_name: holder,
  series: 'NCD 27',
  debentures: '5',
  amount: 500000,
  bank_name: 'Indian Overseas Bank',
  account_holder_name: holder,
  account_no: '005301000012345',
  ifsc: 'IOBA0000534',
});

/** Pages in a PDFKit document — /Type /Page, not /Pages. */
const pageCount = (b: Buffer) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

describe('the 2% additional premium waiver', () => {
  it('prints the heading and the clause, in the owner\'s words', async () => {
    const { extractText } = await import('./helpers/pdf-text.js');
    const t = extractText(await redemptionLetterPdf(waiverRow(), addresseeFor('2026-11-20')));
    // The clause is JUSTIFIED, and pdfkit spaces justified text by positioning
    // rather than by emitting space characters — so the extractor recovers the
    // letters but not the gaps between words. Comparing with all whitespace
    // stripped from BOTH sides is the only assertion that means anything here;
    // normalising runs of spaces (the obvious first attempt) fails against text
    // that has no spaces left in it at all.
    const squash = (x: string) => x.replace(/\s+/g, '');
    const flat = squash(t);
    // The heading is not justified, so it keeps its spaces and is checked as-is.
    expect(t.replace(/\s+/g, ' ')).toContain('Waiver of 2% additional premium.');
    expect(flat).toContain(squash(
      'I understand that the Debenture Trust Deed provides for an additional premium of 2% (two per cent)'
      + ' on premature redemption.'));
    expect(flat).toContain(squash(
      'I hereby voluntarily and irrevocably waive my right to receive this 2% additional premium,'
      + ' and any other prepayment premium, penalty or charge payable on premature redemption.'));
  });

  it('sits below the bank details and above the sign-off, where the owner put it', async () => {
    const { extractText } = await import('./helpers/pdf-text.js');
    const t = extractText(await redemptionLetterPdf(waiverRow(), addresseeFor('2026-11-20')));
    const ifsc = t.indexOf('IFSC Code');
    const waiver = t.indexOf('Waiver of 2% additional premium');
    const thanks = t.indexOf('Thanking You');
    expect(ifsc).toBeGreaterThan(-1);
    expect(waiver).toBeGreaterThan(ifsc);
    expect(thanks).toBeGreaterThan(waiver);
  });

  it('is on EVERY letter, whatever its date — the owner\'s answer on back-dated ones', async () => {
    const { extractText } = await import('./helpers/pdf-text.js');
    // One date in each of the three addressee eras.
    for (const [date, company] of [
      ['2024-05-06', KIARA],
      ['2026-01-10', DHANAM_PVT],
      ['2026-11-20', DHANAM_LTD],
    ] as const) {
      const t = extractText(await redemptionLetterPdf(waiverRow('Holder Beta', date), addresseeFor(date)));
      expect(t, `era ${company}`).toContain('Waiver of 2% additional premium');
      expect(t.replace(/\s+/g, ' '), `era ${company}`).toContain(company);
    }
  });

  it('still fits on one page, even for a holder whose name wraps', async () => {
    // The waiver cost roughly a signature-gap's worth of the page. Before the
    // gap was made to shrink, this exact name pushed the whole closing onto a
    // second page — a signature line, a date, and nothing else.
    for (const holder of [
      'Holder Alpha',
      'VENKATACHALAM GOVINDARAJ SUBRAMANIAN IYER',
      'SARATCHANDRAN PERIASAMY THANGAPANDIAN VENKATARAMAN',
    ]) {
      const pdf = await redemptionLetterPdf(waiverRow(holder), addresseeFor('2026-11-20'));
      expect(pageCount(pdf), `one page for ${holder}`).toBe(1);
    }
  });

  it('keeps the signature and its date together with the sign-off', async () => {
    const { extractText } = await import('./helpers/pdf-text.js');
    const t = extractText(await redemptionLetterPdf(
      waiverRow('SARATCHANDRAN PERIASAMY THANGAPANDIAN VENKATARAMAN'), addresseeFor('2026-11-20')));
    const thanks = t.indexOf('Thanking You');
    const faithfully = t.indexOf('Yours faithfully');
    const signature = t.indexOf('Signature');
    expect(faithfully).toBeGreaterThan(thanks);
    expect(signature).toBeGreaterThan(faithfully);
  });
});
