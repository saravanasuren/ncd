/**
 * The owner's NCD book export (docs/06 §3): 9 business-report tabs + 2 raw-data
 * tabs (Applications register, Interest Payouts ledger) so the workbook also
 * serves as a human-readable data snapshot. Built with exceljs from the shared
 * book queries, so tab totals reconcile with the dashboard under the same
 * filters + scope. Indian number format throughout.
 *
 * STREAMS to the response (ExcelJS.stream.xlsx.WorkbookWriter): rows are flushed
 * as they're written, so memory stays flat even for the ~tens-of-thousands-row
 * Interest Payouts ledger. (Buffering the whole workbook OOM-killed the 512M
 * service on the real book.)
 */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import * as book from './book.js';

const INR = '#,##,##0.00';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A6F' } };
const SUBTOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4E7EC' } };

interface ColDef { header: string; width: number; money?: boolean }

type WB = ExcelJS.stream.xlsx.WorkbookWriter;
type WS = ExcelJS.Worksheet;

/** New sheet with a styled, frozen header row (committed) and column widths/formats. */
function startSheet(wb: WB, title: string, cols: ColDef[]): WS {
  // Streaming worksheets take `views` as a creation option (the property is read-only).
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({
    header: c.header, width: c.width,
    style: c.money ? { numFmt: INR, alignment: { horizontal: 'right' } } : {},
  }));
  const hdr = ws.getRow(1);
  hdr.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  hdr.commit();
  return ws;
}
function subtotalRow(ws: WS, values: unknown[]) {
  const r = ws.addRow(values);
  r.eachCell((c) => { c.fill = SUBTOTAL_FILL; c.font = { bold: true }; });
  r.commit();
}
function boldRow(ws: WS, values: unknown[]) {
  const r = ws.addRow(values);
  r.eachCell((c) => { c.font = { bold: true }; });
  r.commit();
}

/** Grouped pivot: group → item → amount, per-group subtotals + grand total. */
async function groupedSheet(
  wb: WB, title: string, groupHeader: string, itemHeader: string,
  rows: Array<{ group: string; item: string; amount: number }>, negate = false
) {
  const ws = startSheet(wb, title, [{ header: groupHeader, width: 28 }, { header: itemHeader, width: 34 }, { header: 'Amount', width: 16, money: true }]);
  const byGroup = new Map<string, Array<{ item: string; amount: number }>>();
  for (const r of rows) {
    const a = negate ? -Math.abs(r.amount) : r.amount;
    (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push({ item: r.item, amount: a });
  }
  let grand = 0;
  for (const [group, items] of byGroup) {
    let sub = 0;
    for (const it of items) { ws.addRow([group, it.item, it.amount]).commit(); sub += it.amount; }
    subtotalRow(ws, [`${group} Total`, '', sub]); grand += sub;
  }
  boldRow(ws, ['Grand Total', '', grand]);
  await ws.commit();
}

export async function buildNcdBook(out: Writable, db: Db, actor: AuthUser, filters: book.BookFilters = {}): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'Dhanam NCD';

  // Tab 1 — Ongoing NCD: for each non-withdrawn series, agent → customer.
  const series = await book.seriesSummary(db, actor, {}) as Array<{ series_id: number; code: string; status: string } & Record<string, unknown>>;
  const ws1 = startSheet(wb, 'Ongoing NCD', [{ header: 'NCD Series', width: 16 }, { header: 'Agent', width: 26 }, { header: 'Customer', width: 30 }, { header: 'Amount', width: 16, money: true }]);
  let ongGrand = 0;
  for (const s of series) {
    if (s.status === 'Withdrawn') continue;
    const pivot = await book.ongoingSeriesPivot(db, actor, s.series_id) as Array<{ agent: string; customer: string; amount: string }>;
    if (!pivot.length) continue;
    const byAgent = new Map<string, Array<{ customer: string; amount: number }>>();
    for (const p of pivot) (byAgent.get(p.agent) ?? byAgent.set(p.agent, []).get(p.agent)!).push({ customer: p.customer, amount: Number(p.amount) });
    for (const [agent, items] of byAgent) {
      let sub = 0;
      for (const it of items) { ws1.addRow([s.code, agent, it.customer, it.amount]).commit(); sub += it.amount; }
      subtotalRow(ws1, [s.code, `${agent} Total`, '', sub]); ongGrand += sub;
    }
  }
  boldRow(ws1, ['Grand Total', '', '', ongGrand]);
  await ws1.commit();

  // Tab 2 — NCD Summary
  const ws2 = startSheet(wb, 'NCD Summary', [{ header: 'NCD Series', width: 16 }, { header: 'Status', width: 12 }, { header: 'Investors', width: 12 }, { header: 'Issued', width: 16, money: true }, { header: 'Redeemed', width: 16, money: true }, { header: 'Outstanding', width: 16, money: true }]);
  let ti = 0, tr = 0, to = 0;
  for (const s of series) {
    ws2.addRow([s.code, s.status, Number(s.investors), Number(s.issued), -Number(s.redeemed), Number(s.outstanding)]).commit();
    ti += Number(s.issued); tr += Number(s.redeemed); to += Number(s.outstanding);
  }
  boldRow(ws2, ['Grand Total', '', '', ti, -tr, to]);
  await ws2.commit();

  // Tab 3 — Master Client
  const ws3 = startSheet(wb, 'Master Client', [{ header: 'PAN', width: 14 }, { header: 'Sl. No', width: 8 }, { header: 'Agent Code', width: 18 }, { header: 'Name', width: 28 }, { header: 'Phone', width: 14 }, { header: 'District', width: 16 }, { header: 'Address', width: 40 }]);
  const clients = await book.masterClient(db, actor) as Array<Record<string, unknown>>;
  clients.forEach((c, i) => ws3.addRow([c.pan ?? '', i + 1, c.agent_code ?? '', c.name, c.phone ?? '', c.district ?? '', c.address ?? '']).commit());
  await ws3.commit();

  // Tab 4 — Redemption (date-grouped, negative)
  const reds = await book.redemptions(db, actor, filters) as Array<Record<string, unknown>>;
  await groupedSheet(wb, 'Redemption', 'Date', 'Customer',
    reds.map((r) => ({ group: String(r.redemption_date), item: `${r.series_code} · ${r.customer_name}`, amount: Number(r.net_payment) })), true);

  // Tab 5 — Depositorwise
  const ws5 = startSheet(wb, 'Depositorwise', [{ header: 'Name', width: 34 }, { header: 'Amount', width: 16, money: true }]);
  const deps = await book.depositorwise(db, actor, filters) as Array<{ name: string; amount: string }>;
  let depGrand = 0;
  for (const d of deps) { ws5.addRow([d.name, Number(d.amount)]).commit(); depGrand += Number(d.amount); }
  boldRow(ws5, ['Grand Total', depGrand]);
  await ws5.commit();

  // Tab 6 — Districtwise
  const dist = await book.districtwise(db, actor, filters) as Array<{ district: string; amount: string }>;
  await groupedSheet(wb, 'Districtwise', 'District', 'Sub', dist.map((d) => ({ group: d.district, item: '', amount: Number(d.amount) })));

  // Tab 7 — Agent wise
  const agents = await book.agentwise(db, actor, filters) as Array<{ agent: string; customer: string; amount: string }>;
  await groupedSheet(wb, 'Agent wise', 'Agent Code', 'Name', agents.map((a) => ({ group: a.agent, item: a.customer, amount: Number(a.amount) })));

  // Tab 8 — Staff wise
  const staff = await book.staffwise(db, actor, filters) as Array<{ staff: string; customer: string; amount: string }>;
  await groupedSheet(wb, 'Staff wise', 'Staff', 'Name', staff.map((s) => ({ group: s.staff, item: s.customer, amount: Number(s.amount) })));

  // Tab 9 — Leads by status
  const ws9 = startSheet(wb, 'Leads', [{ header: 'Status', width: 14 }, { header: 'Name', width: 26 }, { header: 'Phone', width: 14 }, { header: 'Place', width: 16 }, { header: 'Source', width: 14 }, { header: 'Interested', width: 18 }, { header: 'Expected', width: 14, money: true }, { header: 'Follow-up', width: 14 }]);
  const leads = await book.leadsByStatus(db, actor) as Array<Record<string, unknown>>;
  const byStatus = new Map<string, Array<Record<string, unknown>>>();
  for (const l of leads) (byStatus.get(String(l.status)) ?? byStatus.set(String(l.status), []).get(String(l.status))!).push(l);
  for (const [status, items] of byStatus) {
    let sum = 0;
    for (const l of items) { ws9.addRow([status, l.full_name, l.phone ?? '', l.place ?? '', l.source ?? '', l.interested_scheme ?? '', Number(l.expected_amount ?? 0), l.follow_up_date ?? '']).commit(); sum += Number(l.expected_amount ?? 0); }
    subtotalRow(ws9, [`${status} Total (${items.length})`, '', '', '', '', '', sum, '']);
  }
  await ws9.commit();

  // Tab 10 — Applications (flat register)
  const ws10 = startSheet(wb, 'Applications', [{ header: 'App No', width: 16 }, { header: 'Customer Code', width: 14 }, { header: 'Customer', width: 28 }, { header: 'Series', width: 12 }, { header: 'Status', width: 16 }, { header: 'Amount', width: 15, money: true }, { header: 'Coupon %', width: 9 }, { header: 'Tenure (m)', width: 10 }, { header: 'Frequency', width: 12 }, { header: 'Money received', width: 14 }, { header: 'Allotment', width: 13 }, { header: 'Maturity', width: 13 }, { header: 'Redemption', width: 13 }]);
  const apps = await book.applicationsFlat(db, actor, filters) as Array<Record<string, unknown>>;
  for (const a of apps) {
    ws10.addRow([a.application_no, a.customer_code ?? '', a.customer, a.series_code, a.status, Number(a.total_amount),
      a.coupon_rate_pct != null ? Number(a.coupon_rate_pct) : '', a.tenure_months ?? '', a.payout_frequency ?? '',
      a.date_money_received ?? '', a.allotment_date ?? '', a.maturity_date ?? '', a.redemption_date ?? '']).commit();
  }
  await ws10.commit();

  // Tab 11 — Interest Payouts (full disbursement ledger — can be tens of thousands of rows)
  const ws11 = startSheet(wb, 'Interest Payouts', [{ header: 'Due Date', width: 12 }, { header: 'App No', width: 16 }, { header: 'Customer Code', width: 14 }, { header: 'Customer', width: 28 }, { header: 'Series', width: 12 }, { header: 'Type', width: 14 }, { header: 'Gross', width: 14, money: true }, { header: 'TDS', width: 12, money: true }, { header: 'Net', width: 14, money: true }, { header: 'Status', width: 12 }, { header: 'Paid At', width: 12 }, { header: 'UTR', width: 18 }]);
  const ledger = await book.interestLedger(db, actor) as Array<Record<string, unknown>>;
  for (const r of ledger) {
    ws11.addRow([r.due_date, r.application_no, r.customer_code ?? '', r.customer, r.series_code, r.due_type,
      Number(r.gross_amount), Number(r.tds_amount), Number(r.net_amount), r.status, r.paid_at ?? '', r.utr ?? '']).commit();
  }
  await ws11.commit();

  await wb.commit(); // finalise the zip + end the stream
}
