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
    for (const k of ['report_date', 'total_outstanding', 'active_apps', 'physical', 'funded', 'redemptions', 'brought_in', 'by_series', 'net_change']) {
      expect(d).toHaveProperty(k);
    }
    expect(Array.isArray(d.by_series)).toBe(true);
    expect(Array.isArray(d.brought_in)).toBe(true);
    // Every series line carries the redemption fields the red rows need.
    for (const s of d.by_series) {
      expect(s).toHaveProperty('redeemed_amount');
      expect(s).toHaveProperty('redeemed_count');
    }
    // First-ever run has no prior snapshot, so net change is unknown (null).
    expect(d.net_change).toBeNull();

    const first = await runBookSummary(ctx.db);
    expect(first.emails_queued).toBeGreaterThan(0);
    const second = await runBookSummary(ctx.db);
    expect(second.emails_queued).toBe(0); // same day → no double-send
  });

  it('series are ordered newest-first (descending by series number)', async () => {
    const { computeBookSummary } = await import('../src/integrations/book-summary.js');
    const d = await computeBookSummary(ctx.db);
    const nums = d.by_series.map((s) => parseInt(s.code.replace(/[^0-9]/g, ''), 10) || 0);
    const sorted = [...nums].sort((a, b) => b - a);
    expect(nums).toEqual(sorted);
  });

  it('honours a super-admin-configured recipient list over the role fallback', async () => {
    const { runBookSummary } = await import('../src/integrations/book-summary.js');
    const uid = (await ctx.db.query<{ id: number }>('SELECT id FROM users LIMIT 1')).rows[0]!.id;
    await ctx.db.query(
      `INSERT INTO app_settings (key, value, group_name, label, description, editable_by, updated_by, updated_at)
       VALUES ('reports.book_summary_recipients', $1, 'Reports', 'r', 'r', 'super_admin', $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(['boss@dhanam.finance']), uid]);

    const r = await runBookSummary(ctx.db, '2020-02-02');
    expect(r.emails_queued).toBe(1);
    const q = await ctx.db.query<{ to_address: string }>(
      `SELECT to_address FROM notifications_queue WHERE template='book_summary' AND payload->>'report_date'='2020-02-02'`);
    expect(q.rows.map((x) => x.to_address)).toEqual(['boss@dhanam.finance']);
  });

  it('renders an HTML email with the brand header, series and total', async () => {
    const { computeBookSummary } = await import('../src/integrations/book-summary.js');
    const { renderTemplate } = await import('../src/modules/notifications/templates.js');
    const d = await computeBookSummary(ctx.db);
    const m = renderTemplate('book_summary', d as unknown as Record<string, unknown>);
    expect(m.html).toBeTruthy();
    expect(m.html!).toContain('DHANAM');
    expect(m.html!).toContain('Outstanding by series');
    expect(m.subject).toContain('Dhanam NCD daily book');
    // Plain-text fallback is always present too.
    expect(m.body).toContain('Total outstanding');
  });
});
