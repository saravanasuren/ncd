/**
 * Escrow parser, pinned to a real (anonymisable) SBI escrow export — the
 * DHANAM current account, 1–25 Jul 2026, 28 credit lines. This is the file the
 * whole feature was built against, so the parser's reading of every pay-type
 * (RTGS/NEFT/IMPS/cheque/internal) is locked down here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEscrowFile } from '../src/modules/escrow/parse.js';

const buf = readFileSync(fileURLToPath(new URL('./fixtures/sbi-escrow-sample.xls', import.meta.url)));
const parsed = await parseEscrowFile(buf, 'sbi-escrow-sample.xls');
const byUtr = (u: string) => parsed.lines.find((l) => l.utr === u)!;
const byCheque = (c: string) => parsed.lines.find((l) => l.cheque_no === c)!;

describe('escrow parser — SBI export', () => {
  it('reads the account header + closing balance (the escrow balance)', () => {
    expect(parsed.meta.account_number).toBe('00000045000000001');
    expect(parsed.meta.ifsc).toBe('SBIN0012778');
    expect(parsed.meta.opening_balance).toBe(0);
    expect(parsed.meta.closing_balance).toBe(12306101);
  });

  it('parses every credit line and stops before the footer', () => {
    expect(parsed.lines).toHaveLength(28);
    expect(parsed.lines.every((l) => l.direction === 'credit')).toBe(true);
    // Sum of credits from ₹0 opening must reach the closing balance.
    const total = parsed.lines.reduce((s, l) => s + l.amount, 0);
    expect(total).toBe(12306101);
  });

  it('extracts RTGS UTR, remitter account and name', () => {
    const l = byUtr('ESFBR62026071804534856');
    expect(l.pay_type).toBe('RTGS');
    expect(l.amount).toBe(1000000);
    expect(l.remitter_account).toBe('90000000002');
    expect(l.remitter_name).toBe('A RAMESH');
  });

  it('extracts NEFT name from narration and flags the pooled clearing account', () => {
    const l = byUtr('IN12620447406223');
    expect(l.pay_type).toBe('NEFT');
    expect(l.remitter_name).toBe('DEEPAK S');           // trailing "--" stripped
    expect(l.remitter_account).toBe('99509044300');
    expect(l.remitter_account_pooled).toBe(true);       // SBI NEFT pool — not identifying
  });

  it('extracts IMPS reference and name', () => {
    const l = byUtr('620121354697');
    expect(l.pay_type).toBe('IMPS');
    expect(l.remitter_name).toBe('SUNITA K');
  });

  it('reads a bare cheque credit as cheque-number-only (no payer identity)', () => {
    const l = byCheque('751908');
    expect(l.pay_type).toBe('Cheque');
    expect(l.amount).toBe(1000000);
    expect(l.remitter_name).toBeNull();
    expect(l.remitter_account).toBeNull();
    expect(l.presenting_bank).toBe('CAB');
  });

  it('reads a cheque deposit that carries a name', () => {
    const l = byCheque('282403');
    expect(l.remitter_name).toContain('MEENA');
    expect(l.amount).toBe(500000);
  });

  it('gives every line a stable dedupe key', () => {
    const keys = parsed.lines.map((l) => l.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
