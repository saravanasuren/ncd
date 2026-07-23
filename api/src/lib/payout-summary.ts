/**
 * Human-readable payout summary sheet — the companion to the bank NEFT file,
 * ported column-for-column from the old Wealth app (`_summaryXlsxRows`, order
 * as of 2026-07-23). Ops reconcile this against the Federal Net file, so the
 * column ORDER and the text-typed identifier columns both matter.
 *
 * Rupee figures are whole rupees (standard rounding); Days / Rate / Invested
 * stay as they are. Dates are dd/mm/yyyy.
 */
import ExcelJS from 'exceljs';

export interface SummaryRow {
  application_no?: string | null;
  customer_name?: string | null;
  date_of_birth?: string | Date | null;
  pan?: string | null;
  series_name?: string | null;
  /** Addition = new money paying out first time · Redemption = exiting slice · Live. */
  row_type?: string | null;
  investment_amount?: number | string | null;
  coupon_rate_pct?: number | string | null;
  beneficiary_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  period_from?: string | Date | null;
  period_to?: string | Date | null;
  period_days?: number | string | null;
  gross_amount?: number | string | null;
  tds_amount?: number | string | null;
  net_amount?: number | string | null;
}

const COLUMNS = [
  '#', 'Application No', 'Customer Name', 'DOB', 'PAN', 'Series', 'Type',
  'Invested (Rs)', 'Rate %', 'Beneficiary Name', 'Bank A/C', 'IFSC',
  'Interest From', 'Interest To', 'Days', 'Gross (Rs)', 'TDS (Rs)', 'Net (Rs)',
];

/** Whole rupees, standard rounding (10,616.44 → 10,616; 10,616.78 → 10,617). */
const amt = (v: unknown): number | string => (v != null && v !== '' ? Math.round(Number(v)) : '');

/** dd/mm/yyyy from an ISO string or a Date (pg returns DATE as a local-midnight Date). */
function ddmmyyyy(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * The FIRST day interest actually accrues. `period_from` is the exclusive
 * baseline (the previous cut-off itself), so printing it directly shows a day
 * too early — wealth hit exactly this bug. period_days already encodes the
 * inclusive/exclusive rule, so counting back from period_to is correct for both
 * a normal cycle and a brand-new investment.
 */
function firstAccrual(to: string | Date | null | undefined, days: unknown): string | null {
  const n = Number(days);
  if (!to || !(n > 0)) return null;
  const iso = to instanceof Date
    ? new Date(to.getTime() - to.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    : String(to).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return d.toISOString().slice(0, 10);
}

export async function buildSummarySheet(rows: SummaryRow[], sheetName = 'Summary'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const head = ws.addRow(COLUMNS);
  head.eachCell((c) => { c.font = { bold: true }; });

  rows.forEach((r, i) => {
    const row = ws.addRow([
      i + 1,
      r.application_no ?? '',
      r.customer_name ?? '',
      ddmmyyyy(r.date_of_birth),
      r.pan ?? '',
      r.series_name ?? '',
      r.row_type ?? 'Live',
      r.investment_amount != null ? Number(r.investment_amount) : '',
      r.coupon_rate_pct != null ? Number(Number(r.coupon_rate_pct).toFixed(2)) : '',
      r.beneficiary_name ?? '',
      r.account_number ?? '',
      r.ifsc ?? '',
      ddmmyyyy(firstAccrual(r.period_to, r.period_days) ?? r.period_from ?? null),
      ddmmyyyy(r.period_to),
      r.period_days != null ? Number(r.period_days) : '',
      amt(r.gross_amount),
      amt(r.tds_amount),
      amt(r.net_amount),
    ]);
    // Application No, PAN, Bank A/C and IFSC must stay TEXT — otherwise Excel
    // drops leading zeros and renders long account numbers in scientific
    // notation. ⚠ These indexes track the column order above; re-check if it moves.
    for (const c of [2, 5, 11, 12]) row.getCell(c).numFmt = '@';
  });

  ws.columns = [
    { width: 5 }, { width: 18 }, { width: 26 }, { width: 12 }, { width: 13 }, { width: 16 },
    { width: 11 }, { width: 14 }, { width: 8 }, { width: 26 }, { width: 20 }, { width: 13 },
    { width: 14 }, { width: 14 }, { width: 7 }, { width: 13 }, { width: 11 }, { width: 13 },
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
