/**
 * Human-readable payout summary sheet — the companion to the bank NEFT file,
 * ported column-for-column from the old Wealth app (`_summaryXlsxRows`, order
 * as of 2026-07-23). Ops reconcile this against the Federal Net file, so the
 * column ORDER and the text-typed identifier columns both matter.
 *
 * Rupee figures are whole rupees (standard rounding); Days / Rate / Invested
 * stay as they are. Dates are dd-mm-yyyy — deliberately NOT the same as the
 * NEFT sheet (dd/mm/yyyy, lib/neft.ts): owner 2026-07-27 wants them visually
 * distinguishable at a glance, this sheet vs. the bank file.
 */
import ExcelJS from 'exceljs';
import { payoutRupees } from '@new-wealth/shared';

export interface SummaryRow {
  application_no?: string | null;
  customer_name?: string | null;
  /** Resolved staff/agent display name — the same REFERRER attribution rule
   *  (reports/book.ts) used everywhere else in the app: matched by code then
   *  name, staff before agent, raw text as a last resort. */
  referred_by?: string | null;
  phone?: string | null;
  date_of_birth?: string | Date | null;
  pan?: string | null;
  /** How the investment's own money was originally collected — NEFT/RTGS/
   *  Cheque/Easebuzz/… (applications.collection_method), not how interest is
   *  being paid out now. */
  collection_method?: string | null;
  /** Raw stored value — normalised to Male/Female/Other for display. */
  gender?: string | null;
  /** investor_category: Individual / HUF / Trust / Company / … */
  category?: string | null;
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
  /** One-time adjustments applied to this row's settlement (owner 2026-07-23). */
  addition_amount?: number | string | null;
  deduction_amount?: number | string | null;
  /** What the bank actually pays: net + addition − deduction. */
  total_amount?: number | string | null;
}

const COLUMNS = [
  '#', 'Application No', 'Customer Name', 'Referred By', 'DOB', 'Age', 'PAN', 'Gender', 'Category', 'Series', 'Type',
  'Invested (Rs)', 'Rate %', 'Beneficiary Name', 'Bank A/C', 'IFSC',
  'Interest From', 'Interest To', 'Days', 'Gross (Rs)', 'TDS (Rs)', 'Net (Rs)',
  'Addition (Rs)', 'Deduction (Rs)', 'Total (Rs)',
  // Appended, not inserted — ops reconcile this sheet against the Federal Net
  // file by column position, so every existing column keeps its index.
  'Phone', 'Payment Mode',
];

/** Completed years at the payout date. Blank when either date is unusable. */
function ageAt(dob: string | Date | null | undefined, at: string | Date | null | undefined): number | '' {
  const iso = (v: string | Date | null | undefined): string | null => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  };
  const d = iso(dob); const a = iso(at) ?? new Date().toISOString().slice(0, 10);
  if (!d) return '';
  const [dy, dm, dd] = d.split('-').map(Number);
  const [ay, am, ad] = a.split('-').map(Number);
  let age = ay! - dy!;
  if (am! < dm! || (am === dm && ad! < dd!)) age--;
  return age >= 0 && age < 130 ? age : '';
}

/** Stored values are messy (M / Male / f / Prefer not to say) — normalise. */
function genderLabel(g: unknown): string {
  const v = String(g ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'm' || v === 'male') return 'Male';
  if (v === 'f' || v === 'female') return 'Female';
  return 'Other';
}

/** Whole rupees, standard rounding (10,616.44 → 10,616; 10,616.78 → 10,617). */
const amt = (v: unknown): number | string => (v != null && v !== '' ? Math.round(Number(v)) : '');

/** dd-mm-yyyy from an ISO string or a Date (pg returns DATE as a local-midnight
 *  Date). Hyphens, not slashes — this sheet only; the NEFT sheet (lib/neft.ts)
 *  keeps dd/mm/yyyy on purpose (owner 2026-07-27). */
function ddmmyyyy(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : v;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
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
    // Whole rupees, with net/total DERIVED from the rounded gross and TDS so
    // the row (and therefore every column total) ties — see payoutRupees.
    const m = payoutRupees(r);
    const row = ws.addRow([
      i + 1,
      r.application_no ?? '',
      r.customer_name ?? '',
      r.referred_by ?? '',
      ddmmyyyy(r.date_of_birth),
      ageAt(r.date_of_birth, r.period_to),
      r.pan ?? '',
      genderLabel(r.gender),
      r.category ?? '',
      r.series_name ?? '',
      r.row_type ?? 'Balance After Redemption',
      r.investment_amount != null ? Number(r.investment_amount) : '',
      r.coupon_rate_pct != null ? Number(Number(r.coupon_rate_pct).toFixed(2)) : '',
      r.beneficiary_name ?? '',
      r.account_number ?? '',
      r.ifsc ?? '',
      ddmmyyyy(firstAccrual(r.period_to, r.period_days) ?? r.period_from ?? null),
      ddmmyyyy(r.period_to),
      r.period_days != null ? Number(r.period_days) : '',
      m.gross,
      m.tds,
      m.net,
      m.addition,
      m.deduction,
      m.total,
      r.phone ?? '',
      r.collection_method ?? '',
    ]);
    // Application No, PAN, Bank A/C, IFSC and Phone must stay TEXT — otherwise
    // Excel drops leading zeros and renders long numbers in scientific
    // notation. ⚠ These indexes track the column order above; re-check if it moves.
    for (const c of [2, 7, 15, 16, 26]) row.getCell(c).numFmt = '@';
  });

  ws.columns = [
    { width: 5 }, { width: 18 }, { width: 26 }, { width: 22 }, { width: 12 }, { width: 6 }, { width: 13 },
    { width: 9 }, { width: 12 }, { width: 16 },
    { width: 22 }, { width: 14 }, { width: 8 }, { width: 26 }, { width: 20 }, { width: 13 },
    { width: 14 }, { width: 14 }, { width: 7 }, { width: 13 }, { width: 11 }, { width: 13 },
    { width: 13 }, { width: 14 }, { width: 13 },
    { width: 14 }, { width: 14 },
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
