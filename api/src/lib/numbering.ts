/**
 * Human-readable id formatting. Formats are config-driven (settings
 * `numbering.*`, docs/07). The actual next-value comes from a row-locked
 * `number_sequences` table (repo layer) — this module only renders a
 * sequence number + context into a code. Never MAX()+1.
 *
 * Tokens: {seq:N} zero-padded sequence, {yyyy} 4-digit year.
 */

export interface NumberingContext {
  seq: number;
  year?: number;
}

export function formatNumber(template: string, ctx: NumberingContext): string {
  return template.replace(/\{(\w+)(?::(\d+))?\}/g, (_m, token: string, width?: string) => {
    if (token === 'seq') {
      const w = width ? parseInt(width, 10) : 0;
      return String(ctx.seq).padStart(w, '0');
    }
    if (token === 'yyyy') {
      return String(ctx.year ?? new Date().getUTCFullYear());
    }
    return _m;
  });
}

/** Default formats (docs/07). Overridable in settings. */
export const DEFAULT_NUMBER_FORMATS = {
  customer: 'DHN{seq:6}',
  application: 'APP-{yyyy}-{seq:6}',
  disbursement: 'DSB-{yyyy}-{seq:6}',
  collection: 'COL-{yyyy}-{seq:6}',
  rollover: 'ROL-{yyyy}-{seq:6}',
  transfer: 'TRF-{yyyy}-{seq:6}',
  redemption: 'MCR-{yyyy}-{seq:6}',
  bond: 'BC-{yyyy}-{seq:6}',        // bond certificate number (lazy, on first generation)
  // Subordinate bonds are numbered SOB-2026-000001 on their OWN counter, not
  // the APP- one (owner 2026-08-10). Same shape as `application` so the two
  // read alike; the leading token is what tells them apart at a glance.
  subordinate_bond: 'SOB-{yyyy}-{seq:6}',
  // The Debenture 1-5 certificate number. Owner 2026-11-16: "DC/2026/SD/00001",
  // and, asked whether the two forms should carry separate runs: "rename both
  // as - DC/2026/SD/00001" - ONE number per holding, printed on both the
  // Subordinate Bond and the Debenture rendering of it.
  //
  // Was SD-{yyyy}-{seq:4} (owner 2026-11-02). Migration 115 moves the numbers
  // already issued onto this format, so no holding carries the old shape.
  //
  // THE RUN RESTARTS EACH JANUARY, which the template alone cannot do - {yyyy}
  // only prints the year. The COUNTER is year-scoped in bond.ts
  // (`subordinate_debt:2026`), and that is what makes DC/2027/SD/00001 follow
  // DC/2026/SD/00123. Still a separate counter from `bond`, so the BC- numbers
  // already issued are never reused. Note this is NOT `subordinate_bond` above
  // - that is the SOB product, which has no series.
  subordinate_debt: 'DC/{yyyy}/SD/{seq:5}',
  // Locker agreement number, printed on the Schedule. The owner's template
  // reads "Agreement No :- DIF0000", so it is DIF + a running number and NOT
  // year-scoped: a locker hire renews indefinitely, so a number that restarts
  // each January would collide with a live agreement. Four digits is the
  // template's width; past 9,999 it simply grows a digit rather than wrapping.
  locker_agreement: 'DIF{seq:4}',
} as const;
