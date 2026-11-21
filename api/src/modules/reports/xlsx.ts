/**
 * Shared workbook furniture for the owner's big Excel books.
 *
 * Lifted out of export.ts when the Locker Master Report arrived, because the
 * owner asked for it "like how u have a report for ncd" — same navy header, same
 * money format, same collapsible groups. Two copies of these helpers would have
 * drifted the first time one book was restyled, and then the two books would
 * stop looking like one system.
 *
 * The sheets STREAM: a WorkbookWriter commits each row as it is added, so a
 * ledger of tens of thousands of rows never sits in memory at once.
 */
import ExcelJS from 'exceljs';

/** Indian money format — lakh/crore grouping, two decimals. */
export const INR = '#,##,##0.00';
export const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A6F' } };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ColDef { header: string; width: number; money?: boolean }
export type WB = ExcelJS.stream.xlsx.WorkbookWriter;
export type WS = ExcelJS.Worksheet;

/** 'YYYY-MM-DD…' → 'Mmm DD YYYY'. Anything unparseable is passed through. */
export function fmtDate(v: unknown): string {
  const s = String(v ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[3]} ${m[1]}` : s;
}

/** A sheet with the house header: navy fill, white bold text, frozen top row. */
export function startSheet(wb: WB, title: string, cols: ColDef[]): WS {
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({
    header: c.header,
    width: c.width,
    style: c.money ? { numFmt: INR, alignment: { horizontal: 'right' } } : {},
  }));
  const hdr = ws.getRow(1);
  hdr.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  hdr.commit();
  return ws;
}

export function boldRow(ws: WS, values: unknown[]) {
  const r = ws.addRow(values);
  r.eachCell((c) => { c.font = { bold: true }; });
  r.commit();
}

export interface OutlineGroup { summary: unknown[]; details: unknown[][] }

/**
 * Grouped sheet with collapsible Excel outlining: a bold summary row at level 0
 * and its detail rows collapsed underneath at level 1 (click the + in Excel's
 * margin). Optional grand total at the foot.
 */
export async function outlineSheet(
  wb: WB, title: string, cols: ColDef[], groups: OutlineGroup[], grandTotal?: unknown[],
) {
  const ws = startSheet(wb, title, cols);
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  for (const g of groups) {
    const sr = ws.addRow(g.summary);
    sr.eachCell((c) => { c.font = { bold: true }; });
    sr.commit();
    for (const d of g.details) { const dr = ws.addRow(d); dr.outlineLevel = 1; dr.hidden = true; dr.commit(); }
  }
  if (grandTotal) boldRow(ws, grandTotal);
  await ws.commit();
}
