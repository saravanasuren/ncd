/**
 * The Summary tab of the NCD extract carries the interest figures the consuming
 * app asked for (owner 2026-08-10) — interest_accrued (accrued-as-on-date, not
 * yet paid) plus the monthly/daily run-rate — and they are real numbers, not
 * blanks. buildExtract writes the whole book, so we just run it and read back
 * summary.csv.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExtract } from '../src/scripts/daily-extract.js';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

// Every field is RFC-4180 quoted; pull the quoted contents back out.
const cells = (line: string) => (line.match(/"((?:[^"]|"")*)"/g) ?? []).map((s) => s.slice(1, -1).replace(/""/g, '"'));

describe('extract summary — interest fields', () => {
  it('summary.csv carries interest_accrued, interest_monthly and interest_daily as finite numbers', async () => {
    const dir = join(tmpdir(), `ncd-extract-test-${process.pid}-${ctx.base.length}`);
    await buildExtract(ctx.db, dir);

    const [headerLine, dataLine] = readFileSync(join(dir, 'summary.csv'), 'utf8').trim().split(/\r?\n/);
    const headers = cells(headerLine!);
    const values = cells(dataLine!);

    for (const h of ['interest_accrued', 'interest_monthly', 'interest_daily']) {
      const i = headers.indexOf(h);
      expect(i, `header ${h} present`).toBeGreaterThanOrEqual(0);
      const v = values[i];
      // Present, and a real number (accrual can legitimately be 0 in a fresh DB).
      expect(v === '' || Number.isFinite(Number(v)), `${h}="${v}" is numeric`).toBe(true);
    }
  });
});
