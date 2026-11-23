/**
 * Bulk Redemption Letter generation.
 *
 * A document tool and nothing more (owner 2026-11-18): it reads an uploaded
 * sheet, renders one redemption-request letter per row and hands them back. It
 * does not create a redemption, does not touch an application or a customer,
 * writes no document to storage and raises no approval. Nothing it does is
 * visible anywhere else in the system afterwards.
 *
 * Which company the letter is addressed to comes from the letter's own date —
 * see redemption-letter-addressee.ts. The boundary is a setting so the owner can
 * move it without a release.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { getSettingsMap } from '../settings/service.js';
import { redemptionLetterPdf, type RedemptionLetterRow } from '../reports/forms/redemption-letter.js';
import { consentLetterPdf, type ConsentLetterRow } from '../reports/forms/consent-letter.js';
import { consentLetterFrom } from '../redemptions/letter.js';
import {
  addresseeFor, DEFAULT_DHANAM_FROM, type AddresseeEra,
} from '../reports/forms/redemption-letter-addressee.js';
import { COLUMNS, parseUpload, type ParsedRow } from './parse.js';
import { listTemplates, pickFor, blockOf, type LetterTemplate } from '../letters/service.js';
import { makeZip, safeFilename, type ZipEntry } from './zip.js';

/** A sheet big enough to be a mistake rather than a batch. */
const MAX_ROWS = 2000;

export interface PreviewRow extends ParsedRow {
  /** Company this row's letter will be addressed to, from its date. */
  addressed_to: string;
  filename: string;
  /** Which document this row produces, decided by its date against the
   *  consent cut-off. 'request' is the letter this tool has always made. */
  letter_kind: 'request' | 'consent';
  /** Consent particulars that will print empty — neither typed nor found. */
  blank_particulars: string[];
}

export interface PreviewResult {
  rows: PreviewRow[];
  header_errors: string[];
  summary: {
    total: number;
    ready: number;
    with_errors: number;
    with_cautions: number;
    total_amount: number;
    /** How many letters go to each company, so a wrong date column is obvious. */
    by_company: { company: string; count: number }[];
  };
}

/**
 * The deep fallback boundary for the built-in era list.
 *
 * It was a setting until 2026-11-21; the Redemption Letters screen now owns
 * every boundary, and this is only reached when no configured range matches a
 * date at all. A constant is honest about that — a setting here would be read
 * by almost nothing and changed by somebody expecting it to matter.
 */
function dhanamFrom(): string {
  return DEFAULT_DHANAM_FROM;
}

/** "Ramanuja K - 27-Oct-2026.pdf" */
export function letterFilename(row: ParsedRow): string {
  const date = row.letter_date_display || 'no-date';
  return `${safeFilename(`${row.holder_name} - ${date}`, `row-${row.row_no}`)}.pdf`;
}

/**
 * Which document a row produces.
 *
 * The owner's rule (2026-11-21): a row dated on or after the consent cut-off
 * gets the Consent for Premature Redemption — the same document the live
 * redemption screen now produces — and an earlier row keeps the Request
 * letter exactly as before. INSTEAD OF, not as well as: asked, the owner chose
 * one letter per row, matching what a redemption raised in the system gets.
 *
 * A row whose date would not parse gets the Request letter, the same default
 * `decorate` uses for the addressee: it is the behaviour the file had before
 * this existed, and the row is already flagged for its unreadable date.
 */
export function letterKindFor(letterDate: string, consentFrom: string): 'request' | 'consent' {
  if (!letterDate) return 'request';
  return letterDate.slice(0, 10) >= consentFrom.slice(0, 10) ? 'consent' : 'request';
}

const toConsentRow = (r: ParsedRow, t?: LetterTemplate | null): ConsentLetterRow => ({
  letter_date: r.letter_date,
  addressee: t && t.legal_name ? blockOf(t) : null,
  holder_name: r.holder_name,
  pan: r.pan,
  series: r.series,
  allotment_date: r.allotment_date,
  rollover_date: r.rollover_date,
  original_maturity_date: r.original_maturity_date,
  // The number being redeemed, which is what the sheet's own column holds.
  ncd_count: r.debentures,
  // The sheet's "Face Value" column already carries the TOTAL — its sample
  // value is 500000, five NCDs' worth, not a 1,00,000 per-unit figure — so
  // only the field it feeds is renamed here, not what operators type.
  total_face_value: r.face_value,
  coupon_rate_pct: r.coupon_rate_pct,
  mode_of_holding: r.mode_of_holding,
  account_name: r.account_holder_name,
  account_no: r.account_no,
  bank_and_branch: r.bank_name,
  ifsc: r.ifsc,
});

/**
 * THE CUSTOMER RECORD IS NO LONGER READ (owner 2026-11-21).
 *
 * `fillConsentGaps` used to look up an empty particular from the book,
 * matched on customer code and series. It was removed, not disabled, and the
 * reason is the multi-series letter: a redemption covering NCD 22, 23 and 24
 * has three allotment dates, and the record only ever knows one investment.
 * The looked-up value therefore LOOKED right while being wrong — the worst
 * kind of wrong on a document somebody signs.
 *
 * Asked directly, the owner chose the sheet as the only source: "just take in
 * the datas from the excel and fill it in the approriate blanks". An empty
 * cell now prints an empty row for someone to complete by hand.
 *
 * `crossCheck` below STAYS. It only ever adds a note and never changes what
 * prints, and the owner asked for that name check specifically.
 */

/**
 * The configured block for a row, or the built-in era it has always used.
 *
 * A consent template carries a company NAME but no letterhead, so it never
 * supplies a block — a consent row does not print one.
 */
function eraFor(t: LetterTemplate | null, letterDate: string, from: string): AddresseeEra {
  if (t && t.kind === 'request' && t.legal_name && t.off_address.length) {
    const [first, ...rest] = t.off_address;
    return {
      from: t.valid_from,
      legal_name: t.legal_name,
      ...(t.formerly ? { formerly: t.formerly } : {}),
      off_address_line1: first ?? '',
      off_address_rest: rest,
      corp_office: t.corp_office,
    };
  }
  return addresseeFor(letterDate, from);
}

const toLetterRow = (r: ParsedRow): RedemptionLetterRow => ({
  letter_date: r.letter_date,
  holder_name: r.holder_name,
  series: r.series,
  debentures: r.debentures,
  // The number when it is one, else exactly what was typed.
  amount: r.amount > 0 ? r.amount : r.amount_text,
  bank_name: r.bank_name,
  account_holder_name: r.account_holder_name,
  account_no: r.account_no,
  ifsc: r.ifsc,
});

/**
 * Add a caution where a given Customer Code disagrees with the book.
 *
 * Advisory only, and only for rows that supplied a code. The sheet stays the
 * source of truth — a Kiara-era letter may well name a holder who was never in
 * this system at all, which is the whole reason this tool takes a spreadsheet.
 */
async function crossCheck(db: Db, rows: ParsedRow[]): Promise<void> {
  const codes = [...new Set(rows.map((r) => r.customer_code).filter(Boolean))];
  if (!codes.length) return;
  const { rows: found } = await db.query<{ customer_code: string; full_name: string }>(
    `SELECT customer_code, full_name FROM customers WHERE upper(customer_code) = ANY($1)`, [codes]);
  const byCode = new Map(found.map((c) => [c.customer_code.toUpperCase(), c.full_name]));
  for (const r of rows) {
    if (!r.customer_code) continue;
    const name = byCode.get(r.customer_code);
    if (!name) {
      r.cautions.push(`No customer ${r.customer_code} in the system — the letter still prints as typed`);
      continue;
    }
    const a = name.trim().toLowerCase();
    const b = r.holder_name.trim().toLowerCase();
    if (a !== b) r.cautions.push(`${r.customer_code} is "${name}" in the system, not "${r.holder_name}"`);
  }
}

function decorate(
  rows: ParsedRow[], from: string, consentFrom: string, templates: LetterTemplate[],
): PreviewRow[] {
  return rows.map((r) => {
    // WHICH LETTER AND WHICH COMPANY ARE NOW ONE LOOKUP (owner 2026-11-21).
    // They used to be two — addresseeFor for the company, letterKindFor for
    // the document — which could in principle disagree about the same date.
    // The configured ranges answer both at once.
    //
    // Both old helpers stay as the fallback for a date that resolves to
    // nothing, so an unparseable date behaves exactly as it did.
    const t = r.letter_date ? pickFor(templates, r.letter_date) : null;
    const era: AddresseeEra | null = r.letter_date ? addresseeFor(r.letter_date, from) : null;
    const kind = t ? t.kind : letterKindFor(r.letter_date, consentFrom);

    // WHICH PARTICULARS WILL PRINT BLANK, said here rather than discovered in
    // the zip. The owner can fix the sheet before generating; finding it
    // afterwards means collecting signatures on an incomplete document.
    //
    // Since the record is no longer read, this is simply "cells you left
    // empty" — there is nothing else that could have filled them.
    // "NCD 22" in the series box makes the REQUEST letter read "NCD NCD 22
    // Series", because its sentence already says NCD. The consent letter puts
    // the series in a table cell where no such duplication happens, so this
    // note was pure noise on exactly the rows the owner was looking at.
    if (kind === 'request' && /^ncd\b/i.test(r.series)) {
      r.cautions.push(`NCD Series "${r.series}" will read "NCD ${r.series} Series" — the letter says NCD already`);
    }

    const missing = kind === 'consent'
      ? ([
        [!r.mode_of_holding, 'Mode of Holding'],
        [!r.allotment_date, 'Date of Allotment'],
        // Date of Rollover is deliberately absent from this list. It is blank
        // on nearly every letter because nearly every holding was never rolled
        // over, so flagging it would put a caution on practically every row
        // and teach the operator to scroll past the ones that matter.
        [!r.original_maturity_date, 'Date of Maturity'],
        [r.coupon_rate_pct == null || r.coupon_rate_pct === '', 'Coupon Rate'],
        [r.face_value == null || r.face_value === '', 'Face Value'],
        [!r.pan, 'PAN'],
      ] as const).filter(([bad]) => bad).map(([, name]) => name)
      : [];
    if (missing.length) {
      r.cautions.push(`The consent letter will print these blank: ${missing.join(', ')}`);
    }

    return {
      ...r,
      addressed_to: t?.legal_name || (era ? era.legal_name : '—'),
      filename: letterFilename(r),
      letter_kind: kind,
      blank_particulars: missing,
    };
  });
}

/** Read and check an upload, without producing anything. */
export async function previewUpload(db: Db, buf: Buffer, filename: string): Promise<PreviewResult> {
  const parsed = await parseUpload(buf, filename);
  if (parsed.rows.length > MAX_ROWS) {
    throw errors.badRequest(
      `The file has ${parsed.rows.length} records; this tool takes up to ${MAX_ROWS} at a time.`);
  }
  await crossCheck(db, parsed.rows);
  const consentFrom = await consentLetterFrom(db);
  const rows = decorate(parsed.rows, dhanamFrom(), consentFrom, await listTemplates(db));

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.addressed_to, (counts.get(r.addressed_to) ?? 0) + 1);

  return {
    rows,
    header_errors: parsed.header_errors,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => !r.errors.length).length,
      with_errors: rows.filter((r) => r.errors.length).length,
      with_cautions: rows.filter((r) => !r.errors.length && r.cautions.length).length,
      total_amount: rows.filter((r) => !r.errors.length).reduce((s, r) => s + r.amount, 0),
      by_company: [...counts].map(([company, count]) => ({ company, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

export interface GenerateResult {
  zip: Buffer;
  generated: number;
  failed: { row_no: number; holder_name: string; reason: string }[];
}

/**
 * Render every valid row and bundle the PDFs.
 *
 * Rows that failed validation are skipped and reported, never half-rendered: a
 * letter missing its account number is worse than no letter, because it looks
 * finished.
 */
export async function generateLetters(db: Db, buf: Buffer, filename: string): Promise<GenerateResult> {
  const preview = await previewUpload(db, buf, filename);
  if (preview.header_errors.length) throw errors.badRequest(preview.header_errors.join('; '));

  const from = dhanamFrom();
  const templates = await listTemplates(db);
  const entries: ZipEntry[] = [];
  const failed: GenerateResult['failed'] = [];

  for (const row of preview.rows) {
    if (row.errors.length) {
      failed.push({ row_no: row.row_no, holder_name: row.holder_name, reason: row.errors.join('; ') });
      continue;
    }
    try {
      const pdf = row.letter_kind === 'consent'
        ? await consentLetterPdf(toConsentRow(row, pickFor(templates, row.letter_date)))
        : await redemptionLetterPdf(toLetterRow(row),
            eraFor(pickFor(templates, row.letter_date), row.letter_date, from));
      entries.push({ name: row.filename, data: pdf });
    } catch (e) {
      failed.push({
        row_no: row.row_no,
        holder_name: row.holder_name,
        reason: `Could not render the letter: ${(e as Error).message}`,
      });
    }
  }

  if (!entries.length) {
    throw errors.badRequest(
      failed.length ? 'Every record has something to fix — nothing was generated.'
        : 'There are no records to generate.');
  }
  return { zip: makeZip(entries), generated: entries.length, failed };
}

/** One letter, for the per-row download. */
export async function generateOne(db: Db, buf: Buffer, filename: string, rowNo: number)
: Promise<{ pdf: Buffer; filename: string }> {
  const preview = await previewUpload(db, buf, filename);
  const row = preview.rows.find((r) => r.row_no === rowNo);
  if (!row) throw errors.notFound(`Row ${rowNo} is not in this file`);
  if (row.errors.length) throw errors.badRequest(`Row ${rowNo}: ${row.errors.join('; ')}`);
  const templates = await listTemplates(db);
  const pdf = row.letter_kind === 'consent'
    ? await consentLetterPdf(toConsentRow(row, pickFor(templates, row.letter_date)))
    : await redemptionLetterPdf(toLetterRow(row), eraFor(
        pickFor(templates, row.letter_date), row.letter_date, dhanamFrom()));
  return { pdf, filename: row.filename };
}

/**
 * The blank sheet to fill in.
 *
 * Carries one example row so the expected shape of each column is visible, and
 * a notes sheet for the things a column header cannot say — above all that a
 * typed date is read day-first.
 */
export async function templateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dhanam NCD';
  wb.created = new Date();

  const ws = wb.addWorksheet('Redemption Letters');
  ws.columns = COLUMNS.map((c) => ({
    header: c,
    key: c,
    width: c === 'Name of the NCD Holder' || c === 'Account Holder Name' ? 28
      : c === 'Bank Name' ? 24 : c === 'Letter Date' ? 14 : 18,
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  ws.addRow({
    'Letter Date': new Date(Date.UTC(2025, 7, 18)),
    'Name of the NCD Holder': 'EXAMPLE — delete this row',
    'NCD Series': '29',
    'No. of Debentures': 10,
    'Amount (in Rs.)': 1000000,
    'Bank Name': 'State Bank of India',
    'Account Holder Name': 'EXAMPLE — delete this row',
    'Account No.': '30012345678',
    'IFSC Code': 'SBIN0000123',
    'Customer Code': 'DHN0001',
    // The consent columns, shown filled so their shape is visible. Only ever
    // used by a row dated on or after the cut-off; leave them empty and the
    // customer's record answers instead.
    'Mode of Holding': 'Demat',
    'Date of Allotment': new Date(Date.UTC(2024, 2, 30)),
    // Shown EMPTY on purpose: the example is an ordinary holding, and an
    // ordinary holding was never rolled over. A filled example here would
    // invite the column to be filled in for everyone.
    'Date of Rollover': null,
    'Date of Maturity': new Date(Date.UTC(2029, 2, 30)),
    'Coupon Rate': '12.5%',
    'Face Value': 500000,
    'PAN': 'ABCDE1234F',
  });
  ws.getColumn('Date of Allotment').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('Date of Rollover').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('Date of Maturity').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('Face Value').numFmt = '#,##0.00';
  // Dates as dates, not text — then nothing has to be guessed when it comes back.
  ws.getColumn('Letter Date').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('Amount (in Rs.)').numFmt = '#,##0.00';

  const notes = wb.addWorksheet('How to fill this in');
  notes.columns = [{ width: 26 }, { width: 96 }];
  const note = (a: string, b: string) => notes.addRow([a, b]);
  note('Nothing is rejected', 'Every row produces a letter. What you type is what prints — if a '
    + 'box holds three dates because the letter covers three series, all three print. Anything '
    + 'worth a second look is shown as a note next to the row in the preview; none of them stop a '
    + 'letter being made.');
  note('Every column is required', 'except Customer Code and the seven consent columns at the end, '
    + 'which are all optional. An empty one prints an empty space on the letter.');
  note('Letter Date', 'Prints at the top and bottom of the letter AND decides which company it is '
    + 'addressed to. Keep the cell formatted as a date. If you type it as text, it is read '
    + 'day first — 08/09/2025 is 8 September, not 9 August. The preview shows every date back to you '
    + 'as 08-Sep-2025 so you can check before generating.');
  note('Name of the NCD Holder', 'Prints in the sentence and in the details table.');
  note('NCD Series', 'The series on its own — "29", "BOND", "Doubling", "Debenture 3". Do NOT put '
    + '"NCD" in front of it: the letter already reads "at the time of NCD ... Series Issue", so '
    + '"NCD 29" here would print "NCD NCD 29 Series". The preview warns you if it sees one.');
  note('No. of Debentures', 'A whole number above zero.');
  note('Amount (in Rs.)', 'The invested amount being asked back. Prints as Rs.10,00,000/-.');
  note('Bank details', 'Bank Name, Account Holder Name, Account No. and IFSC Code print in the '
    + 'block the holder is asking you to credit. IFSC is 4 letters, a zero, then 6 characters.');
  note('Customer Code', 'Optional. If you give one we check the name against the system and show a '
    + 'note when they differ. It NEVER changes what prints — the sheet is the only source.');
  note('Which letter you get', 'A row dated BEFORE 01-Nov-2026 produces the Request for Redemption '
    + 'letter, exactly as this tool has always done. A row dated ON or AFTER it produces the Consent '
    + 'for Premature Redemption instead — the same document the redemption screen produces. One '
    + 'letter per row either way. The preview tells you which each row will be.');
  note('Mode of Holding', 'Demat or Physical. Only used by the consent letter. If the letter covers '
    + 'several series held differently, write what is true — "Physical / Demat" prints exactly as '
    + 'you type it. Leave it empty and the row prints blank to tick by hand.');
  note('Date of Rollover', 'Only for a holding that was actually rolled over — leave it empty for '
    + 'everything else and the letter prints that row blank, which is correct.');
  note('The other consent columns', 'Date of Allotment, Date of Maturity, Coupon Rate, Face Value '
    + 'and PAN. Whatever you type is what prints. A single date is tidied to 18-Apr-2025; several '
    + 'dates for several series print just as you wrote them. Nothing is ever read from the '
    + 'customer record — an empty box prints an empty space, and the preview lists which.');
  note('If you have an older template', 'The column now called "Date of Maturity" used to be '
    + '"Original Maturity Date". A sheet still carrying the old heading is read exactly as before '
    + '— nothing needs re-typing. New downloads of this template use the new name.');
  note('One row, one letter', `Up to ${MAX_ROWS} rows at a time. Blank rows are ignored.`);
  note('Nothing is recorded', 'This tool only produces letters. It does not create a redemption '
    + 'request, does not change any customer or investment, and keeps no copy.');
  notes.getColumn(1).font = { bold: true };
  notes.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
