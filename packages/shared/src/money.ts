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
export function formatINR(v: string | number, opts: { symbol?: boolean } = {}): string {
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
  return `${neg ? '-' : ''}${sym}${grouped}.${p}`;
}
