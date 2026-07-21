/** SOA PDF, TDS register, and full DB dump (docs/06 §5). */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import type { Db } from '../../db/types.js';
import { renderPdf, letterhead } from '../../lib/pdf.js';
import { formatINR } from '@new-wealth/shared';
import { getSettingsMap } from '../settings/service.js';
import { errors } from '../../lib/errors.js';
import { toISODate } from '../../lib/dates.js';

// pdfkit's built-in Helvetica has no ₹ (U+20B9) glyph — it renders as a stray
// "¹". Money in generated PDFs uses an ASCII-safe "Rs " prefix instead.
const inrPdf = (n: number): string => formatINR(n).replace('₹', 'Rs ');

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

/** Bond (NCD) certificate for one allotted application. */
export async function bondCertificatePdf(db: Db, applicationId: number): Promise<Buffer> {
  const { a, lines } = await loadAppForDoc(db, applicationId);
  return renderPdf((doc) => {
    letterhead(doc, 'Non-Convertible Debenture Certificate', `${a.full_name} · ${a.customer_code}`);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Certificate for Application No: ${a.application_no}`);
    doc.text(`Series: ${a.series_name} (${a.series_code})${a.isin ? ` · ISIN ${a.isin}` : ''}`);
    doc.text(`Debenture holder: ${a.full_name}   PAN: ${a.pan ?? '—'}`);
    doc.text(`Face value / principal: ${formatINR(Number(a.total_amount))}`);
    if (a.deemed_date) doc.text(`Deemed date of allotment: ${a.deemed_date}`);
    if (a.allotment_date) doc.text(`Allotment date: ${a.allotment_date}`);
    if (a.maturity_date) doc.text(`Redemption (maturity) date: ${a.maturity_date}`);
    doc.moveDown(0.6).font('Helvetica-Bold').text('Debenture details').font('Helvetica').fontSize(9);
    for (const l of lines) doc.text(`${l.scheme_name ?? '—'}   ${formatINR(Number(l.amount))}   ${Number(l.coupon_rate_pct)}% p.a.   ${l.tenure_months} months   ${l.payout_frequency}`);
    if (!lines.length) doc.fillColor('#6b7380').text('None');
    doc.moveDown(1.2).fillColor('#6b7380').fontSize(8).text('This certificate is issued by Dhanam Investment and Finance Private Limited and evidences the debentures allotted against the above application. Subject to the terms of the Debenture Trust Deed / offer document.');
  });
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

/** Filled subscription application form — the applicant, investment, payment,
 * demat, bank and nominee details captured at enrolment, as a printable PDF. */
export async function applicationFormPdf(db: Db, applicationId: number): Promise<Buffer> {
  const a = (await db.query<Record<string, unknown>>(
    `SELECT a.customer_id, a.application_no, a.status, a.total_amount, a.date_money_received, a.amount_received,
            a.collection_method, a.collection_reference, a.referred_by_text, a.created_at,
            c.full_name, c.customer_code, c.pan, c.dob, c.gender, c.father_name, c.occupation,
            c.email, c.phone, c.phone_secondary, c.address, c.depository, c.demat_dp_id, c.demat_client_id,
            s.code AS series_code, s.name AS series_name, s.isin
       FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
      WHERE a.id = $1`, [applicationId])).rows[0];
  if (!a) throw errors.notFound('Application not found');
  const lines = (await db.query<Record<string, unknown>>(
    `SELECT al.amount, al.coupon_rate_pct, al.tenure_months, al.payout_frequency, sch.name AS scheme_name
       FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
      WHERE al.application_id = $1 ORDER BY al.id`, [applicationId])).rows;
  const nominees = (await db.query<Record<string, unknown>>(
    'SELECT full_name, relationship, share_pct, dob FROM nominees WHERE customer_id = $1 ORDER BY id', [a.customer_id])).rows;
  const bank = (await db.query<Record<string, unknown>>(
    'SELECT holder_name, account_number, ifsc, bank_name, branch_name FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY is_active DESC, id LIMIT 1', [a.customer_id])).rows[0];

  return renderPdf((doc) => {
    letterhead(doc, 'NCD Subscription Application', `${a.application_no}${a.created_at ? `  ·  ${toISODate(a.created_at as string | Date | null) ?? ''}` : ''}`);
    const kv = (label: string, value: unknown) =>
      doc.font('Helvetica').fontSize(9).fillColor('#1a1d23').text(`${label}:   ${value == null || value === '' ? '—' : String(value)}`, { width: 500 });
    const section = (t: string) => { doc.moveDown(0.55).font('Helvetica-Bold').fontSize(10.5).fillColor('#0b3a6f').text(t); doc.moveDown(0.15).fillColor('#1a1d23'); };

    section('Applicant');
    kv('Name', a.full_name);
    kv('Customer code', a.customer_code);
    kv('PAN', a.pan);
    kv('Date of birth', toISODate(a.dob as string | Date | null));
    kv('Gender', a.gender);
    kv('Father / Guardian', a.father_name);
    kv('Occupation', a.occupation);
    kv('Phone', [a.phone, a.phone_secondary].filter(Boolean).join(' / '));
    kv('Email', a.email);
    kv('Address', a.address);

    section('Investment');
    kv('Series', `${a.series_name} (${a.series_code})${a.isin ? ` · ISIN ${a.isin}` : ''}`);
    kv('Total amount', inrPdf(Number(a.total_amount)));
    for (const l of lines) doc.font('Helvetica').fontSize(9).text(`   •  ${l.scheme_name ?? '—'}  ·  ${inrPdf(Number(l.amount))}  ·  ${Number(l.coupon_rate_pct)}% p.a.  ·  ${l.tenure_months} months  ·  ${l.payout_frequency}`);
    kv('Referred by', a.referred_by_text);

    section('Payment');
    kv('Amount received', a.amount_received != null ? inrPdf(Number(a.amount_received)) : '—');
    kv('Mode', a.collection_method);
    kv('Reference / UTR', a.collection_reference);
    kv('Date received', toISODate(a.date_money_received as string | Date | null));

    section('Demat account');
    kv('Depository', a.depository);
    kv('DP ID', a.demat_dp_id);
    kv('Client ID', a.demat_client_id);

    section('Bank account (for payouts)');
    if (bank) {
      kv('Account holder', bank.holder_name);
      kv('Account number', bank.account_number);
      kv('IFSC', bank.ifsc);
      kv('Bank', [bank.bank_name, bank.branch_name].filter(Boolean).join(' · '));
    } else doc.font('Helvetica').fillColor('#6b7380').fontSize(9).text('   Not provided').fillColor('#1a1d23');

    section('Nominee(s)');
    if (nominees.length) for (const n of nominees)
      doc.font('Helvetica').fillColor('#1a1d23').fontSize(9).text(`   •  ${n.full_name}${n.relationship ? ` (${n.relationship})` : ''}${n.share_pct != null ? ` — ${Number(n.share_pct)}%` : ''}${n.dob ? `  ·  DOB ${toISODate(n.dob as string | Date | null)}` : ''}`);
    else doc.font('Helvetica').fillColor('#6b7380').fontSize(9).text('   None').fillColor('#1a1d23');

    doc.moveDown(1).fillColor('#6b7380').fontSize(8.5).text('Declaration: I/We hereby apply for the above Non-Convertible Debentures and confirm that the particulars stated are true and correct. I/We have read and understood the terms of the issue.', { width: 500 });
    doc.moveDown(1.4).fillColor('#1a1d23').fontSize(9).text('Signature of applicant:  ______________________________');
  });
}

/** TDS register for a month (YYYY-MM) — one row per TDS-bearing payout. */
export async function tdsReport(db: Db, yyyymm: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`TDS ${yyyymm}`);
  ws.addRow(['Customer', 'PAN', 'Application', 'Due date', 'Gross', 'TDS', 'Net']).eachCell((c) => { c.font = { bold: true }; });
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT c.full_name, c.pan, a.application_no, ds.due_date, ds.gross_amount, ds.tds_amount, ds.net_amount
     FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ds.tds_amount > 0 AND to_char(ds.due_date,'YYYY-MM') = $1 ORDER BY c.full_name`, [yyyymm])).rows;
  for (const r of rows) ws.addRow([r.full_name, r.pan, r.application_no, r.due_date, Number(r.gross_amount), Number(r.tds_amount), Number(r.net_amount)]);
  [5, 6, 7].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
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
  ];
  ws.addRow(HEADERS).eachCell((c) => { c.font = { bold: true }; });

  const rows = (await db.query<Record<string, unknown>>(
    `SELECT c.full_name, c.pan, ds.due_date, ds.gross_amount, ds.tds_amount
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
    ]);
  }
  [6, 7, 8, 9, 10, 11].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 20; });
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
