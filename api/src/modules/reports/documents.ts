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
