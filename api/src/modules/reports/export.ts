/**
 * The owner's 9-tab NCD book export (docs/06 §3). Built with exceljs from the
 * shared book queries, so tab totals reconcile with the dashboard under the
 * same filters + scope. Indian number format throughout.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import * as book from './book.js';

const INR = '#,##,##0.00';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A6F' } };
const SUBTOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4E7EC' } };

function headerRow(ws: ExcelJS.Worksheet, cols: string[]) {
  const row = ws.addRow(cols);
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function amountCol(ws: ExcelJS.Worksheet, colIndex: number) {
  ws.getColumn(colIndex).numFmt = INR;
  ws.getColumn(colIndex).alignment = { horizontal: 'right' };
}

/** Grouped pivot: group → item → amount, with per-group subtotals + grand total. */
function groupedSheet(
  wb: ExcelJS.Workbook, title: string, groupHeader: string, itemHeader: string,
  rows: Array<{ group: string; item: string; amount: number }>, negate = false
) {
  const ws = wb.addWorksheet(title);
  headerRow(ws, [groupHeader, itemHeader, 'Amount']);
  const byGroup = new Map<string, Array<{ item: string; amount: number }>>();
  for (const r of rows) {
    const a = negate ? -Math.abs(r.amount) : r.amount;
    (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push({ item: r.item, amount: a });
  }
  let grand = 0;
  for (const [group, items] of byGroup) {
    let sub = 0;
    for (const it of items) { ws.addRow([group, it.item, it.amount]); sub += it.amount; }
    const subRow = ws.addRow([`${group} Total`, '', sub]);
    subRow.eachCell((c) => { c.fill = SUBTOTAL_FILL; c.font = { bold: true }; });
    grand += sub;
  }
  const g = ws.addRow(['Grand Total', '', grand]);
  g.eachCell((c) => { c.font = { bold: true }; });
  ws.columns = [{ width: 28 }, { width: 34 }, { width: 16 }];
  amountCol(ws, 3);
  return ws;
}

export async function buildNcdBook(db: Db, actor: AuthUser, filters: book.BookFilters = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dhanam NCD';

  // Tab 1 — Ongoing NCD: for each non-redeemed series, agent → customer.
  const series = await book.seriesSummary(db, actor, {});
  const ws1 = wb.addWorksheet('Ongoing NCD');
  headerRow(ws1, ['NCD Series', 'Agent', 'Customer', 'Amount']);
  let ongGrand = 0;
  for (const s of series as Array<{ series_id: number; code: string; status: string }>) {
    if (s.status === 'Withdrawn') continue;
    const pivot = await book.ongoingSeriesPivot(db, actor, s.series_id) as Array<{ agent: string; customer: string; amount: string }>;
    if (!pivot.length) continue;
    const byAgent = new Map<string, Array<{ customer: string; amount: number }>>();
    for (const p of pivot) (byAgent.get(p.agent) ?? byAgent.set(p.agent, []).get(p.agent)!).push({ customer: p.customer, amount: Number(p.amount) });
    for (const [agent, items] of byAgent) {
      let sub = 0;
      for (const it of items) { ws1.addRow([s.code, agent, it.customer, it.amount]); sub += it.amount; }
      const r = ws1.addRow([s.code, `${agent} Total`, '', sub]); r.eachCell((c) => { c.fill = SUBTOTAL_FILL; c.font = { bold: true }; });
      ongGrand += sub;
    }
  }
  ws1.addRow(['Grand Total', '', '', ongGrand]).eachCell((c) => { c.font = { bold: true }; });
  ws1.columns = [{ width: 16 }, { width: 26 }, { width: 30 }, { width: 16 }];
  amountCol(ws1, 4);

  // Tab 2 — NCD Summary
  const ws2 = wb.addWorksheet('NCD Summary');
  headerRow(ws2, ['NCD Series', 'Status', 'Investors', 'Issued', 'Redeemed', 'Outstanding']);
  let ti = 0, tr = 0, to = 0;
  for (const s of series as Array<Record<string, unknown>>) {
    ws2.addRow([s.code, s.status, Number(s.investors), Number(s.issued), -Number(s.redeemed), Number(s.outstanding)]);
    ti += Number(s.issued); tr += Number(s.redeemed); to += Number(s.outstanding);
  }
  ws2.addRow(['Grand Total', '', '', ti, -tr, to]).eachCell((c) => { c.font = { bold: true }; });
  ws2.columns = [{ width: 16 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 16 }];
  [4, 5, 6].forEach((i) => amountCol(ws2, i));

  // Tab 3 — Master Client
  const ws3 = wb.addWorksheet('Master Client');
  headerRow(ws3, ['PAN', 'Sl. No', 'Agent Code', 'Name', 'Phone', 'District', 'Address']);
  const clients = await book.masterClient(db, actor) as Array<Record<string, unknown>>;
  clients.forEach((c, i) => ws3.addRow([c.pan ?? '', i + 1, c.agent_code ?? '', c.name, c.phone ?? '', c.district ?? '', c.address ?? '']));
  ws3.columns = [{ width: 14 }, { width: 8 }, { width: 18 }, { width: 28 }, { width: 14 }, { width: 16 }, { width: 40 }];

  // Tab 4 — Redemption (date-grouped, negative)
  const reds = await book.redemptions(db, actor, filters) as Array<Record<string, unknown>>;
  groupedSheet(wb, 'Redemption', 'Date', 'Customer',
    reds.map((r) => ({ group: String(r.redemption_date), item: `${r.series_code} · ${r.customer_name}`, amount: Number(r.net_payment) })), true);

  // Tab 5 — Depositorwise
  const ws5 = wb.addWorksheet('Depositorwise');
  headerRow(ws5, ['Name', 'Amount']);
  const deps = await book.depositorwise(db, actor, filters) as Array<{ name: string; amount: string }>;
  let depGrand = 0;
  for (const d of deps) { ws5.addRow([d.name, Number(d.amount)]); depGrand += Number(d.amount); }
  ws5.addRow(['Grand Total', depGrand]).eachCell((c) => { c.font = { bold: true }; });
  ws5.columns = [{ width: 34 }, { width: 16 }]; amountCol(ws5, 2);

  // Tab 6 — Districtwise
  const dist = await book.districtwise(db, actor, filters) as Array<{ district: string; amount: string }>;
  groupedSheet(wb, 'Districtwise', 'District', 'Sub', dist.map((d) => ({ group: d.district, item: '', amount: Number(d.amount) })));

  // Tab 7 — Agent wise
  const agents = await book.agentwise(db, actor, filters) as Array<{ agent: string; customer: string; amount: string }>;
  groupedSheet(wb, 'Agent wise', 'Agent Code', 'Name', agents.map((a) => ({ group: a.agent, item: a.customer, amount: Number(a.amount) })));

  // Tab 8 — Staff wise
  const staff = await book.staffwise(db, actor, filters) as Array<{ staff: string; customer: string; amount: string }>;
  groupedSheet(wb, 'Staff wise', 'Staff', 'Name', staff.map((s) => ({ group: s.staff, item: s.customer, amount: Number(s.amount) })));

  // Tab 9 — Leads by status
  const ws9 = wb.addWorksheet('Leads');
  headerRow(ws9, ['Status', 'Name', 'Phone', 'Place', 'Source', 'Interested', 'Expected', 'Follow-up']);
  const leads = await book.leadsByStatus(db, actor) as Array<Record<string, unknown>>;
  const byStatus = new Map<string, Array<Record<string, unknown>>>();
  for (const l of leads) (byStatus.get(String(l.status)) ?? byStatus.set(String(l.status), []).get(String(l.status))!).push(l);
  for (const [status, items] of byStatus) {
    let sum = 0;
    for (const l of items) { ws9.addRow([status, l.full_name, l.phone ?? '', l.place ?? '', l.source ?? '', l.interested_scheme ?? '', Number(l.expected_amount ?? 0), l.follow_up_date ?? '']); sum += Number(l.expected_amount ?? 0); }
    const r = ws9.addRow([`${status} Total (${items.length})`, '', '', '', '', '', sum, '']); r.eachCell((c) => { c.fill = SUBTOTAL_FILL; c.font = { bold: true }; });
  }
  ws9.columns = [{ width: 14 }, { width: 26 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 14 }, { width: 14 }];
  amountCol(ws9, 7);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
