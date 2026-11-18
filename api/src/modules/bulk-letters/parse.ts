/**
 * Reader and validator for the bulk redemption-letter upload.
 *
 * The uploaded sheet is the ONLY source of truth for what prints: this tool
 * does not read the book, does not initiate a redemption and changes nothing
 * (owner 2026-11-18). A customer code may be given, and if it is we look it up
 * only to raise a CAUTION next to the row — never to overrule the sheet.
 *
 * Row numbers reported to the operator are SPREADSHEET rows, so the header is
 * row 1 and the first record is row 2. Anything else means hunting for the row
 * they were told about.
 */
import ExcelJS from 'exceljs';

/** The template's column headers, in order. */
export const COLUMNS = [
  'Letter Date',
  'Name of the NCD Holder',
  'NCD Series',
  'No. of Debentures',
  'Amount (in Rs.)',
  'Bank Name',
  'Account Holder Name',
  'Account No.',
  'IFSC Code',
  'Customer Code',
] as const;

/** Customer Code is the only optional column — it is used for cross-checking. */
export const OPTIONAL_COLUMNS: ReadonlySet<string> = new Set(['Customer Code']);

export interface ParsedRow {
  row_no: number;
  letter_date: string;        // ISO yyyy-mm-dd ('' when unusable)
  letter_date_display: string; // unambiguous echo for the preview
  holder_name: string;
  series: string;
  debentures: string;
  amount: number;
  bank_name: string;
  account_holder_name: string;
  account_no: string;
  ifsc: string;
  customer_code: string;
  errors: string[];
  cautions: string[];
}

export interface ParsedUpload {
  rows: ParsedRow[];
  /** Headers we could not match, and required ones that were absent. */
  header_errors: string[];
}

const isZip = (buf: Buffer): boolean =>
  buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/** Normalise a header for matching: case, spaces and punctuation are ignored. */
const normHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

type Cell = string | number | Date | null;

/** File bytes → a matrix of raw cell values, dates kept as Dates. */
async function toMatrix(buf: Buffer, filename: string): Promise<Cell[][]> {
  if (isZip(buf) || /\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const out: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: Cell[] = [];
      for (let c = 1; c <= (row.cellCount || 0); c++) {
        const v = row.getCell(c).value as unknown;
        if (v == null) cells.push(null);
        else if (v instanceof Date) cells.push(v);
        else if (typeof v === 'number') cells.push(v);
        else if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
          cells.push(String((v as { text: unknown }).text));
        } else if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
          // A formula cell: take its computed result.
          cells.push(String((v as { result: unknown }).result ?? ''));
        } else cells.push(String(v));
      }
      out.push(cells);
    });
    return out;
  }
  // CSV fallback.
  const text = buf.toString('utf8').replace(/\r\n?/g, '\n');
  return text.split('\n').map((l) => splitCsv(l));
}

/** Minimal CSV split honouring double quotes. */
function splitCsv(line: string): Cell[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const realDate = (y: number, m: number, d: number): boolean => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * A cell → ISO date.
 *
 * A real Excel date cell arrives as a Date and is unambiguous. TYPED text is
 * not: in India "08/09/2025" means 8 September, so a numeric d/m/y string is
 * read DAY FIRST. The preview echoes every date back as "08-Sep-2025" so the
 * operator can see which way it was read before anything is generated — the
 * date decides which company the letter is addressed to, so a silent
 * misreading would put the wrong company on a signed document.
 */
export function parseDateCell(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) {
    return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number') {
    // Excel serial: day 1 is 1900-01-01, with the sheet's 1900 leap-year bug.
    if (!isFinite(v) || v < 1 || v > 80000) return '';
    const ms = Math.round((v - 25569) * 86400000);
    const dt = new Date(ms);
    if (isNaN(dt.getTime())) return '';
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v).trim();
  if (!s) return '';

  // yyyy-mm-dd / yyyy/mm/dd — unambiguous, year first.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return realDate(y, mo, d) ? iso(y, mo, d) : '';
  }
  // dd-mmm-yyyy / 18 Aug 2025 — unambiguous, named month.
  m = /^(\d{1,2})[-/ .]([A-Za-z]{3,9})[-/ .](\d{2,4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase().slice(0, 4)] ?? MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    if (!mo) return '';
    const d = Number(m[1]);
    let y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return realDate(y, mo, d) ? iso(y, mo, d) : '';
  }
  // dd/mm/yyyy — DAY FIRST (Indian convention).
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return realDate(y, mo, d) ? iso(y, mo, d) : '';
  }
  return '';
}

/** "18-Aug-2025" for echoing a parsed date back unambiguously. */
export function displayDate(isoDate: string): string {
  if (!isoDate) return '';
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(dt.getTime())) return '';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}`;
}

const text = (v: Cell): string => {
  if (v == null) return '';
  if (v instanceof Date) return displayDate(iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()));
  return String(v).trim();
};

/** Money/count cell → number. Rupee signs, commas and stray spaces are tolerated. */
export function parseAmount(v: Cell): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const s = String(v).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '').replace(/\/-$/, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Validate and normalise one record. */
function buildRow(rowNo: number, get: (col: string) => Cell): ParsedRow {
  const errors: string[] = [];
  const cautions: string[] = [];

  const rawDate = get('Letter Date');
  const letterDate = parseDateCell(rawDate);
  if (!text(rawDate)) errors.push('Letter Date is missing');
  else if (!letterDate) {
    errors.push(`Letter Date "${text(rawDate)}" is not a date we can read — use dd/mm/yyyy or 18-Aug-2025`);
  } else {
    const year = Number(letterDate.slice(0, 4));
    if (year < 2010 || year > new Date().getUTCFullYear() + 1) {
      errors.push(`Letter Date ${displayDate(letterDate)} looks wrong — check the year`);
    }
  }

  const holder = text(get('Name of the NCD Holder'));
  if (!holder) errors.push('Name of the NCD Holder is missing');
  else if (holder.length < 2) errors.push(`Name of the NCD Holder "${holder}" is too short`);

  const series = text(get('NCD Series'));
  if (!series) errors.push('NCD Series is missing');
  // The template's sentence already reads "at the time of NCD <series> Series
  // Issue", so a value that repeats the word prints "NCD NCD 29 Series".
  else if (/^ncd\b/i.test(series)) {
    cautions.push(`NCD Series "${series}" will read "NCD ${series} Series" — the letter says NCD already`);
  }

  const debRaw = get('No. of Debentures');
  const deb = parseAmount(debRaw);
  if (!text(debRaw)) errors.push('No. of Debentures is missing');
  else if (deb === null) errors.push(`No. of Debentures "${text(debRaw)}" is not a number`);
  else if (deb <= 0 || !Number.isInteger(deb)) {
    errors.push(`No. of Debentures must be a whole number above zero, not "${text(debRaw)}"`);
  }

  const amtRaw = get('Amount (in Rs.)');
  const amount = parseAmount(amtRaw);
  if (!text(amtRaw)) errors.push('Amount (in Rs.) is missing');
  else if (amount === null) errors.push(`Amount (in Rs.) "${text(amtRaw)}" is not a number`);
  else if (amount <= 0) errors.push(`Amount (in Rs.) must be above zero, not "${text(amtRaw)}"`);

  const bankName = text(get('Bank Name'));
  if (!bankName) errors.push('Bank Name is missing');
  const accHolder = text(get('Account Holder Name'));
  if (!accHolder) errors.push('Account Holder Name is missing');

  const accNo = text(get('Account No.')).replace(/\s/g, '');
  if (!accNo) errors.push('Account No. is missing');
  else if (!/^\d{5,20}$/.test(accNo)) {
    errors.push(`Account No. "${accNo}" should be 5 to 20 digits`);
  }

  const ifscRaw = text(get('IFSC Code'));
  const ifsc = ifscRaw.toUpperCase().replace(/\s/g, '');
  if (!ifsc) errors.push('IFSC Code is missing');
  else if (!IFSC_RE.test(ifsc)) {
    errors.push(`IFSC Code "${ifscRaw}" is not a valid IFSC — it is 4 letters, a zero, then 6 characters`);
  }

  // The letter says "credit the proceeds to", so a name mismatch here is worth
  // a glance but is legitimate often enough (joint accounts, maiden names) that
  // it must not block the letter.
  if (holder && accHolder && holder.toLowerCase() !== accHolder.toLowerCase()) {
    cautions.push('Account Holder Name differs from the NCD holder');
  }

  return {
    row_no: rowNo,
    letter_date: letterDate,
    letter_date_display: displayDate(letterDate),
    holder_name: holder,
    series,
    debentures: deb !== null ? String(deb) : text(debRaw),
    amount: amount ?? 0,
    bank_name: bankName,
    account_holder_name: accHolder,
    account_no: accNo,
    ifsc,
    customer_code: text(get('Customer Code')).toUpperCase(),
    errors,
    cautions,
  };
}

/** Parse an uploaded sheet into validated rows. */
export async function parseUpload(buf: Buffer, filename: string): Promise<ParsedUpload> {
  const matrix = await toMatrix(buf, filename);
  const headerErrors: string[] = [];

  // The header is the first row with any content.
  const headerIdx = matrix.findIndex((r) => r.some((c) => text(c) !== ''));
  if (headerIdx === -1) return { rows: [], header_errors: ['The file has no rows in it'] };

  const header = matrix[headerIdx]!.map((c) => normHeader(text(c)));
  const colIndex = new Map<string, number>();
  for (const col of COLUMNS) {
    const i = header.indexOf(normHeader(col));
    if (i >= 0) colIndex.set(col, i);
    else if (!OPTIONAL_COLUMNS.has(col)) headerErrors.push(`Column "${col}" is missing from the file`);
  }
  if (headerErrors.length) return { rows: [], header_errors: headerErrors };

  const rows: ParsedRow[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r]!;
    // Skip blank rows outright — a trailing empty row is not an error.
    if (!cells.some((c) => text(c) !== '')) continue;
    const get = (col: string): Cell => {
      const i = colIndex.get(col);
      return i === undefined ? null : (cells[i] ?? null);
    };
    rows.push(buildRow(r + 1, get)); // +1: spreadsheet rows are 1-based
  }
  if (!rows.length) headerErrors.push('The file has a header but no records under it');
  return { rows, header_errors: headerErrors };
}
