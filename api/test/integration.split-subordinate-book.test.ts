/**
 * Migration 107 — splitting the subordinate book into one series per month.
 *
 * This runs against a live book of 229 investments and Rs 15.21 crore, so the
 * migration's OWN sql is executed here, not a paraphrase of it. What it must get
 * right is mostly what it must NOT touch:
 *
 *   · 12% money stays where it is (NCD BOND's 12-month lines);
 *   · rejected intents stay where they are, including the ones whose status has
 *     not been flipped yet — otherwise two rejected investments ride into a live
 *     series;
 *   · amounts, rates, tenure and schedules are not altered at all;
 *   · an emptied series closes, one that still holds money does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let ncd29: number, ncdBond: number, ncdDoubling: number, schemeId: number;

/** Run the migration file. It is a single guarded DO block. */
async function runMigration() {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/107_split_subordinate_book_by_month.sql', import.meta.url)),
    'utf8');
  await ctx.db.query(sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim());
}

/** An investment placed directly, so the fixture can set rate and date freely. */
async function place(seriesId: number, received: string | null, amount: number, rate: number, status = 'Active'): Promise<number> {
  const cust = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone) VALUES ($1, $2, $3) RETURNING id`,
    [`Split ${received ?? 'none'} ${amount} ${rate} ${Math.random()}`, `SPL${Math.floor(Math.random() * 1e9)}`, '9550000000'])).rows[0]!.id);
  const appId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, product_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'ncd') RETURNING id`,
    [`APP-SPLIT-${Math.floor(Math.random() * 1e9)}`, cust, seriesId, status, amount, received])).rows[0]!.id);
  await ctx.db.query(
    `INSERT INTO application_lines (application_id, scheme_id, amount, outstanding_amount, coupon_rate_pct, tenure_months, payout_frequency, status)
     VALUES ($1, $2, $3, $3, $4, 60, 'Monthly', 'Active')`, [appId, schemeId, amount, rate]);
  return appId;
}

const seriesOf = async (appId: number) => Number((await ctx.db.query<{ series_id: string }>(
  'SELECT series_id FROM applications WHERE id = $1', [appId])).rows[0]!.series_id);
const idOfCode = async (code: string) => Number((await ctx.db.query<{ id: string }>(
  'SELECT id FROM series WHERE code = $1', [code])).rows[0]!.id);
const statusOfSeries = async (code: string) => String((await ctx.db.query<{ status: string }>(
  'SELECT status FROM series WHERE code = $1', [code])).rows[0]!.status);

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // The migration resolves the three source series by CODE, so the ids here are
  // whatever the database hands out.
  const mk = async (code: string, name: string) => Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, visible_in_app)
     VALUES ($1, $2, 'Open', 100000, TRUE, TRUE) RETURNING id`, [code, name])).rows[0]!.id);
  ncd29 = await mk('NCD_29', 'NCD 29');
  ncdBond = await mk('NCD BOND', 'NCD BOND');
  ncdDoubling = await mk('NCD Doubling', 'NCD Doubling');
});
afterAll(async () => { await ctx.close(); });

describe('migration 107 splits the subordinate book by month', () => {
  // Built once; every assertion reads the same post-migration state.
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ids.jul = await place(ncdBond, '2026-07-15', 2500000, 13);
    ids.aug = await place(ncd29, '2026-08-20', 500000, 13);
    ids.augDoubling = await place(ncdDoubling, '2026-08-11', 1600000, 20);
    ids.sep = await place(ncd29, '2026-09-17', 1000000, 13);
    ids.oct = await place(ncd29, '2026-10-05', 600000, 13);
    ids.nov = await place(ncd29, '2026-11-02', 700000, 13);
    // Must NOT move:
    ids.twelvePct = await place(ncdBond, '2026-08-24', 5000000, 12);
    ids.rejectedStatus = await place(ncd29, '2026-09-21', 600000, 13, 'Rejected');
    ids.pendingWaiting = await place(ncd29, '2026-10-26', 1000000, 13, 'PendingApproval');
    ids.noDate = await place(ncd29, null, 300000, 13);

    // ...and one whose approval was rejected but whose status is still pending —
    // the case that would otherwise ride into a live series.
    ids.rejectedButPending = await place(ncd29, '2026-09-21', 600000, 13, 'PendingApproval');
    await ctx.db.query(
      `INSERT INTO approval_requests (request_no, request_type, entity_type, entity_id, status)
       VALUES ($1, 'subscription', 'applications', $2, 'Rejected')`,
      [`REQ-SPLIT-${Math.floor(Math.random() * 1e9)}`, String(ids.rejectedButPending)]);
    // The genuinely-waiting one keeps a Pending request, so it must still move.
    await ctx.db.query(
      `INSERT INTO approval_requests (request_no, request_type, entity_type, entity_id, status)
       VALUES ($1, 'subscription', 'applications', $2, 'Pending')`,
      [`REQ-SPLIT-${Math.floor(Math.random() * 1e9)}`, String(ids.pendingWaiting)]);

    await runMigration();
  });

  it('puts each investment in the series for the month its money arrived', async () => {
    expect(await seriesOf(ids.jul!)).toBe(await idOfCode('SD1'));
    expect(await seriesOf(ids.aug!)).toBe(await idOfCode('SD2'));
    expect(await seriesOf(ids.augDoubling!)).toBe(await idOfCode('SD2'));
    expect(await seriesOf(ids.sep!)).toBe(await idOfCode('SD3'));
    expect(await seriesOf(ids.oct!)).toBe(await idOfCode('SD4'));
    expect(await seriesOf(ids.nov!)).toBe(await idOfCode('SD5'));
  });

  it('leaves the 12% money exactly where it was', async () => {
    expect(await seriesOf(ids.twelvePct!)).toBe(ncdBond);
  });

  it('leaves rejected intents behind — including one still labelled pending', async () => {
    expect(await seriesOf(ids.rejectedStatus!)).toBe(ncd29);
    // The clause that makes this migration independent of the rejection fix.
    expect(await seriesOf(ids.rejectedButPending!)).toBe(ncd29);
  });

  it('still moves an investment that is genuinely waiting for approval', async () => {
    // "pending approval shall remain pending" is about its STATUS, not about
    // stranding it outside the month it belongs to.
    expect(await seriesOf(ids.pendingWaiting!)).toBe(await idOfCode('SD4'));
    const st = (await ctx.db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [ids.pendingWaiting])).rows[0]!.status;
    expect(st).toBe('PendingApproval');
  });

  it('leaves an investment with no money-received date alone', async () => {
    expect(await seriesOf(ids.noDate!)).toBe(ncd29);
  });

  it('gives every new series the flag, the close date and the right status', async () => {
    const rows = (await ctx.db.query<Record<string, unknown>>(
      `SELECT code, status, is_subordinate, close_date::text AS close_date FROM series
        WHERE code IN ('SD1','SD2','SD3','SD4','SD5') ORDER BY code`)).rows;
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.is_subordinate).toBe(true);
    expect(rows.map((r) => r.close_date)).toEqual(
      ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
    // Past months closed to new money; the current month still open for enrolment.
    expect(rows.map((r) => r.status)).toEqual(['Closed', 'Closed', 'Closed', 'Closed', 'Open']);
  });

  it('closes the emptied series but not the one still holding money', async () => {
    // NCD 29 keeps only non-live records, NCD Doubling is empty → both close.
    expect(await statusOfSeries('NCD_29')).toBe('Closed');
    expect(await statusOfSeries('NCD Doubling')).toBe('Closed');
    // NCD BOND still holds live 12% money, so it must stay open.
    expect(await statusOfSeries('NCD BOND')).toBe('Open');
  });

  it('changes nothing about the money itself', async () => {
    const line = (await ctx.db.query<Record<string, unknown>>(
      'SELECT amount, coupon_rate_pct, tenure_months, payout_frequency FROM application_lines WHERE application_id = $1',
      [ids.sep])).rows[0]!;
    expect(Number(line.amount)).toBe(1000000);
    expect(Number(line.coupon_rate_pct)).toBe(13);
    expect(Number(line.tenure_months)).toBe(60);
    expect(line.payout_frequency).toBe('Monthly');
  });

  it('records every move in the audit trail', async () => {
    const n = Number((await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'application.series_moved'")).rows[0]!.n);
    expect(n).toBe(7); // the six months plus the genuinely-waiting October one
  });

  it('refuses to run twice rather than creating duplicate series', async () => {
    await expect(runMigration()).rejects.toThrow(/already uses one of the SD1\.\.SD5 codes/i);
  });
});
