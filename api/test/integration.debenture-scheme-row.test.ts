/**
 * The Scheme row on the Debenture certificate (owner 2026-11-17: "IN THE NCD
 * CERTIFICATE I NEED THE SCHEME NAAME TO COME BELOW COUPON RATE").
 *
 * Two decisions the owner made when asked, both pinned here:
 *
 *  1. THE PLAIN NAME, no "(36 MONTH 13.00%)" bracket like the subordinate form
 *     carries. This form deliberately prints a THREE-YEAR redemption date even
 *     where the holding's own line says 60 months, so a label repeating that
 *     term would contradict the dates beside it on the same page. One live
 *     Debenture 5 holding is exactly that case.
 *
 *  2. The scheme stored as the two characters "13" is renamed (migration 116)
 *     rather than printed as-is, because "13" reads like nothing to a holder.
 *
 * And the constraint that outranks both: NCD Series 1-28 certificate formats do
 * not change. The row is scoped to the Debenture form, and the last test here
 * is what stops it leaking.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

/** A scheme under an explicit NAME (the thing on trial here) and a series. */
async function setup(tag: string, schemeName: string, tenure: number, sub: boolean, freq = 'Monthly') {
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  const schemeId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING id`,
    [`SCH-${tag}`, schemeName, tenure, freq, base.coupon_rate_pct, base.face_value, base.min_ticket,
     base.multiple_of, base.day_count_convention, base.commission_rule, base.tds_rule_id])).rows[0]!.id);
  const seriesId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,$2,'2026-10-31'::date,'2026-10-31'::date) RETURNING id`,
    [`SER-${tag}`, sub])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [seriesId, schemeId]);
  return { schemeId, seriesId };
}

/** NOTE the holder names below carry no word any assertion searches for. The
 *  extracted PDF text is ONE string: a customer called "Scheme Row One" put the
 *  word Scheme above the coupon rate and made both ordering tests lie. */
async function holding(seriesId: number, schemeId: number, name: string, phone: string) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-10-05',
  });
  await approveInvestment(checker, app);
  return Number(cust.json.id);
}

const ncdForm = async (cid: number, sid: number) => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, 'debenture')));
};
const subForm = async (cid: number, sid: number) => {
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid)));
};

describe('the Debenture certificate names the scheme', () => {
  it('prints a Scheme row BELOW the coupon rate and above the allotment date', async () => {
    const { seriesId, schemeId } = await setup('ROW1', 'Monthly Income Plan', 36, true);
    const cid = await holding(seriesId, schemeId, 'Holder Alpha', '9611100001');
    const t = await ncdForm(cid, seriesId);

    expect(t).toContain('MonthlyIncomePlan');
    // Position is the request, not merely presence.
    const coupon = t.indexOf('CouponRate');
    const scheme = t.indexOf('Scheme');
    const allot = t.indexOf('DateofAllotment');
    expect(coupon).toBeGreaterThan(-1);
    expect(scheme).toBeGreaterThan(coupon);
    expect(allot).toBeGreaterThan(scheme);
  });

  it('prints the NAME ONLY — no term bracket to contradict the dates', async () => {
    // 60 months on the line, but this form states three years. A label carrying
    // the line's own term would disagree with the row two lines below it.
    const { seriesId, schemeId } = await setup('ROW2', 'Long Horizon Plan', 60, true);
    const cid = await holding(seriesId, schemeId, 'Holder Beta', '9611100002');
    const t = await ncdForm(cid, seriesId);

    expect(t).toContain('LongHorizonPlan');
    expect(t).not.toContain('(60MONTH');
    expect(t).not.toContain('(36MONTH');
    // The three-year statement this form is built on is still intact.
    expect(t).toContain('31-10-2029');
  });

  it('leaves the SUBORDINATE form exactly as it was — its Scheme row stays put', async () => {
    const { seriesId, schemeId } = await setup('ROW3', 'Steady Plan', 36, true);
    const cid = await holding(seriesId, schemeId, 'Holder Gamma', '9611100003');
    const t = await subForm(cid, seriesId);

    // On that form the scheme sits ABOVE Investment Value, and always did.
    const scheme = t.indexOf('Scheme');
    const invested = t.indexOf('InvestmentValue');
    expect(scheme).toBeGreaterThan(-1);
    expect(scheme).toBeLessThan(invested);
  });

  it('does NOT touch a real NCD series certificate', async () => {
    // "Do not disturb NCD Series 1-28 under any circumstances." A non-
    // subordinate series can never reach the Debenture form, so it must keep
    // its Category row and gain nothing.
    const { seriesId, schemeId } = await setup('ROW4', 'Plain Ncd Plan', 36, false);
    const cid = await holding(seriesId, schemeId, 'Holder Delta', '9611100004');
    const t = await subForm(cid, seriesId);

    expect(t).toContain('Category');
    expect(t).not.toContain('Scheme');
    expect(t).not.toContain('PlainNcdPlan');
  });
});

/** Migration 116, run against a shape built by hand — it is a no-op on a test
 *  database, which would make an assertion on the seed vacuous. */
function migrationSql(): string {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/116_the_scheme_named_13_gets_its_real_name.sql', import.meta.url)), 'utf8');
  return sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim();
}
const runMigration = () => ctx.db.query(migrationSql());

async function scheme(code: string, name: string, tenure = 36, rate = '13.0000', freq = 'Monthly') {
  const base = (await ctx.db.query("SELECT * FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]! as Record<string, unknown>;
  return Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                          min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE) RETURNING id`,
    [code, name, tenure, freq, rate, base.face_value, base.min_ticket, base.multiple_of,
     base.day_count_convention, base.commission_rule, base.tds_rule_id])).rows[0]!.id);
}
const nameOf = async (code: string) => (await ctx.db.query<{ name: string }>(
  'SELECT name FROM schemes WHERE code = $1', [code])).rows[0]?.name;

// The migration matches exact codes, so a scheme left by one test collides in
// the next. Clear only the fixture codes.
beforeEach(async () => {
  await ctx.db.query("DELETE FROM schemes WHERE code IN ('13_M36_13','13_M36_MONTHLY')");
});

describe('migration 116 — the scheme stored as "13"', () => {
  it('gives it the name its terms describe', async () => {
    await scheme('13_M36_13', '13');
    await scheme('13_M36_MONTHLY', '13% - 36 Months - Monthly');
    await runMigration();
    expect(await nameOf('13_M36_13')).toBe('13% - 36 Months - Monthly');
  });

  it('changes nothing but the name — code, term and rate are untouched', async () => {
    const id = await scheme('13_M36_13', '13');
    await runMigration();
    const row = (await ctx.db.query(
      'SELECT code, tenure_months, coupon_rate_pct, payout_frequency, is_active FROM schemes WHERE id = $1',
      [id])).rows[0] as Record<string, unknown>;
    // The code is what the LockerHub integration matches on. It must not move.
    expect(row.code).toBe('13_M36_13');
    expect(Number(row.tenure_months)).toBe(36);
    expect(Number(row.coupon_rate_pct)).toBe(13);
    expect(row.payout_frequency).toBe('Monthly');
  });

  it('is safe to run twice, and leaves an already-named scheme alone', async () => {
    await scheme('13_M36_13', 'Something Deliberate');
    await runMigration();
    await runMigration();
    // It matched on the name "13" too, so a name someone chose is not clobbered.
    expect(await nameOf('13_M36_13')).toBe('Something Deliberate');
  });

  it('refuses if the two schemes no longer describe the same product', async () => {
    await scheme('13_M36_13', '13', 36, '13.0000');
    await scheme('13_M36_MONTHLY', '13% - 36 Months - Monthly', 60, '13.0000');
    // Sharing a name while the terms differ would misstate the product on a
    // certificate, so the migration stops rather than print a lie.
    await expect(runMigration()).rejects.toThrow(/no longer matches/);
  });
});
