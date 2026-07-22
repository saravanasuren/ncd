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
} as const;
