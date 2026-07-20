/**
 * Federal Bank NEFT (Federal Net) upload sheet (docs/00 §6). The 12-column
 * layout the bank parses, byte-format-preserved from the old app. Used by both
 * interest payouts and redemption sheets. Account numbers + IFSC as text so
 * leading zeros survive.
 */
import ExcelJS from 'exceljs';

export interface NeftRow {
  amount: number;
  valueDate: string; // 'YYYY-MM-DD'
  beneAccount: string;
  beneName: string;
  ifsc: string;
  email?: string;
  beneId?: string;
  creditRemark?: string; // ≤ 35 chars
  debitRemark?: string;
  reference?: string;
}

export interface NeftHeader {
  debitAccount: string;
  sheetName?: string;
  /** Value date stamped on every row — the day the sheet is generated. */
  valueDate?: string | Date;
}

const COLUMNS = [
  'Transaction Type', 'Debit Account', 'Transaction Amount', 'Value Date',
  'Beneficiary Account', 'Beneficiary Name', 'IFSC Code', 'Beneficiary Email ID',
  'Beneficiary ID', 'Credit Remarks', 'Debit Remarks', 'Unique Customer Reference Number',
];

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
  const ws = wb.addWorksheet(header.sheetName ?? 'NEFT');
  const head = ws.addRow(COLUMNS);
  head.eachCell((c) => { c.font = { bold: true }; });
  for (const r of rows) {
    const row = ws.addRow([
      'NEFT', header.debitAccount, r.amount, ddmmyyyy(header.valueDate ?? r.valueDate),
      r.beneAccount, r.beneName, r.ifsc, r.email ?? '', r.beneId ?? '',
      (r.creditRemark ?? '').slice(0, 35), r.debitRemark ?? '', r.reference ?? '',
    ]);
    // Force text on account + IFSC + debit account so leading zeros survive.
    row.getCell(2).numFmt = '@';
    row.getCell(5).numFmt = '@';
    row.getCell(7).numFmt = '@';
    row.getCell(3).numFmt = '#,##0.00';
  }
  ws.columns = [
    { width: 14 }, { width: 20 }, { width: 16 }, { width: 12 }, { width: 20 },
    { width: 28 }, { width: 14 }, { width: 24 }, { width: 14 }, { width: 36 }, { width: 20 }, { width: 26 },
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
