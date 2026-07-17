/** Daily book-summary compute + queue (per-day idempotent). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('book summary', () => {
  it('computes the expected shape and queues one email per admin, idempotently', async () => {
    const { computeBookSummary, runBookSummary } = await import('../src/integrations/book-summary.js');
    const d = await computeBookSummary(ctx.db);
    for (const k of ['report_date', 'total_outstanding', 'active_apps', 'physical', 'funded', 'redemptions', 'by_series']) {
      expect(d).toHaveProperty(k);
    }
    expect(Array.isArray(d.by_series)).toBe(true);
    const first = await runBookSummary(ctx.db);
    expect(first.emails_queued).toBeGreaterThan(0);
    const second = await runBookSummary(ctx.db);
    expect(second.emails_queued).toBe(0); // same day → no double-send
  });
});
