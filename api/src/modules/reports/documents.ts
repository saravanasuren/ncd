/** SOA PDF, TDS register, and full DB dump (docs/06 §5). */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import type { Db } from '../../db/types.js';
import { renderPdf, letterhead } from '../../lib/pdf.js';
import { formatINR } from '@new-wealth/shared';
import { getSettingsMap } from '../settings/service.js';
import { errors } from '../../lib/errors.js';

/** Statement of account for one customer. `customerFacing` filters the row
 * list by the display cutoff (aggregates stay full — docs/06 §5). */
export async function soaPdf(db: Db, customerId: number, customerFacing = false): Promise<Buffer> {
  const c = (await db.query<Record<string, unknown>>('SELECT * FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!c) throw errors.notFound('Customer not found');
  const apps = (await db.query<Record<string, unknown>>(
    "SELECT application_no, total_amount, status, allotment_date, maturity_date FROM applications WHERE customer_id = $1 AND status IN ('Active','Matured','Redeemed') ORDER BY allotment_date", [customerId])).rows;
  const settings = await getSettingsMap(db);
  const cutoff = String(settings['portal.statement_display_cutoff'] ?? '2026-06-19');
  const paidAgg = Number((await db.query<{ v: string }>(
    "SELECT COALESCE(sum(net_amount),0) AS v FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id WHERE a.customer_id = $1 AND ds.status = 'Paid' AND ds.due_type IN ('Interest','BrokenInterest')", [customerId])).rows[0]!.v);
  const listRows = (await db.query<Record<string, unknown>>(
    `SELECT ds.due_date, ds.due_type, ds.net_amount, ds.status FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id
     WHERE a.customer_id = $1 ${customerFacing ? 'AND ds.due_date >= $2' : ''} ORDER BY ds.due_date DESC LIMIT 60`,
    customerFacing ? [customerId, cutoff] : [customerId])).rows;

  return renderPdf((doc) => {
    letterhead(doc, 'Statement of Account', `${c.full_name} · ${c.customer_code}`);
    doc.fontSize(10).font('Helvetica').text(`Interest collected to date: ${formatINR(paidAgg)}`);
    doc.moveDown(0.6).font('Helvetica-Bold').text('Holdings').font('Helvetica').fontSize(9);
    for (const a of apps) doc.text(`${a.application_no}   ${formatINR(Number(a.total_amount))}   ${a.status}   matures ${a.maturity_date ?? '—'}`);
    doc.moveDown(0.6).fontSize(10).font('Helvetica-Bold').text('Recent transactions').font('Helvetica').fontSize(9);
    for (const r of listRows) doc.text(`${r.due_date}   ${r.due_type}   ${formatINR(Number(r.net_amount))}   ${r.status}`);
    if (!listRows.length) doc.fillColor('#6b7380').text('None');
  });
}

async function loadAppForDoc(db: Db, applicationId: number) {
  const a = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.customer_id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date,
            s.deemed_date, c.full_name, c.customer_code, c.pan, c.address, s.code AS series_code, s.name AS series_name, s.isin
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  const lines = (await db.query<Record<string, unknown>>(
    `SELECT al.amount, al.coupon_rate_pct, al.tenure_months, al.payout_frequency, sch.name AS scheme_name
       FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
      WHERE al.application_id = $1 ORDER BY al.id`, [applicationId])).rows;
  return { a, lines };
}

/** Allotment letter for one allotted application. */
export async function allotmentLetterPdf(db: Db, applicationId: number): Promise<Buffer> {
  const { a, lines } = await loadAppForDoc(db, applicationId);
  const totalCoupon = lines[0]?.coupon_rate_pct;
  return renderPdf((doc) => {
    letterhead(doc, 'Letter of Allotment', `${a.full_name} · ${a.customer_code}`);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Dear ${a.full_name},`);
    doc.moveDown(0.4);
    doc.text(`We are pleased to confirm the allotment of Non-Convertible Debentures against your application ${a.application_no} in ${a.series_name} (${a.series_code}).`, { width: 480 });
    doc.moveDown(0.6).font('Helvetica-Bold').text('Allotment summary').font('Helvetica').fontSize(9);
    doc.text(`Amount allotted: ${formatINR(Number(a.total_amount))}`);
    if (totalCoupon != null) doc.text(`Coupon rate: ${Number(totalCoupon)}% p.a.`);
    if (a.allotment_date) doc.text(`Allotment date: ${a.allotment_date}`);
    if (a.maturity_date) doc.text(`Maturity date: ${a.maturity_date}`);
    if (a.isin) doc.text(`ISIN: ${a.isin}`);
    doc.moveDown(1).fontSize(10).text('The corresponding debenture certificate is available in your account. Interest will be paid as per the payout schedule.', { width: 480 });
    doc.moveDown(1.5).fillColor('#6b7380').fontSize(9).text('For Dhanam Investment and Finance Private Limited');
  });
}

/** TDS register for a month (YYYY-MM) — one row per TDS-bearing payout. */
// Citizen category as of the payout date, derived from DOB (auto — no manual
// entry). Senior citizen = 60+ (§194A: higher exemption limit + Form 15H, vs
// 15G for general). Kept in SQL so it can never drift from the customer's DOB.
const CATEGORY_SQL = "CASE WHEN c.dob IS NOT NULL AND EXTRACT(YEAR FROM age(ds.due_date, c.dob)) >= 60 THEN 'Senior' ELSE 'General' END";
const formFor = (category: unknown) => (category === 'Senior' ? '15H' : '15G');

export async function tdsReport(db: Db, yyyymm: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`TDS ${yyyymm}`);
  ws.addRow(['Customer', 'PAN', 'Category', 'Form', 'Application', 'Due date', 'Gross', 'TDS', 'Net']).eachCell((c) => { c.font = { bold: true }; });
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT c.full_name, c.pan, a.application_no, ds.due_date, ds.gross_amount, ds.tds_amount, ds.net_amount,
            ${CATEGORY_SQL} AS category
     FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ds.tds_amount > 0 AND to_char(ds.due_date,'YYYY-MM') = $1 ORDER BY c.full_name`, [yyyymm])).rows;
  for (const r of rows) ws.addRow([r.full_name, r.pan, r.category, formFor(r.category), r.application_no, r.due_date, Number(r.gross_amount), Number(r.tds_amount), Number(r.net_amount)]);
  [7, 8, 9].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Quarterly 26Q TDS filing annexure (Form 26Q deductee details, §194A —
 * interest other than on securities). 17-column layout matching the NSDL/
 * Protean annexure so it can be lifted into the RPU. `quarter` = 'YYYY-Qn'
 * (financial-year quarter: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar). */
export async function tds26q(db: Db, quarter: string): Promise<Buffer> {
  const m = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!m) throw errors.badRequest("Quarter must look like '2026-Q1'");
  const fy = Number(m[1]);
  const q = Number(m[2]);
  // FY quarter → calendar month range. Q1 = Apr(fy)-Jun; Q4 = Jan-Mar(fy+1).
  const ranges: Record<number, [string, string]> = {
    1: [`${fy}-04-01`, `${fy}-06-30`],
    2: [`${fy}-07-01`, `${fy}-09-30`],
    3: [`${fy}-10-01`, `${fy}-12-31`],
    4: [`${fy + 1}-01-01`, `${fy + 1}-03-31`],
  };
  const [start, end] = ranges[q]!;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`26Q ${quarter}`);
  const HEADERS = [
    'Sl. No.', 'Deductee code (01-Company/02-Other)', 'PAN of deductee', 'Name of deductee',
    'Date of payment/credit', 'Amount paid/credited', 'TDS', 'Surcharge', 'Health & Edu Cess',
    'Total tax deducted', 'Total tax deposited', 'Date of deduction', 'Rate (%)',
    'Reason for non/lower deduction', 'Section code', 'Date of deposit', 'Challan / BSR ref',
    'Deductee category', 'Form (15G/15H)', // trailing info — auto from DOB, for filing prep
  ];
  ws.addRow(HEADERS).eachCell((c) => { c.font = { bold: true }; });

  const rows = (await db.query<Record<string, unknown>>(
    `SELECT c.full_name, c.pan, ds.due_date, ds.gross_amount, ds.tds_amount, ${CATEGORY_SQL} AS category
       FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id JOIN customers c ON c.id = a.customer_id
      WHERE ds.tds_amount > 0 AND ds.due_date >= $1::date AND ds.due_date <= $2::date
      ORDER BY c.full_name, ds.due_date`, [start, end])).rows;

  let sl = 0;
  for (const r of rows) {
    sl++;
    const gross = Number(r.gross_amount);
    const tds = Number(r.tds_amount);
    const rate = gross > 0 ? Math.round((tds / gross) * 10000) / 100 : 0;
    ws.addRow([
      sl,
      '02',                        // deductee code: individuals/HUF = Other
      r.pan ?? '',
      r.full_name,
      r.due_date,
      gross,
      tds,
      0,                           // surcharge (nil for resident 194A)
      0,                           // health & edu cess (nil on TDS)
      tds,                         // total tax deducted
      tds,                         // total tax deposited
      r.due_date,                  // date of deduction = credit date
      rate,
      r.pan ? '' : 'C',            // no PAN → higher rate flag 'C'
      '194A',
      '',                          // date of deposit (challan) — filled at filing
      '',                          // challan/BSR — filled at filing
      r.category,                  // deductee category (auto from DOB)
      formFor(r.category),         // 15H (senior) / 15G (general)
    ]);
  }
  [6, 7, 8, 9, 10, 11].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 20; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// dd/mm/yyyy — matches wealth's _cwDate exactly (the format ops are used to
// reading this report in).
function ddmmyyyy(v: string | null): string {
  if (!v) return '';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

/** Two-sheet workbook, ported column-for-column from wealth's customer-wise.xlsx
 * (Customers + Investments, exact header text and order). */
export async function customerWiseXlsx(rows: import('./book.js').CustomerWiseRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const custWs = wb.addWorksheet('Customers');
  custWs.addRow([
    'S.No', 'Customer Code', 'Name', 'DOB', 'Age', 'PAN', 'Phone', 'Address',
    'TDS / Form 121', 'Total Investment', 'Redemption Amount', 'All-time Invested', 'No. of Investments',
  ]).eachCell((c) => { c.font = { bold: true }; });
  rows.forEach((r, i) => {
    custWs.addRow([
      i + 1, r.customer_code, r.full_name, ddmmyyyy(r.dob), r.age ?? '', r.pan ?? '', r.phone ?? '',
      r.address, r.tds_status, r.total_invested, r.total_redeemed, r.total_all_time, r.applications.length,
    ]);
  });
  custWs.columns = [
    { width: 6 }, { width: 16 }, { width: 26 }, { width: 12 }, { width: 6 }, { width: 13 }, { width: 14 },
    { width: 34 }, { width: 22 }, { width: 15 }, { width: 16 }, { width: 16 }, { width: 15 },
  ];

  const invWs = wb.addWorksheet('Investments');
  invWs.addRow(['Customer Code', 'Name', 'PAN', 'Application No', 'Series', 'Amount', 'Status', 'Date'])
    .eachCell((c) => { c.font = { bold: true }; });
  rows.forEach((r) => {
    for (const a of r.applications) {
      invWs.addRow([r.customer_code, r.full_name, r.pan ?? '', a.application_no, a.series_code ?? '', a.amount, a.status, ddmmyyyy(a.date_money_received)]);
    }
  });
  invWs.columns = [
    { width: 16 }, { width: 26 }, { width: 13 }, { width: 18 }, { width: 14 }, { width: 15 }, { width: 20 }, { width: 12 },
  ];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Per-series holder list with demat details (one row per unique holder). */
export async function seriesHoldersXlsx(seriesLabel: string, rows: import('./book.js').SeriesHolderRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Holders');
  ws.addRow([`Series ${seriesLabel} — holders (demat)`]).eachCell((c) => { c.font = { bold: true, size: 13 }; });
  ws.addRow([]);
  ws.addRow(['S.No', 'Name', 'PAN', 'Total Invested', 'No. of Investments', 'Referred By', 'Depository', 'DP ID', 'Client ID', 'Dematerialised'])
    .eachCell((c) => { c.font = { bold: true }; });
  rows.forEach((r, i) => {
    ws.addRow([
      i + 1, r.full_name, r.pan ?? '', r.total_invested, r.investments, r.referred_by ?? '',
      r.depository ?? '', r.dp_id ?? '', r.client_id ?? '',
      r.is_dematerialised == null ? '' : (r.is_dematerialised ? 'Yes' : 'No'),
    ]);
  });
  ws.addRow([]);
  ws.addRow(['', 'TOTAL', '', rows.reduce((s, r) => s + r.total_invested, 0), rows.reduce((s, r) => s + r.investments, 0)])
    .eachCell((c) => { c.font = { bold: true }; });
  ws.columns = [{ width: 6 }, { width: 28 }, { width: 14 }, { width: 16 }, { width: 18 }, { width: 22 }, { width: 12 }, { width: 16 }, { width: 18 }, { width: 14 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Series-wise register: one row per INVESTMENT in the series, each carrying the
 *  customer's complete details (owner 2026-09-09). Full Aadhaar is included by
 *  request — the file is PII-heavy, treat it accordingly. */
export async function seriesWiseXlsx(seriesLabel: string, rows: import('./book.js').SeriesWiseRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Series-wise');
  ws.addRow([`Series ${seriesLabel} — customers & investments`]).eachCell((c) => { c.font = { bold: true, size: 13 }; });
  ws.addRow([]);
  const headers = [
    'S.No', 'Customer Code', 'Name', 'Father / Spouse', 'PAN', 'Aadhaar', 'DOB', 'Gender', 'Phone', 'Alt Phone', 'Email',
    'Address', 'City', 'District', 'State', 'Pincode', 'Category', 'Nominees',
    'Bank A/C', 'IFSC', 'Bank Name', 'Depository', 'DP ID', 'Client ID', 'Referred By',
    'Application No', 'Series', 'Amount', 'Coupon %', 'Tenure (m)', 'Payout Frequency',
    'Money Received', 'Maturity', 'Status', 'Outstanding',
  ];
  ws.addRow(headers).eachCell((c) => { c.font = { bold: true }; });
  rows.forEach((r, i) => {
    ws.addRow([
      i + 1, r.customer_code, r.full_name, r.father_name ?? '', r.pan ?? '', r.aadhaar ?? '', ddmmyyyy(r.dob), r.gender ?? '',
      r.phone ?? '', r.phone_secondary ?? '', r.email ?? '',
      r.address ?? '', r.city ?? '', r.district ?? '', r.state ?? '', r.pincode ?? '', r.category ?? '', r.nominees ?? '',
      r.bank_account ?? '', r.bank_ifsc ?? '', r.bank_name ?? '', r.depository ?? '', r.dp_id ?? '', r.client_id ?? '', r.referred_by ?? '',
      r.application_no, r.series_code, r.amount, r.coupon_rate_pct ?? '', r.tenure_months ?? '', r.payout_frequency ?? '',
      ddmmyyyy(r.date_money_received), ddmmyyyy(r.maturity_date), r.status, r.outstanding,
    ]);
  });
  // Column positions are looked up by header name so adding/moving a column can
  // never silently mis-align the TEXT formats or the total cells (owner 2026-09-09).
  const col = (h: string) => headers.indexOf(h) + 1; // 1-based
  ws.addRow([]);
  const total = ws.addRow([]);
  total.getCell(col('Customer Code')).value = 'TOTAL'; total.getCell(col('Customer Code')).font = { bold: true };
  total.getCell(col('Amount')).value = rows.reduce((s, r) => s + r.amount, 0); total.getCell(col('Amount')).font = { bold: true };
  total.getCell(col('Outstanding')).value = rows.reduce((s, r) => s + r.outstanding, 0); total.getCell(col('Outstanding')).font = { bold: true };
  // These stay TEXT so Excel keeps leading zeros and never renders long numbers
  // in scientific notation.
  const textCols = ['PAN', 'Aadhaar', 'Phone', 'Alt Phone', 'Pincode', 'Bank A/C', 'IFSC'].map(col);
  ws.eachRow((row, n) => { if (n > 3) for (const c of textCols) row.getCell(c).numFmt = '@'; });
  const widthOf: Record<string, number> = {
    'S.No': 6, 'Customer Code': 15, 'Name': 26, 'Father / Spouse': 24, 'PAN': 13, 'Aadhaar': 15, 'DOB': 12,
    'Gender': 8, 'Phone': 13, 'Alt Phone': 13, 'Email': 24, 'Address': 34, 'City': 14, 'District': 14,
    'State': 14, 'Pincode': 9, 'Category': 12, 'Nominees': 26, 'Bank A/C': 18, 'IFSC': 13, 'Bank Name': 20,
    'Depository': 11, 'DP ID': 12, 'Client ID': 12, 'Referred By': 22, 'Application No': 18, 'Series': 12,
    'Amount': 15, 'Coupon %': 9, 'Tenure (m)': 10, 'Payout Frequency': 16, 'Money Received': 14,
    'Maturity': 12, 'Status': 16, 'Outstanding': 15,
  };
  ws.columns = headers.map((h) => ({ width: widthOf[h] ?? 14 }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Full DB dump — key tables as sheets (admin). STREAMS to the response so the
 * large Schedule sheet (~tens of thousands of rows) never buffers the whole
 * workbook in memory (that OOM-killed the 512M service → nginx 502). */
export async function dumpXlsx(out: Writable, db: Db): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  const sheets: [string, string][] = [
    ['Customers', 'SELECT id, customer_code, full_name, phone, district, kyc_status, creation_status FROM customers ORDER BY id'],
    ['Applications', 'SELECT id, application_no, customer_id, series_id, status, total_amount, allotment_date, maturity_date FROM applications ORDER BY id'],
    ['Schedule', 'SELECT id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status FROM disbursement_schedule ORDER BY id'],
    ['Redemptions', 'SELECT id, redemption_no, application_id, type, principal, penalty, net_payment, status FROM redemptions ORDER BY id'],
  ];
  for (const [name, sql] of sheets) {
    const ws = wb.addWorksheet(name);
    const rows = (await db.query<Record<string, unknown>>(sql)).rows;
    if (rows.length) {
      ws.columns = Object.keys(rows[0]!).map((k) => ({ header: k, width: 18 }));
      const hdr = ws.getRow(1);
      hdr.eachCell((c) => { c.font = { bold: true }; });
      hdr.commit();
      for (const r of rows) ws.addRow(Object.values(r)).commit();
    } else {
      ws.getRow(1).commit();
    }
    await ws.commit();
  }
  await wb.commit();
}

/**
 * Incentives for one month, staff and agents, in one workbook
 * (owner 2026-09-14: "i need a clear detailed report of incentives of each and
 * every staffs for that particular month. for agents also the same ... no pdf
 * files - i need it in excel").
 *
 * Three sheets, in the order the question is usually asked: Summary answers
 * "what do I owe each person", and the two detail sheets answer "why".
 *
 * Staff and agents are SEPARATE SHEETS rather than one list with a column,
 * because they are paid through different routes and the totals are wanted
 * apart. Columns match between them so the two read the same.
 *
 * A person with nothing in the month is absent rather than present as a zero: a
 * payout sheet listing 40 people who earned nothing buries the eight who did.
 */
export async function monthlyIncentivesXlsx(
  month: string,
  rows: import('../incentives/service.js').MonthlyIncentiveRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';

  const staff = rows.filter((r) => r.is_staff);
  const agents = rows.filter((r) => !r.is_staff);

  const sum = wb.addWorksheet('Summary');
  sum.addRow([`Incentives earned in ${month}`]).font = { bold: true, size: 14 };
  sum.addRow([
    'Everything arising from investments whose money was RECEIVED in this month, '
    + 'whether or not it has been paid. This matches the Incentives page and My Earnings.',
  ]);
  sum.addRow([]);
  sum.addRow(['Type', 'Name', 'Investments', 'Customers', 'Investment Amount', 'Incentive Earned', 'Paid', 'Outstanding'])
    .eachCell((c) => { c.font = { bold: true }; });

  interface Agg {
    type: string; name: string; n: number; customers: Set<string>;
    inv: number; earned: number; paid: number;
  }
  const byPayee = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.payee_type}:${r.payee_id}`;
    const e: Agg = byPayee.get(key) ?? {
      type: r.is_staff ? 'Staff' : 'Agent', name: r.payee_name,
      n: 0, customers: new Set<string>(), inv: 0, earned: 0, paid: 0,
    };
    e.n += 1;
    if (r.customer_code) e.customers.add(r.customer_code);
    e.inv += r.investment_amount;
    e.earned += r.incentive_amount;
    if (r.paid) e.paid += r.incentive_amount;
    byPayee.set(key, e);
  }
  const summary = [...byPayee.values()].sort((a, b) =>
    a.type === b.type ? b.earned - a.earned : (a.type === 'Staff' ? -1 : 1));
  for (const e of summary) {
    sum.addRow([e.type, e.name, e.n, e.customers.size, e.inv, e.earned, e.paid, e.earned - e.paid]);
  }
  if (summary.length) {
    sum.addRow([]);
    const total = sum.addRow([
      'TOTAL', '', rows.length, '',
      summary.reduce((t, e) => t + e.inv, 0),
      summary.reduce((t, e) => t + e.earned, 0),
      summary.reduce((t, e) => t + e.paid, 0),
      summary.reduce((t, e) => t + (e.earned - e.paid), 0),
    ]);
    total.eachCell((c) => { c.font = { bold: true }; });
  } else {
    sum.addRow(['No incentives were earned in this month.']);
  }
  sum.columns = [
    { width: 8 }, { width: 30 }, { width: 13 }, { width: 11 },
    { width: 18, style: { numFmt: money } }, { width: 17, style: { numFmt: money } },
    { width: 14, style: { numFmt: money } }, { width: 14, style: { numFmt: money } },
  ];

  const detail = (title: string, list: typeof rows) => {
    const ws = wb.addWorksheet(title);
    ws.addRow([
      'Name', 'Role', 'Application No', 'Customer', 'Customer Code', 'Series',
      'Money Received', 'Investment Amount', 'Rate', 'Incentive', 'Paid?', 'Paid On',
    ]).eachCell((c) => { c.font = { bold: true }; });
    for (const r of list) {
      ws.addRow([
        r.payee_name, r.role, r.application_no ?? '', r.customer ?? '', r.customer_code ?? '',
        r.series_code ?? '', ddmmyyyy(r.date_money_received), r.investment_amount,
        // The rate as it was actually applied, not one re-derived here — a
        // payee's book is not all at one rate, and the mixture is usually the
        // question being asked.
        r.rate_value == null ? '' : (r.rate_mode === 'percent' ? `${r.rate_value}%` : String(r.rate_value)),
        r.incentive_amount, r.paid ? 'Paid' : 'Unpaid', ddmmyyyy(r.paid_at),
      ]);
    }
    if (list.length) {
      ws.addRow([]);
      const t = ws.addRow([
        'TOTAL', '', '', '', '', '', '',
        list.reduce((x, r) => x + r.investment_amount, 0), '',
        list.reduce((x, r) => x + r.incentive_amount, 0), '', '',
      ]);
      t.eachCell((c) => { c.font = { bold: true }; });
    } else {
      ws.addRow(['Nobody in this group earned an incentive in this month.']);
    }
    ws.columns = [
      { width: 28 }, { width: 10 }, { width: 18 }, { width: 26 }, { width: 15 }, { width: 12 },
      { width: 15 }, { width: 18, style: { numFmt: money } }, { width: 9 },
      { width: 14, style: { numFmt: money } }, { width: 9 }, { width: 13 },
    ];
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  detail('Staff', staff);
  detail('Agents', agents);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Staff-wise investments, broken down month-wise AND series-wise (owner
 *  2026-09-21). Three sheets off the one grain (book.staffMonthSeriesReport):
 *   • "By Month"  — staff × month pivot of amount, row + column totals.
 *   • "By Series" — staff × series pivot of amount, row + column totals.
 *   • "Detail"    — staff · month · series · #investments · amount (the grain).
 *  Amount is the subscribed investment brought in, not live outstanding. */
export async function staffMonthSeriesXlsx(
  rows: import('./book.js').StaffMonthSeriesRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const MONEY = '#,##0';

  // Distinct staff (row axis) and the two column axes, each sorted so the file
  // is stable run to run — months chronologically, series alphabetically.
  const staff = [...new Set(rows.map((r) => r.staff))].sort((a, b) => a.localeCompare(b));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const seriesCodes = [...new Set(rows.map((r) => r.series_code))].sort((a, b) => a.localeCompare(b));

  /** Build a staff × <cols> pivot sheet summing `amount`, with totals. */
  const pivot = (title: string, cols: string[], keyOf: (r: import('./book.js').StaffMonthSeriesRow) => string) => {
    const ws = wb.addWorksheet(title);
    // cell[staff][col] = amount
    const cell = new Map<string, Map<string, number>>();
    for (const s of staff) cell.set(s, new Map());
    for (const r of rows) {
      const m = cell.get(r.staff)!;
      m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.amount);
    }
    ws.addRow([title]).eachCell((c) => { c.font = { bold: true, size: 13 }; });
    ws.addRow([]);
    ws.addRow(['Staff', ...cols, 'Total']).eachCell((c) => { c.font = { bold: true }; });
    const colTotals = new Array(cols.length).fill(0);
    let grand = 0;
    for (const s of staff) {
      const m = cell.get(s)!;
      const vals = cols.map((c) => m.get(c) ?? 0);
      const rowTotal = vals.reduce((a, b) => a + b, 0);
      vals.forEach((v, i) => { colTotals[i] += v; });
      grand += rowTotal;
      const row = ws.addRow([s, ...vals, rowTotal]);
      row.eachCell((c, n) => { if (n > 1) c.numFmt = MONEY; });
      row.getCell(cols.length + 2).font = { bold: true };
    }
    const totalRow = ws.addRow(['TOTAL', ...colTotals, grand]);
    totalRow.eachCell((c, n) => { c.font = { bold: true }; if (n > 1) c.numFmt = MONEY; });
    ws.columns = ['Staff', ...cols, 'Total'].map((h, i) => ({ width: i === 0 ? 26 : Math.max(12, h.length + 2) }));
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
  };

  pivot('By Month', months, (r) => r.month);
  pivot('By Series', seriesCodes, (r) => r.series_code);

  // Detail grain — every staff · month · series bucket, so anyone can re-pivot.
  const det = wb.addWorksheet('Detail');
  det.addRow(['Staff-wise investments — detail']).eachCell((c) => { c.font = { bold: true, size: 13 }; });
  det.addRow([]);
  det.addRow(['Staff', 'Month', 'Series', '# Investments', 'Amount']).eachCell((c) => { c.font = { bold: true }; });
  for (const r of rows) {
    const row = det.addRow([r.staff, r.month, r.series_code, r.count, r.amount]);
    row.getCell(5).numFmt = MONEY;
  }
  const dTotal = det.addRow(['TOTAL', '', '', rows.reduce((s, r) => s + r.count, 0), rows.reduce((s, r) => s + r.amount, 0)]);
  dTotal.eachCell((c) => { c.font = { bold: true }; });
  dTotal.getCell(5).numFmt = MONEY;
  det.columns = [{ width: 26 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 15 }];
  det.views = [{ state: 'frozen', ySplit: 3 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The Leads page as a workbook (owner 2026-09-21: "in leads page - get me a
 * download button to download the leads report in excel").
 *
 *   Summary       — counts and expected amount by status, what they want, source
 *   Leads         — one row per lead, with what the table hides: who created it,
 *                   the branch, what it converted into, and where follow-up stands
 *   App prospects — the page's other tab: app profiles with no investment yet
 *
 * Phone numbers are written as TEXT. As numbers Excel turns 9787239640 into
 * 9.79E+09 and drops a leading zero, and a phone list nobody can dial is worse
 * than none.
 */
export async function leadsReportXlsx(
  leads: import('../leads/service.js').LeadReportRow[],
  prospects: Array<{ customer_code: string; full_name: string; phone: string | null; district: string | null; kyc_status: string | null; created_at: string }>,
  asOf: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';
  const interest = (l: (typeof leads)[number]) => (l.lead_type === 'locker' ? 'Locker' : 'NCD');
  const want = (l: (typeof leads)[number]) =>
    (l.lead_type === 'locker' ? (l.locker_size ?? '') : (l.interested_scheme ?? ''));
  const amt = (l: (typeof leads)[number]) => Number(l.expected_amount ?? 0);

  // ── Summary ────────────────────────────────────────────────────────────────
  const sum = wb.addWorksheet('Summary');
  sum.addRow(['Leads report']).font = { bold: true, size: 14 };
  sum.addRow([`As on ${ddmmyyyy(asOf)} · ${leads.length} lead${leads.length === 1 ? '' : 's'}`]);
  sum.addRow([]);
  const group = (title: string, keyOf: (l: (typeof leads)[number]) => string) => {
    sum.addRow([title, 'Leads', 'Expected Amount']).eachCell((c) => { c.font = { bold: true }; });
    const m = new Map<string, { n: number; amt: number }>();
    for (const l of leads) {
      const k = keyOf(l) || '(not set)';
      const e = m.get(k) ?? { n: 0, amt: 0 };
      e.n += 1; e.amt += amt(l);
      m.set(k, e);
    }
    for (const [k, e] of [...m.entries()].sort((a, b) => b[1].n - a[1].n)) sum.addRow([k, e.n, e.amt]);
    sum.addRow([]);
  };
  if (leads.length) {
    group('Status', (l) => l.status);
    group('Interested in', interest);
    group('Source', (l) => l.source ?? '');
    const t = sum.addRow(['TOTAL', leads.length, leads.reduce((x, l) => x + amt(l), 0)]);
    t.eachCell((c) => { c.font = { bold: true }; });
  } else {
    sum.addRow(['There are no leads to report.']);
  }
  sum.columns = [{ width: 30 }, { width: 10 }, { width: 18, style: { numFmt: money } }];

  // ── Leads ──────────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Leads');
  ws.addRow([
    'Created On', 'Name', 'Phone', 'Place', 'District', 'Category', 'Source', 'Referred By',
    'Interested In', 'Scheme / Locker Size', 'Expected Amount', 'Follow-up Date', 'Status',
    'Created By', 'Branch', 'Converted To', 'Notes', 'Follow-up Notes', 'Latest Note', 'Latest Note On',
  ]).eachCell((c) => { c.font = { bold: true }; });
  for (const l of leads) {
    ws.addRow([
      ddmmyyyy(l.created_on), l.full_name, l.phone ?? '', l.place ?? '', l.district ?? '',
      l.category ?? '', l.source ?? '', l.referred_by_text ?? '',
      interest(l), want(l), l.expected_amount == null ? '' : amt(l), ddmmyyyy(l.follow_up_date), l.status,
      l.created_by ?? '', l.branch ?? '', l.converted_customer_code ?? '',
      l.notes ?? '', l.note_count, l.last_note ?? '', ddmmyyyy(l.last_note_on),
    ]);
  }
  if (!leads.length) ws.addRow(['There are no leads to report.']);
  ws.columns = [
    { width: 12 }, { width: 26 }, { width: 14, style: { numFmt: '@' } }, { width: 16 }, { width: 14 },
    { width: 14 }, { width: 16 }, { width: 18 }, { width: 12 }, { width: 20 },
    { width: 16, style: { numFmt: money } }, { width: 14 }, { width: 14 },
    { width: 22 }, { width: 16 }, { width: 14 }, { width: 40 }, { width: 10 }, { width: 50 }, { width: 14 },
  ];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (leads.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 20 } };

  // ── App prospects ──────────────────────────────────────────────────────────
  const ap = wb.addWorksheet('App prospects');
  ap.addRow(['Customer Code', 'Name', 'Phone', 'District', 'KYC', 'Added On'])
    .eachCell((c) => { c.font = { bold: true }; });
  for (const p of prospects) {
    ap.addRow([p.customer_code, p.full_name, p.phone ?? '', p.district ?? '', p.kyc_status ?? '',
      ddmmyyyy(String(p.created_at).slice(0, 10))]);
  }
  if (!prospects.length) ap.addRow(['No app prospects.']);
  ap.columns = [{ width: 15 }, { width: 26 }, { width: 14, style: { numFmt: '@' } }, { width: 14 }, { width: 12 }, { width: 12 }];
  ap.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}
