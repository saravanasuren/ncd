/**
 * Escrow-statement file parser.
 *
 * SBI corporate net-banking "download as xls" is really a tab-separated text
 * file (latin1); real .xlsx and .csv are also accepted. All three are reduced to
 * a string matrix, then the preamble (account, balances, period) and the credit
 * rows are read off it. Per-line payer extraction is delegated to the shared
 * narration parser so the API and UI agree on pay-type/UTR/name.
 */
import ExcelJS from 'exceljs';
import { toPaise, parseEscrowNarration, type EscrowPayType } from '@new-wealth/shared';

export interface EscrowFileMeta {
  account_number: string | null;
  ifsc: string | null;
  period_from: string | null;
  period_to: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
}

export interface ParsedEscrowLine {
  row_no: number;
  txn_date: string | null;
  value_date: string | null;
  amount: number;               // signed rupees: credit > 0, debit < 0
  direction: 'credit' | 'debit';
  pay_type: EscrowPayType;
  utr: string | null;
  remitter_account: string | null;
  remitter_account_pooled: boolean;
  remitter_name: string | null;
  cheque_no: string | null;
  presenting_bank: string | null;
  description: string;
  ref_no: string;
  balance: number | null;
  dedupe_key: string;
}

export interface ParsedEscrowFile {
  meta: EscrowFileMeta;
  lines: ParsedEscrowLine[];
}

const isZip = (buf: Buffer): boolean => buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/** File bytes → a rectangular string matrix (one array per row). */
async function toMatrix(buf: Buffer, filename: string): Promise<string[][]> {
  if (isZip(buf) || /\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      // exceljs is 1-indexed and sparse; walk to the row's last used column.
      for (let c = 1; c <= (row.cellCount || 0); c++) {
        const v = row.getCell(c).value as unknown;
        cells.push(v == null ? '' : typeof v === 'object' && 'text' in (v as any) ? String((v as any).text) : String(v));
      }
      rows.push(cells);
    });
    return rows;
  }
  // Text: SBI "xls" is latin1 tab-separated; .csv is comma-separated.
  const text = buf.toString('latin1').replace(/\r\n?/g, '\n');
  const rawLines = text.split('\n');
  const delim = /\.csv$/i.test(filename) ? ',' : text.includes('\t') ? '\t' : ',';
  return rawLines.map((l) => (delim === ',' ? splitCsv(l) : l.split(delim)));
}

/** Minimal CSV splitter (handles quoted cells with embedded commas). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const cell = (row: string[], i: number): string => (i >= 0 && i < row.length ? (row[i] ?? '').trim() : '');

/** "1,00,000.00" / " 500000.00 " / "" → number | null. */
function parseNum(s: string): number | null {
  const t = (s ?? '').replace(/[,\s₹]/g, '');
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "16/07/2026" → "2026-07-16". Returns null if not a dd/mm/yyyy date. */
function parseDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

function readMeta(rows: string[][], headerIdx: number): EscrowFileMeta {
  const meta: EscrowFileMeta = {
    account_number: null, ifsc: null, period_from: null, period_to: null,
    opening_balance: null, closing_balance: null,
  };
  for (let i = 0; i < headerIdx; i++) {
    const label = cell(rows[i]!, 0).replace(/\s*:\s*$/, '').toLowerCase();
    const val = cell(rows[i]!, 1);
    if (!val) continue;
    if (label.startsWith('account number')) meta.account_number = val.replace(/[^0-9]/g, '') || null;
    else if (label.startsWith('ifs code')) meta.ifsc = val;
    else if (label.startsWith('book balance') || label.startsWith('available balance')) meta.closing_balance = parseNum(val);
    else if (label.startsWith('opening balance')) meta.opening_balance = parseNum(val);
    else if (label.startsWith('start date')) meta.period_from = parseSbiDate(val);
    else if (label.startsWith('end date')) meta.period_to = parseSbiDate(val);
  }
  return meta;
}

/** "1 Jul 2026" → "2026-07-01". */
function parseSbiDate(s: string): string | null {
  const d = new Date(`${(s ?? '').trim()} UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

interface ColumnMap { txn: number; value: number; desc: number; ref: number; debit: number; credit: number; balance: number }

/** Locate the transaction header row and map the columns we need by name. */
function findColumns(rows: string[][]): { headerIdx: number; col: ColumnMap } | null {
  for (let i = 0; i < rows.length; i++) {
    const norm = rows[i]!.map((c) => c.trim().toLowerCase());
    if (norm.some((c) => c === 'txn date') && norm.some((c) => c.startsWith('credit'))) {
      const find = (...names: string[]) => norm.findIndex((c) => names.some((n) => c === n || c.startsWith(n)));
      return {
        headerIdx: i,
        col: {
          txn: find('txn date'), value: find('value date'), desc: find('description'),
          ref: find('ref no', 'ref no./cheque'), debit: find('debit'), credit: find('credit'), balance: find('balance'),
        },
      };
    }
  }
  return null;
}

export async function parseEscrowFile(buf: Buffer, filename: string): Promise<ParsedEscrowFile> {
  const rows = await toMatrix(buf, filename);
  const found = findColumns(rows);
  if (!found) throw new Error('Could not find the transaction table header (Txn Date … Credit …). Is this an SBI account statement export?');
  const { headerIdx, col } = found;
  const meta = readMeta(rows, headerIdx);

  const lines: ParsedEscrowLine[] = [];
  let rowNo = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const txnRaw = cell(r, col.txn);
    if (!DATE_RE.test(txnRaw)) continue; // footer / blank / continuation — data rows start with a date
    const credit = parseNum(cell(r, col.credit));
    const debit = parseNum(cell(r, col.debit));
    const isCredit = (credit ?? 0) > 0;
    const amount = isCredit ? credit! : -(debit ?? 0);
    if (amount === 0) continue;

    const description = cell(r, col.desc);
    const ref = cell(r, col.ref);
    const party = parseEscrowNarration(description, ref);
    const valueDate = parseDate(cell(r, col.value)) ?? parseDate(txnRaw);
    rowNo += 1;

    const keyParts = [party.utr || party.chequeNo || 'na', String(toPaise(amount)), valueDate || parseDate(txnRaw) || String(rowNo)];
    lines.push({
      row_no: rowNo,
      txn_date: parseDate(txnRaw),
      value_date: valueDate,
      amount,
      direction: isCredit ? 'credit' : 'debit',
      pay_type: party.payType,
      utr: party.utr,
      remitter_account: party.remitterAccount,
      remitter_account_pooled: party.remitterAccountPooled,
      remitter_name: party.remitterName,
      cheque_no: party.chequeNo,
      presenting_bank: party.presentingBank,
      description,
      ref_no: ref,
      balance: parseNum(cell(r, col.balance)),
      dedupe_key: keyParts.join('|'),
    });
  }
  return { meta, lines };
}
