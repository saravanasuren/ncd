/**
 * SD1-SD5 become Debenture 1-5 (migration 114).
 *
 * Owner 2026-11-16, asked whether the rename was for display only: "both
 * display and internal code should be changed to debenture 1-5." So the CODE
 * moves too, which is the part worth testing: a code is what the enrolment
 * dropdown lists, and until now it was also what the certificate printed.
 *
 * The migration is a no-op on a test database (migration 107 only creates the
 * SD series where the subordinate book already existed), so these tests build
 * the shape by hand and run the file against it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;

function migrationSql(): string {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/114_sd_series_become_debenture_series.sql', import.meta.url)), 'utf8');
  return sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim();
}
const runMigration = () => ctx.db.query(migrationSql());

async function series(code: string, name: string, sub: boolean, close: string | null) {
  return Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, is_subordinate, close_date, deemed_date)
     VALUES ($1,$2,'Open',$3,$4::date,$4::date) RETURNING id`, [code, name, sub, close])).rows[0]!.id);
}
const codeOf = async (id: number) => (await ctx.db.query<{ code: string; name: string }>(
  'SELECT code, name FROM series WHERE id = $1', [id])).rows[0]!;

/** One test database serves the whole file, and the migration matches on exact
 *  codes — so a series left behind by one test is a collision in the next.
 *  Clear the fixture codes (and only those) before each. */
beforeEach(async () => {
  await ctx.db.query(
    `DELETE FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5','NCD_28')
        OR code LIKE 'Debenture %'`);
});

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('SD1-SD5 become Debenture 1-5', () => {
  it('renames the code AND the name, all five', async () => {
    const ids: number[] = [];
    const closes = ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30'];
    for (let i = 1; i <= 5; i++) ids.push(await series(`SD${i}`, `Subordinate Debt ${i}`, true, closes[i - 1]!));

    await runMigration();

    for (let i = 0; i < 5; i++) {
      const row = await codeOf(ids[i]!);
      expect(row.code).toBe(`Debenture ${i + 1}`);
      // Both, not just one — a code saying one thing while the name says
      // another is what printed "SD4 — Subordinate Debt 4" at a holder.
      expect(row.name).toBe(`Debenture ${i + 1}`);
    }
    expect(Number((await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM series WHERE code LIKE 'SD%'")).rows[0]!.n)).toBe(0);
  });

  it('leaves an NCD series completely alone', async () => {
    // "Do not disturb NCD Series 1-28 under any circumstances."
    const ncd = await series('NCD_28', 'NCD 28', false, null);
    const sd = await series('SD1', 'Subordinate Debt 1', true, '2026-07-31');

    await runMigration();

    expect(await codeOf(ncd)).toEqual({ code: 'NCD_28', name: 'NCD 28' });
    expect((await codeOf(sd)).code).toBe('Debenture 1');
  });

  it('keeps the two columns that decide money', async () => {
    // is_subordinate picks the certificate form; close_date is what every
    // maturity in the series is calculated from. A careless UPDATE here would
    // move maturity dates, and the migration's own post-check refuses that —
    // but a post-check that is never exercised proves nothing.
    const id = await series('SD3', 'Subordinate Debt 3', true, '2026-09-30');
    await runMigration();
    const row = (await ctx.db.query<{ is_subordinate: boolean; close_date: string }>(
      'SELECT is_subordinate, close_date::text FROM series WHERE id = $1', [id])).rows[0]!;
    expect(row.is_subordinate).toBe(true);
    expect(row.close_date).toBe('2026-09-30');
  });

  it('re-files nothing — no investment changes series', async () => {
    const id = await series('SD2', 'Subordinate Debt 2', true, '2026-08-31');
    const before = (await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM applications WHERE series_id = $1', [id])).rows[0]!.n;
    await runMigration();
    const after = (await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM applications WHERE series_id = $1', [id])).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('is safe to run twice', async () => {
    const id = await series('SD5', 'Subordinate Debt 5', true, '2026-11-30');
    await runMigration();
    await expect(runMigration()).resolves.toBeDefined();
    expect((await codeOf(id)).code).toBe('Debenture 5');
  });

  it('refuses rather than renaming half of them', async () => {
    // A code is unique. Failing partway would leave three series renamed and
    // two not, which is worse than not starting.
    await series('Debenture 4', 'Debenture 4', true, '2026-10-31');
    await series('SD4', 'Subordinate Debt 4', true, '2026-10-31');
    await expect(runMigration()).rejects.toThrow(/already uses one of the Debenture/i);
    // ...and nothing moved.
    expect(Number((await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM series WHERE code = 'SD4'")).rows[0]!.n)).toBe(1);
  });
});
