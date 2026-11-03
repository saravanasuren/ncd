/**
 * Named schemes, and the bond that prints them (owner 2026-11-03).
 *
 * Scheme 1 was named literally "13", which on a certificate reads
 * "Scheme: 13". It could NOT simply be renamed, and the owner is the one who
 * spotted why: it still carries NCD 27 and NCD 28, Rs 13.91 crore of 36-MONTH
 * investments. Calling it "13% - 60 Months - Monthly" would have labelled all of
 * them as 60-month.
 *
 * So a new scheme is added for the 60-month business, the 60-month lines move
 * onto it, and the old one goes back to describing what it actually holds. The
 * test that matters most is the one asserting the 36-month money did NOT move.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let sd3: number, ncd27: number, oldSchemeId: number, tdsRuleId: number | null;

async function runMigration() {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/109_named_schemes_for_the_bond.sql', import.meta.url)), 'utf8');
  await ctx.db.query(sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim());
}

/** A line on a series, at a given term. */
async function line(seriesId: number, schemeId: number, months: number, amount: number) {
  const cust = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone) VALUES ($1,$2,'9550000001') RETURNING id`,
    [`Scheme ${Math.random()}`, `SCH${Math.floor(Math.random() * 1e9)}`])).rows[0]!.id);
  const appId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, product_type)
     VALUES ($1,$2,$3,'Active',$4,'2026-09-15','ncd') RETURNING id`,
    [`APP-SCH-${Math.floor(Math.random() * 1e9)}`, cust, seriesId, amount])).rows[0]!.id);
  const lineId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO application_lines (application_id, scheme_id, amount, outstanding_amount, coupon_rate_pct, tenure_months, payout_frequency, status)
     VALUES ($1,$2,$3,$3,13,$4,'Monthly','Active') RETURNING id`, [appId, schemeId, amount, months])).rows[0]!.id);
  return { appId, lineId };
}

const schemeOf = async (lineId: number) => String((await ctx.db.query<{ c: string }>(
  `SELECT s.code AS c FROM application_lines al JOIN schemes s ON s.id = al.scheme_id WHERE al.id = $1`,
  [lineId])).rows[0]!.c);

beforeAll(async () => {
  ctx = await startTestServer();
  // Scheme 1 as production has it: named "13", 60 months after the in-place change.
  await ctx.db.query("UPDATE schemes SET name = '13', code = '13_M36_13', tenure_months = 60, coupon_rate_pct = 13, is_active = TRUE WHERE id = 1");
  oldSchemeId = 1;
  tdsRuleId = (await ctx.db.query<{ t: number | null }>('SELECT tds_rule_id AS t FROM schemes WHERE id = 1')).rows[0]!.t;
  await ctx.db.query(`INSERT INTO schemes (id, code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value, is_active)
    VALUES (3, '20%', 'Doubling', 60, 'AtMaturity', 20, 100000, TRUE) ON CONFLICT (id) DO UPDATE SET code='20%', name='Doubling'`);

  sd3 = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, is_subordinate, close_date, deemed_date)
     VALUES ('SD3','Subordinate Debt 3','Closed',TRUE,DATE '2026-09-30',DATE '2026-09-30') RETURNING id`)).rows[0]!.id);
  ncd27 = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status) VALUES ('NCD_27','NCD 27','Allotted') RETURNING id`)).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

describe('the 60-month money gets a named scheme of its own', () => {
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ids.sd60 = (await line(sd3, oldSchemeId, 60, 500000)).lineId;
    ids.sd36 = (await line(sd3, oldSchemeId, 36, 100000)).lineId;   // the one 36-month in a new series
    ids.old27 = (await line(ncd27, oldSchemeId, 36, 900000)).lineId; // NCD 27 money
    await runMigration();
  });

  it('moves the 60-month money in the new series onto the new scheme', async () => {
    expect(await schemeOf(ids.sd60!)).toBe('13_M60_MONTHLY');
  });

  it('does NOT move the 36-month money — the whole reason for adding a scheme', async () => {
    // Rs 13.91 crore of NCD 27 / NCD 28 would otherwise have been relabelled
    // as 60-month by a rename.
    expect(await schemeOf(ids.old27!)).toBe('13_M36_13');
    // ...nor the single 36-month investment sitting inside a new series.
    expect(await schemeOf(ids.sd36!)).toBe('13_M36_13');
  });

  it('copies the TDS rule and face value, so moving a line changes only its label', async () => {
    const n = (await ctx.db.query<Record<string, unknown>>(
      "SELECT tds_rule_id, face_value, coupon_rate_pct, tenure_months, payout_frequency FROM schemes WHERE code = '13_M60_MONTHLY'")).rows[0]!;
    expect(n.tds_rule_id ?? null).toBe(tdsRuleId ?? null);
    expect(Number(n.coupon_rate_pct)).toBe(13);
    expect(Number(n.tenure_months)).toBe(60);
    expect(n.payout_frequency).toBe('Monthly');
  });

  it('puts the old scheme back to 36 months and retires it', async () => {
    const o = (await ctx.db.query<Record<string, unknown>>('SELECT tenure_months, is_active, name FROM schemes WHERE id = 1')).rows[0]!;
    expect(Number(o.tenure_months)).toBe(36);
    expect(o.is_active).toBe(false);
    expect(o.name).toBe('13'); // NOT renamed — that is the point
  });

  it('renames Doubling and leaves exactly two schemes selectable', async () => {
    const d = (await ctx.db.query<{ name: string }>('SELECT name FROM schemes WHERE id = 3')).rows[0]!;
    expect(d.name).toBe('Doubling - 60 Months');
    // The two the owner named are selectable...
    const active = (await ctx.db.query<{ name: string }>(
      'SELECT name FROM schemes WHERE is_active = TRUE ORDER BY name')).rows.map((r) => r.name);
    expect(active).toContain('13% - 60 Months - Monthly');
    expect(active).toContain('Doubling - 60 Months');
    // ...and the ones named for retirement are not.
    const retired = (await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM schemes WHERE code IN ('13_M36_13','12%','15%') AND is_active = TRUE")).rows[0]!.n;
    expect(Number(retired)).toBe(0);
  });

  it('gives an AtMaturity line with no maturity date one, from the series', async () => {
    // The 8 Doubling investments carried no maturity at all, so their bond would
    // have printed a blank Date of Redemption.
    const { lineId } = await line(sd3, 3, 60, 1600000);
    await ctx.db.query('UPDATE application_lines SET maturity_date = NULL WHERE id = $1', [lineId]);
    await ctx.db.query('UPDATE applications SET maturity_date = NULL WHERE id = (SELECT application_id FROM application_lines WHERE id = $1)', [lineId]);
    await runMigration();
    const m = (await ctx.db.query<{ d: string }>('SELECT maturity_date AS d FROM application_lines WHERE id = $1', [lineId])).rows[0]!.d;
    expect(String(m).slice(0, 10)).toBe('2031-09-30'); // series close + 60 months
  });
});
