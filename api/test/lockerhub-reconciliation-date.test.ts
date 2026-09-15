/**
 * The reconciliation report date is interpolated into SQL that runs through the
 * sqlite3 CLI against LockerHub's database, and it arrives from a request body.
 * sqlite3 takes the statement as a single argv string, so a crafted date could
 * close the quote and read any table in there — customer PII and payment rows —
 * despite -readonly. There is no placeholder to bind on that path, so the shape
 * is pinned instead.
 */
import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/integrations/lockerhub/reconciliation.js';
import type { Db } from '../src/db/types.js';

// Never reached: every case below must be refused before any query runs.
const db = { query: async () => { throw new Error('must not query'); } } as unknown as Db;

describe('reconciliation report_date', () => {
  it('refuses anything that is not a bare YYYY-MM-DD', async () => {
    for (const bad of [
      "2026-01-01' OR '1'='1",
      "2026-01-01'; SELECT * FROM customers --",
      "2026-01-01 00:00:00' UNION SELECT name FROM sqlite_master --",
      '2026/01/01',
      'yesterday',
      "' --",
    ]) {
      await expect(runReconciliation(db, bad)).rejects.toThrow(/report_date/i);
    }
  });

  it('refuses a well-shaped date that does not exist', async () => {
    await expect(runReconciliation(db, '2026-02-31')).rejects.toThrow(/not a real date/i);
    await expect(runReconciliation(db, '2026-13-01')).rejects.toThrow(/not a real date/i);
  });

  it('treats an empty date as "not supplied" and defaults to today', async () => {
    // Falsy → today's date, which is valid; it must reach the query, not be refused.
    await expect(runReconciliation(db, '')).rejects.toThrow(/must not query|SQLite/i);
  });

  it('lets a real date through to the query', async () => {
    // Gets past validation and fails at the DB stub, proving it was accepted.
    await expect(runReconciliation(db, '2026-02-28')).rejects.toThrow(/must not query|SQLite/i);
  });
});
