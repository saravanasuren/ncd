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
}

const COLUMNS = [
  'Transaction Type', 'Debit Account', 'Transaction Amount', 'Value Date',
  'Beneficiary Account', 'Beneficiary Name', 'IFSC Code', 'Beneficiary Email ID',
  'Beneficiary ID', 'Credit Remarks', 'Debit Remarks', 'Unique Customer Reference Number',
];

function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

export async function buildNeftSheet(header: NeftHeader, rows: NeftRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(header.sheetName ?? 'NEFT');
  const head = ws.addRow(COLUMNS);
  head.eachCell((c) => { c.font = { bold: true }; });
  for (const r of rows) {
    const row = ws.addRow([
      'NEFT', header.debitAccount, r.amount, ddmmyyyy(r.valueDate),
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
