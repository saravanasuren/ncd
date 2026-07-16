/** SOA PDF, TDS register, and full DB dump (docs/06 §5). */
import ExcelJS from 'exceljs';
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

/** Full DB dump — key tables as sheets (admin). */
export async function dumpXlsx(db: Db): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheets: [string, string][] = [
    ['Customers', 'SELECT id, customer_code, full_name, phone, district, kyc_status, creation_status FROM customers ORDER BY id'],
    ['Applications', 'SELECT id, application_no, customer_id, series_id, status, total_amount, allotment_date, maturity_date FROM applications ORDER BY id'],
    ['Schedule', "SELECT id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status FROM disbursement_schedule ORDER BY id LIMIT 25000"],
    ['Redemptions', 'SELECT id, redemption_no, application_id, type, principal, penalty, net_payment, status FROM redemptions ORDER BY id'],
  ];
  for (const [name, sql] of sheets) {
    const ws = wb.addWorksheet(name);
    const rows = (await db.query<Record<string, unknown>>(sql)).rows;
    if (rows.length) {
      ws.addRow(Object.keys(rows[0]!)).eachCell((c) => { c.font = { bold: true }; });
      for (const r of rows) ws.addRow(Object.values(r));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
