/**
 * The owner's NCD book export (docs/06 §3). Tabs, in order:
 *   NCD Summary · NCD by Series · Master Client · Redemption · Depositorwise ·
 *   Districtwise · Agent wise · Staff wise · Leads · Applications · Interest Payouts
 * The grouped sheets use Excel row-outlining: a summary row per group with its
 * individual investments collapsed underneath (click the + in Excel's margin).
 * STREAMS to the response so memory stays flat even for the tens-of-thousands-row
 * Interest Payouts ledger. Built from the shared book queries, so tab totals
 * reconcile with the dashboard under the same filters + scope.
 */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import * as book from './book.js';

const INR = '#,##,##0.00';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A6F' } };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface ColDef { header: string; width: number; money?: boolean }
type WB = ExcelJS.stream.xlsx.WorkbookWriter;
type WS = ExcelJS.Worksheet;

/** 'YYYY-MM-DD…' → 'Mmm DD YYYY'. */
function fmtDate(v: unknown): string {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[3]} ${m[1]}` : s;
}
/** Descending by the number embedded in a series code (NCD_27 → NCD_10). */
const seriesDesc = (a: { code?: string; label?: string }, b: { code?: string; label?: string }) =>
  String(b.code ?? b.label).localeCompare(String(a.code ?? a.label), undefined, { numeric: true });

function startSheet(wb: WB, title: string, cols: ColDef[]): WS {
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width, style: c.money ? { numFmt: INR, alignment: { horizontal: 'right' } } : {} }));
  const hdr = ws.getRow(1);
  hdr.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  hdr.commit();
  return ws;
}
function boldRow(ws: WS, values: unknown[]) {
  const r = ws.addRow(values); r.eachCell((c) => { c.font = { bold: true }; }); r.commit();
}

interface OutlineGroup { summary: unknown[]; details: unknown[][] }
/** Grouped sheet with collapsible Excel outlining: bold summary row (level 0),
 * detail rows collapsed underneath (level 1, hidden). Optional grand total. */
async function outlineSheet(wb: WB, title: string, cols: ColDef[], groups: OutlineGroup[], grandTotal?: unknown[]) {
  const ws = startSheet(wb, title, cols);
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  for (const g of groups) {
    const sr = ws.addRow(g.summary); sr.eachCell((c) => { c.font = { bold: true }; }); sr.commit();
    for (const d of g.details) { const dr = ws.addRow(d); dr.outlineLevel = 1; dr.hidden = true; dr.commit(); }
  }
  if (grandTotal) boldRow(ws, grandTotal);
  await ws.commit();
}

export async function buildNcdBook(out: Writable, db: Db, actor: AuthUser, filters: book.BookFilters = {}): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'Dhanam NCD';

  // Tab 1 — NCD Summary (series desc)
  const series = (await book.seriesSummary(db, actor, {}) as Array<Record<string, unknown>>).slice().sort(seriesDesc as any);
  const ws1 = startSheet(wb, 'NCD Summary', [{ header: 'NCD Series', width: 16 }, { header: 'Status', width: 12 }, { header: 'Investors', width: 12 }, { header: 'Issued', width: 16, money: true }, { header: 'Redeemed', width: 16, money: true }, { header: 'Outstanding', width: 16, money: true }]);
  let ti = 0, tr = 0, to = 0;
  for (const s of series) {
    ws1.addRow([s.code, s.status, Number(s.investors), Number(s.issued), -Number(s.redeemed), Number(s.outstanding)]).commit();
    ti += Number(s.issued); tr += Number(s.redeemed); to += Number(s.outstanding);
  }
  boldRow(ws1, ['Grand Total', '', '', ti, -tr, to]);
  await ws1.commit();

  // Tab 2 — NCD by Series (series desc; expand a series → its investments)
  const bySeries = (await book.segmentGrouped(db, actor, 'series', filters)).slice().sort((a, b) => seriesDesc(a as any, b as any));
  await outlineSheet(wb, 'NCD by Series',
    [{ header: 'Series', width: 14 }, { header: 'Customer', width: 28 }, { header: 'App No', width: 16 }, { header: 'Status', width: 14 }, { header: 'Amount', width: 16, money: true }, { header: 'Investors', width: 10 }, { header: 'NCDs', width: 8 }],
    bySeries.map((g) => ({
      summary: [g.label, '', '', '', g.outstanding, g.investors, g.investments],
      details: g.children.map((c) => ['', c.customer, c.application_no, c.status, c.amount, '', '']),
    })));

  // Tab 3 — Master Client
  const ws3 = startSheet(wb, 'Master Client', [{ header: 'PAN', width: 14 }, { header: 'Sl. No', width: 8 }, { header: 'Agent Code', width: 18 }, { header: 'Name', width: 28 }, { header: 'Phone', width: 14 }, { header: 'District', width: 16 }, { header: 'Address', width: 40 }]);
  const clients = await book.masterClient(db, actor) as Array<Record<string, unknown>>;
  clients.forEach((c, i) => ws3.addRow([c.pan ?? '', i + 1, c.agent_code ?? '', c.name, c.phone ?? '', c.district ?? '', c.address ?? '']).commit());
  await ws3.commit();

  // Tab 4 — Redemption (by date desc; date only, 'Mmm DD YYYY')
  const reds = await book.redemptions(db, actor, filters) as Array<Record<string, unknown>>;
  const redByDate = new Map<string, Array<Record<string, unknown>>>();
  for (const r of reds) (redByDate.get(String(r.redemption_date)) ?? redByDate.set(String(r.redemption_date), []).get(String(r.redemption_date))!).push(r);
  const redGroups = [...redByDate.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0]))).map(([date, items]) => ({
    summary: [fmtDate(date), '', '', '', items.reduce((s, r) => s + Number(r.net_payment), 0)],
    details: items.map((r) => ['', r.customer_name, r.series_code, r.type, Number(r.net_payment)]),
  }));
  await outlineSheet(wb, 'Redemption',
    [{ header: 'Date', width: 14 }, { header: 'Customer', width: 28 }, { header: 'Series', width: 12 }, { header: 'Type', width: 14 }, { header: 'Amount', width: 16, money: true }],
    redGroups);

  // Tab 5 — Depositorwise (amount desc; expand a customer → their investments)
  const byCust = await book.segmentGrouped(db, actor, 'customer', filters); // already amount-desc
  await outlineSheet(wb, 'Depositorwise',
    [{ header: 'Customer', width: 28 }, { header: 'Customer ID', width: 14 }, { header: 'Series', width: 12 }, { header: 'App No', width: 16 }, { header: 'Status', width: 14 }, { header: 'Amount', width: 16, money: true }],
    byCust.map((g) => ({
      summary: [g.label, g.sublabel ?? '', '', '', '', g.outstanding],
      details: g.children.map((c) => ['', '', c.series_code, c.application_no, c.status, c.amount]),
    })),
    ['Grand Total', '', '', '', '', byCust.reduce((s, g) => s + g.outstanding, 0)]);

  // Tabs 6-8 — District / Agent / Staff wise (amount desc; expand → investments)
  for (const [by, title, head] of [['district', 'Districtwise', 'District'], ['agent', 'Agent wise', 'Agent'], ['staff', 'Staff wise', 'Staff']] as const) {
    const groups = await book.segmentGrouped(db, actor, by, filters); // amount-desc
    await outlineSheet(wb, title,
      [{ header: head, width: 22 }, { header: 'Customer', width: 28 }, { header: 'Series', width: 12 }, { header: 'App No', width: 16 }, { header: 'Amount', width: 16, money: true }, { header: 'Investors', width: 10 }],
      groups.map((g) => ({
        summary: [g.label, '', '', '', g.outstanding, g.investors],
        details: g.children.map((c) => ['', c.customer, c.series_code, c.application_no, c.amount, '']),
      })),
      ['Grand Total', '', '', '', groups.reduce((s, g) => s + g.outstanding, 0), '']);
  }

  // Tab 9 — Leads by status
  const ws9 = startSheet(wb, 'Leads', [{ header: 'Status', width: 14 }, { header: 'Name', width: 26 }, { header: 'Phone', width: 14 }, { header: 'Place', width: 16 }, { header: 'Source', width: 14 }, { header: 'Interested', width: 18 }, { header: 'Expected', width: 14, money: true }, { header: 'Follow-up', width: 14 }]);
  const leads = await book.leadsByStatus(db, actor) as Array<Record<string, unknown>>;
  const byStatus = new Map<string, Array<Record<string, unknown>>>();
  for (const l of leads) (byStatus.get(String(l.status)) ?? byStatus.set(String(l.status), []).get(String(l.status))!).push(l);
  for (const [status, items] of byStatus) {
    let sum = 0;
    for (const l of items) { ws9.addRow([status, l.full_name, l.phone ?? '', l.place ?? '', l.source ?? '', l.interested_scheme ?? '', Number(l.expected_amount ?? 0), l.follow_up_date ?? '']).commit(); sum += Number(l.expected_amount ?? 0); }
    boldRow(ws9, [`${status} Total (${items.length})`, '', '', '', '', '', sum, '']);
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
