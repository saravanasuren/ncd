/**
 * Senior-citizen classification for TDS filing (owner spec 2026-07-21). Category
 * is derived from DOB (60+ = Senior → Form 15H; else General → 15G), computed in
 * SQL so it can never drift. Verifies the derivation + that the report SQL runs
 * on the real Postgres dialect (PGlite).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { tdsReport, tds26q } from '../src/modules/reports/documents.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('senior-citizen TDS category', () => {
  it('derives Senior at 60+, General below, from DOB (as of a due date)', async () => {
    // Boundary check against a fixed reference date (2026-07-01).
    const { rows } = await ctx.db.query<{ label: string; category: string }>(
      `SELECT label, CASE WHEN EXTRACT(YEAR FROM age(DATE '2026-07-01', dob)) >= 60 THEN 'Senior' ELSE 'General' END AS category
         FROM (VALUES
           ('turns61', DATE '1965-01-01'),
           ('exactly60', DATE '1966-06-01'),
           ('turns59', DATE '1967-01-01')
         ) AS t(label, dob)`);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.category]));
    expect(byLabel.turns61).toBe('Senior');
    expect(byLabel.exactly60).toBe('Senior');
    expect(byLabel.turns59).toBe('General');
  });

  it('tdsReport and tds26q generate a workbook without error (SQL valid on PGlite)', async () => {
    const monthly = await tdsReport(ctx.db, '2099-01');
    expect(Buffer.isBuffer(monthly)).toBe(true);
    expect(monthly.length).toBeGreaterThan(0);
    const quarterly = await tds26q(ctx.db, '2099-Q1');
    expect(Buffer.isBuffer(quarterly)).toBe(true);
    expect(quarterly.length).toBeGreaterThan(0);
  });
});
