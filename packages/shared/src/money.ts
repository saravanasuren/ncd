/**
 * Money helpers (docs/01 §4). Rupees are represented as strings over the
 * wire ("500000.00"); all arithmetic is done in integer **paise** to avoid
 * float drift. `Money` is a branded string so a raw number can't leak into
 * a money field by accident.
 */
export type Money = string & { readonly __brand: 'Money' };

/** Parse a money string/number to integer paise. Throws on garbage. */
export function toPaise(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid money value: ${v}`);
  return Math.round(n * 100);
}

/** Integer paise → Money string with 2 decimals. */
export function fromPaise(paise: number): Money {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${sign}${rupees}.${String(p).padStart(2, '0')}` as Money;
}

/** Round a rupee number to 2 dp (half-up), returning Money. */
export function money(v: string | number): Money {
  return fromPaise(toPaise(v));
}

export function addMoney(...vals: (string | number)[]): Money {
  return fromPaise(vals.reduce<number>((s, v) => s + toPaise(v), 0));
}

export function subMoney(a: string | number, b: string | number): Money {
  return fromPaise(toPaise(a) - toPaise(b));
}

/** Numeric value of a money string (for comparisons/sorts only). */
export function moneyNum(v: string | number): number {
  return toPaise(v) / 100;
}

/**
 * Format for display with Indian digit grouping (₹12,34,567.00).
 * Symbol optional so it works in table cells and exports.
 */
export function formatINR(v: string | number | null | undefined, opts: { symbol?: boolean } = {}): string {
  // Display helper — tolerate a missing/garbage value with an em-dash rather
  // than throwing (a thrown formatINR crash-rendered whole pages when an API
  // omitted a money field). Money MATH still uses the strict toPaise.
  if (v == null || v === '' || !Number.isFinite(typeof v === 'number' ? v : Number(v))) return '—';
  const paise = toPaise(v);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  const s = String(rupees);
  // Indian grouping: last 3 digits, then groups of 2.
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  const sym = opts.symbol === false ? '' : '₹';
  // No trailing ".00" (owner 2026-08-16: "there should be no decimal"). Payouts
  // are now computed in whole rupees, so printing two zeroes on every figure is
  // noise the owner asked to be rid of.
  //
  // Paise are still shown WHEN THERE ARE ANY. Batches paid before the change
  // legitimately carry them and match the bank statement — blanket-stripping
  // would silently misreport ₹56,78,842.03 as ₹56,78,842, which is a different
  // number from the one that left the account.
  const showPaise = abs % 100 !== 0;
  return `${neg ? '-' : ''}${sym}${grouped}${showPaise ? `.${p}` : ''}`;
}

/**
 * Whole-rupee presentation of one payout row (owner-approved 2026-07-28).
 *
 * The sheets and the bank file can only carry whole rupees. Rounding gross,
 * TDS and net each on their own broke the identity the documents are read
 * with: on 80 of 684 live rows the paise rounded opposite ways
 * (gross 4931.51→4932, TDS 493.15→493, net 4438.36→4438, yet 4932−493=4439),
 * leaving the sheet's Net column ₹68 short of gross − TDS.
 *
 * So round gross and TDS — the two figures that stand on their own — and
 * DERIVE net and total from those. Every document then ties, on every row and
 * in every total: gross − TDS = net, and net + additions − deductions = total.
 *
 * Presentation ONLY. The stored 2-dp values are never touched, so the
 * chk_ds_net invariant (net_amount = gross_amount − tds_amount +
 * adjustment_amount) continues to hold on disbursement_schedule.
 *
 * Shared so the summary sheet, the NEFT file and the Payouts screen cannot
 * drift apart — they must all state the same rupees.
 */
export interface PayoutRupees {
  gross: number; tds: number; net: number;
  addition: number; deduction: number; total: number;
}

export function payoutRupees(r: {
  gross_amount?: unknown; tds_amount?: unknown;
  addition_amount?: unknown; deduction_amount?: unknown;
  /** Saved-batch rows carry ONE signed column instead of the add/deduct pair. */
  adjustment_amount?: unknown;
}): PayoutRupees {
  const R = (v: unknown) => Math.round(Number(v) || 0);
  const gross = R(r.gross_amount);
  const tds = R(r.tds_amount);
  const net = gross - tds;

  // Prefer the explicit pair; fall back to the signed adjustment column.
  const hasPair = r.addition_amount !== undefined || r.deduction_amount !== undefined;
  const signed = R(r.adjustment_amount);
  const addition = hasPair ? R(r.addition_amount) : Math.max(0, signed);
  const deduction = hasPair ? R(r.deduction_amount) : Math.max(0, -signed);

  return { gross, tds, net, addition, deduction, total: net + addition - deduction };
}
