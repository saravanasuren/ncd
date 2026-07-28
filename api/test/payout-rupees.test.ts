/**
 * Whole-rupee presentation of a payout row (owner-approved 2026-07-28).
 *
 * Rounding gross, TDS and net each on their own broke the identity every
 * document is read with: on 80 of 684 live rows the paise rounded opposite
 * ways, leaving the summary sheet's Net column ₹68 short of gross − TDS.
 * payoutRupees rounds only gross and TDS, then DERIVES net and total, so the
 * arithmetic ties on every row and therefore in every column total.
 *
 * The stored 2-dp values are untouched — chk_ds_net (net = gross − tds +
 * adjustment) still governs disbursement_schedule.
 */
import { describe, it, expect } from 'vitest';
import { payoutRupees } from '@new-wealth/shared';

describe('payoutRupees — whole rupees that add up', () => {
  it('derives net from the ROUNDED gross and TDS (the case that was off by ₹1)', () => {
    // Live row: rounding each on its own gave 4932 / 493 / 4438, but 4932−493 = 4439.
    const m = payoutRupees({ gross_amount: 4931.51, tds_amount: 493.15 });
    expect(m.gross).toBe(4932);
    expect(m.tds).toBe(493);
    expect(m.net).toBe(4439);
    expect(m.gross - m.tds).toBe(m.net);
  });

  it('the identity holds across the real shapes that used to break it', () => {
    const rows = [
      { gross_amount: 14794.52, tds_amount: 1479.45 },
      { gross_amount: 34520.55, tds_amount: 3452.06 },
      { gross_amount: 4931.51, tds_amount: 493.15 },
      { gross_amount: 3123.29, tds_amount: 312.33 },
      { gross_amount: 5095.89, tds_amount: 509.59 },
      { gross_amount: 0, tds_amount: 0 },
    ];
    for (const r of rows) {
      const m = payoutRupees(r);
      expect(m.gross - m.tds, JSON.stringify(r)).toBe(m.net);
      expect(m.net + m.addition - m.deduction, JSON.stringify(r)).toBe(m.total);
    }
  });

  it('column totals tie, which is the whole point', () => {
    const rows = [
      { gross_amount: 4931.51, tds_amount: 493.15 },
      { gross_amount: 14794.52, tds_amount: 1479.45 },
      { gross_amount: 34520.55, tds_amount: 3452.06 },
    ];
    const t = rows.map(payoutRupees).reduce(
      (a, m) => ({ gross: a.gross + m.gross, tds: a.tds + m.tds, net: a.net + m.net, total: a.total + m.total }),
      { gross: 0, tds: 0, net: 0, total: 0 });
    expect(t.gross - t.tds).toBe(t.net);
    expect(t.net).toBe(t.total);
  });

  it('applies additions and deductions on top of the derived net', () => {
    const m = payoutRupees({ gross_amount: 4931.51, tds_amount: 493.15, addition_amount: 100, deduction_amount: 6038 });
    expect(m.net).toBe(4439);
    expect(m.addition).toBe(100);
    expect(m.deduction).toBe(6038);
    expect(m.total).toBe(4439 + 100 - 6038);
  });

  it('accepts the saved-batch shape, which carries ONE signed adjustment column', () => {
    const deduct = payoutRupees({ gross_amount: 4931.51, tds_amount: 493.15, adjustment_amount: -6038 });
    expect(deduct.deduction).toBe(6038);
    expect(deduct.addition).toBe(0);
    expect(deduct.total).toBe(4439 - 6038);

    const add = payoutRupees({ gross_amount: 4931.51, tds_amount: 493.15, adjustment_amount: 250 });
    expect(add.addition).toBe(250);
    expect(add.deduction).toBe(0);
    expect(add.total).toBe(4439 + 250);
  });

  it('a zero-TDS row is unaffected — net simply equals gross', () => {
    const m = payoutRupees({ gross_amount: 2810.96, tds_amount: 0 });
    expect(m.tds).toBe(0);
    expect(m.net).toBe(2811);
    expect(m.total).toBe(2811);
  });
});
