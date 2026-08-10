/**
 * Certificate numbers must never repeat (owner 2026-08-10: "make sure the
 * numbers never gets duplicated ever. make it strictly").
 *
 * The guarantee has three layers and each is tested on its own, because a test
 * that only prints two bonds and sees two different numbers would still pass
 * with every safeguard removed:
 *
 *   1. the counter hands out one value per call, even under concurrency
 *   2. the DATABASE refuses a repeat outright — the absolute backstop
 *   3. a counter sitting BEHIND the book steps forward instead of duplicating
 *
 * Layer 3 is the one that matters in a disaster: restore an older dump, or
 * hand-edit number_sequences, and the counter points at numbers already
 * printed. Before this change that raised a 500 on the per-investment bond and
 * silently wrote a DUPLICATE on the consolidated one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { bondCertificatePdf, consolidatedBondCertificatePdf } from '../src/modules/reports/forms/bond.js';
import { nextSeq, isUniqueViolation } from '../src/lib/sequences.js';

let ctx: TestCtx;
let seriesId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

let n = 0;
/** An ISSUED investment, the only kind that carries a certificate. */
async function liveInvestment(): Promise<{ appId: number; customerId: number }> {
  const seq = ++n;
  const customerId = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
     VALUES ($1,$2,$3,'Approved',TRUE) RETURNING id`,
    [`CERT${String(seq).padStart(3, '0')}`, `Cert Holder ${seq}`, `98${String(seq).padStart(8, '0')}`])).rows[0]!.id);
  const appId = Number((await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                               date_money_received, allotment_date)
     VALUES ($1,$2,$3,'Active',100000,'2026-07-01','2026-07-01') RETURNING id`,
    [`APP-CERT-${seq}`, customerId, seriesId])).rows[0]!.id);
  await ctx.db.query(
    `INSERT INTO application_lines (application_id, amount, coupon_rate_pct, tenure_months, status, outstanding_amount)
     VALUES ($1,100000,12,36,'Active',100000)`, [appId]);
  return { appId, customerId };
}

const serialOf = async (appId: number) => (await ctx.db.query<{ bond_serial_no: string | null }>(
  'SELECT bond_serial_no FROM applications WHERE id = $1', [appId])).rows[0]!.bond_serial_no;

describe('layer 1 — the counter never hands the same value to two callers', () => {
  it('20 concurrent draws give 20 distinct numbers', async () => {
    const got = await Promise.all(Array.from({ length: 20 }, () => nextSeq(ctx.db, 'concurrency_probe')));
    expect(new Set(got).size).toBe(20);
  });

  it('two bonds printed at the same moment get different certificate numbers', async () => {
    const [a, b] = await Promise.all([liveInvestment(), liveInvestment()]);
    await Promise.all([bondCertificatePdf(ctx.db, a.appId), bondCertificatePdf(ctx.db, b.appId)]);
    const [sa, sb] = await Promise.all([serialOf(a.appId), serialOf(b.appId)]);
    expect(sa).toBeTruthy();
    expect(sb).toBeTruthy();
    expect(sa).not.toBe(sb);
  });

  it('printing the SAME bond twice keeps one number — it is never re-issued', async () => {
    const { appId } = await liveInvestment();
    await bondCertificatePdf(ctx.db, appId);
    const first = await serialOf(appId);
    await bondCertificatePdf(ctx.db, appId);
    expect(await serialOf(appId)).toBe(first);
  });

  it('printing the same bond concurrently still yields exactly one number', async () => {
    const { appId } = await liveInvestment();
    await Promise.all([1, 2, 3, 4].map(() => bondCertificatePdf(ctx.db, appId)));
    const rows = await ctx.db.query(
      'SELECT bond_serial_no FROM applications WHERE id = $1 AND bond_serial_no IS NOT NULL', [appId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe('layer 2 — the database refuses a duplicate outright', () => {
  it('a second investment cannot be given a number already in use', async () => {
    const { appId } = await liveInvestment();
    await bondCertificatePdf(ctx.db, appId);
    const taken = await serialOf(appId);
    const other = await liveInvestment();
    await expect(ctx.db.query(
      'UPDATE applications SET bond_serial_no = $1 WHERE id = $2', [taken, other.appId])
    ).rejects.toThrow();
  });

  it('a consolidated certificate number cannot be reused either (migration 067)', async () => {
    const { customerId } = await liveInvestment();
    await consolidatedBondCertificatePdf(ctx.db, customerId, seriesId);
    const taken = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1', [customerId])).rows[0]!.bond_serial_no;
    // A DIFFERENT customer+series pair — so UNIQUE(customer_id, series_id) does
    // NOT apply. Only a unique index on the serial itself can stop this, which
    // is precisely what was missing before.
    const other = await liveInvestment();
    await expect(ctx.db.query(
      'INSERT INTO consolidated_bonds (customer_id, series_id, bond_serial_no) VALUES ($1,$2,$3)',
      [other.customerId, seriesId, taken])).rejects.toThrow();
  });
});

describe('layer 3 — a counter behind the book steps forward, never duplicates', () => {
  it('per-investment: rewinding the counter does not re-issue a printed number', async () => {
    const first = await liveInvestment();
    await bondCertificatePdf(ctx.db, first.appId);
    const printed = (await serialOf(first.appId))!;

    // Rewind hard — as a restore from an older dump would.
    await ctx.db.query("UPDATE number_sequences SET next_value = 1 WHERE key = 'bond'");

    const second = await liveInvestment();
    await bondCertificatePdf(ctx.db, second.appId);      // must not throw
    const fresh = await serialOf(second.appId);

    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(printed);
    const dupes = await ctx.db.query(
      `SELECT bond_serial_no FROM applications WHERE bond_serial_no IS NOT NULL
        GROUP BY bond_serial_no HAVING count(*) > 1`);
    expect(dupes.rowCount).toBe(0);
  });

  it('consolidated: rewinding the counter does not re-issue either', async () => {
    const a = await liveInvestment();
    await consolidatedBondCertificatePdf(ctx.db, a.customerId, seriesId);
    const printed = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1', [a.customerId])).rows[0]!.bond_serial_no;

    await ctx.db.query("UPDATE number_sequences SET next_value = 1 WHERE key = 'consolidated_bond'");

    const b = await liveInvestment();
    await consolidatedBondCertificatePdf(ctx.db, b.customerId, seriesId);
    const fresh = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1', [b.customerId])).rows[0]!.bond_serial_no;

    expect(fresh).not.toBe(printed);
    const dupes = await ctx.db.query(
      'SELECT bond_serial_no FROM consolidated_bonds GROUP BY bond_serial_no HAVING count(*) > 1');
    expect(dupes.rowCount).toBe(0);
  });
});

describe('a number is only ever spent on a real certificate', () => {
  it('a pending application prints "—" and burns nothing', async () => {
    const { appId } = await liveInvestment();
    await ctx.db.query("UPDATE applications SET status = 'PendingApproval' WHERE id = $1", [appId]);
    const before = Number((await ctx.db.query(
      "SELECT next_value FROM number_sequences WHERE key = 'bond'")).rows[0]!.next_value);
    await bondCertificatePdf(ctx.db, appId);
    expect(await serialOf(appId)).toBeNull();
    expect(Number((await ctx.db.query(
      "SELECT next_value FROM number_sequences WHERE key = 'bond'")).rows[0]!.next_value)).toBe(before);
  });

  it('the two runs are independent — BC- and CB- never share a number', async () => {
    const rows = await ctx.db.query(`
      SELECT a.bond_serial_no FROM applications a
       WHERE a.bond_serial_no IS NOT NULL
         AND a.bond_serial_no IN (SELECT bond_serial_no FROM consolidated_bonds)`);
    expect(rows.rowCount).toBe(0);
  });
});

describe('isUniqueViolation', () => {
  it('recognises the SQLSTATE, whichever driver raised it', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "x"'))).toBe(true);
  });

  it('does NOT swallow other failures — those must still surface', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);          // FK violation
    expect(isUniqueViolation(new Error('connection terminated'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
