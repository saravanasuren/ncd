/**
 * Federal Bank "Federal Net" NEFT bulk-upload sheet — matched to the old Wealth
 * app EXACTLY (its `utils/neft-format.js` + `services/payout-batch.js`
 * `_neftRows`; format locked with the operator 2026-05-21, amended 2026-07-09).
 * Used by interest payouts and redemption sheets.
 *
 * The 12 columns, and the rules that are easy to get wrong:
 *   1  Transaction Type          — NEFT / RTGS / IFT, chosen PER ROW (below)
 *   2  Debit Account Number      — TEXT cell so leading zeros survive
 *   3  Transaction Amount        — WHOLE rupees, round half-up (no decimals)
 *   4  Value Date                — DD/MM/YYYY
 *   5  Beneficiary Account Number— TEXT cell
 *   6  Beneficiary Name          — the bank account's holder_name
 *   7  IFSC Code                 — exactly 11 characters
 *   8  Beneficiary Email ID      — a FIXED Dhanam ops mailbox, never the
 *                                  customer's own address (owner 2026-07-23)
 *   9  Beneficiary ID            — blank (Dhanam doesn't pre-register)
 *   10 Credit Remarks            — the NCD series name, spaces stripped, ≤35
 *   11 Debit Remarks             — the literal 'ncdinterest'
 *   12 Unique Customer Reference — blank (Federal generates its own UTR)
 */
import ExcelJS from 'exceljs';

/** Wealth's default ops mailbox — overridable via payouts.neft_beneficiary_email. */
export const BENEFICIARY_EMAIL_FALLBACK = 'karthick@dhanam.finance';
const RTGS_THRESHOLD = 200000;          // ₹2,00,000 — RBI's NEFT/RTGS split
const FEDERAL_BANK_IFSC_PREFIX = 'FDRL';

export interface NeftRow {
  amount: number;
  valueDate: string; // 'YYYY-MM-DD'
  beneAccount: string;
  beneName: string;
  ifsc: string;
  /** Series name → Credit Remarks (spaces stripped, ≤35). */
  seriesName?: string;
  beneId?: string;
  debitRemark?: string;
  reference?: string;
}

export interface NeftHeader {
  debitAccount: string;
  sheetName?: string;
  /** Value date stamped on every row — the day the sheet is generated. */
  valueDate?: string | Date;
  /** The one ops mailbox stamped on EVERY row. */
  beneficiaryEmail?: string;
}

const COLUMNS = [
  'Transaction Type', 'Debit Account Number', 'Transaction Amount', 'Value Date',
  'Beneficiary Account Number', 'Beneficiary Name', 'IFSC Code', 'Beneficiary Email ID',
  'Beneficiary ID', 'Credit Remarks', 'Debit Remarks', 'Unique Customer Reference Number',
];

/**
 * Per-row transaction type. Federal-to-Federal is an intra-bank transfer at any
 * amount; otherwise ₹2L is the NEFT/RTGS boundary. Sending every row as 'NEFT'
 * (what NCD did before this) mis-routes large and intra-bank payments.
 */
export function chooseTransactionType(amount: number | string, ifsc: string): 'NEFT' | 'RTGS' | 'IFT' {
  const ifscUp = String(ifsc ?? '').trim().toUpperCase();
  if (ifscUp.startsWith(FEDERAL_BANK_IFSC_PREFIX)) return 'IFT';
  return (Number(amount) || 0) >= RTGS_THRESHOLD ? 'RTGS' : 'NEFT';
}

/** IFSC is exactly 11 characters — truncated if longer, space-padded if shorter. */
export function normalizeIfsc(ifsc: string): string {
  const up = String(ifsc ?? '').trim().toUpperCase();
  return up.length >= 11 ? up.slice(0, 11) : up.padEnd(11, ' ');
}

/** Federal Net wants whole rupees in Transaction Amount; round half-up. */
const wholeRupees = (v: number | string): number => Math.round(Number(v) || 0);

/** The remarks columns reject whitespace. */
const noSpaces = (s: string): string => String(s ?? '').replace(/\s+/g, '');

/** dd/mm/yyyy for the bank. Accepts an ISO string OR a Date (pg returns DATE
 * columns as Date objects — String()ing those produced the old
 * "undefined-undefined-Mon…" cells). */
function ddmmyyyy(value: string | Date): string {
  const iso = value instanceof Date
    ? new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    : String(value).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return String(value);
  return `${d}/${m}/${y}`;
}

export async function buildNeftSheet(header: NeftHeader, rows: NeftRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(header.sheetName ?? 'Sheet 1');
  const head = ws.addRow(COLUMNS);
  head.eachCell((c) => { c.font = { bold: true }; });
  const email = header.beneficiaryEmail || BENEFICIARY_EMAIL_FALLBACK;
  for (const r of rows) {
    const ifsc = normalizeIfsc(r.ifsc);
    const row = ws.addRow([
      chooseTransactionType(r.amount, ifsc),
      header.debitAccount,
      wholeRupees(r.amount),
      ddmmyyyy(header.valueDate ?? r.valueDate),
      r.beneAccount, r.beneName, ifsc,
      email,
      r.beneId ?? '',
      noSpaces(r.seriesName ?? '').slice(0, 35) || 'ncdinterest',
      noSpaces(r.debitRemark ?? 'ncdinterest'),
      r.reference ?? '',
    ]);
    // Force text on account + IFSC + debit account so leading zeros survive.
    row.getCell(2).numFmt = '@';
    row.getCell(5).numFmt = '@';
    row.getCell(7).numFmt = '@';
    row.getCell(3).numFmt = '0';
  }
  ws.columns = [
    { width: 14 }, { width: 22 }, { width: 16 }, { width: 12 }, { width: 24 },
    { width: 28 }, { width: 14 }, { width: 26 }, { width: 14 }, { width: 36 }, { width: 20 }, { width: 26 },
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
