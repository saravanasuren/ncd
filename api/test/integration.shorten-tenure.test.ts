/**
 * Bringing a term back IN (owner 2026-11-14: "for all the sd1,2,3,4,5 tenure is
 * 36 months, not 60").
 *
 * extend-tenure refuses to do this — "Shortening one would strand paid rows
 * past the new maturity" — and that refusal names the only thing here that can
 * cost real money. So the case pinned hardest below is the one where a payout
 * beyond the new maturity has ALREADY been paid: the line must be refused
 * whole, with nothing deleted and the term left at 60, rather than quietly
 * rescheduled around money that has gone out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const checker = () => as('ncd@demo.local');

let series = 0, scheme60 = 0;

/** A live 60-month investment on the test series, with its schedule built. */
async function invest(name: string, phone: string, amount = 500000): Promise<number> {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series, scheme_id: scheme60, amount, date_money_received: '2026-08-05',
  });
  if (!create.json?.subscription_request?.id) {
    throw new Error(`create failed: ${create.status} ${JSON.stringify(create.json).slice(0, 400)}`);
  }
  await approveInvestment(await checker(), create);
  return Number(create.json.id);
}

const sched = async (appId: number) => (await ctx.db.query<Record<string, unknown>>(
  `SELECT id, due_date::text AS due_date, due_type, status, batch_id, net_amount
     FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date, id`, [appId])).rows;

const lineOf = async (appId: number) => (await ctx.db.query<Record<string, unknown>>(
  `SELECT id, tenure_months, maturity_date::text AS maturity_date FROM application_lines WHERE application_id = $1`,
  [appId])).rows[0]!;

describe('shorten-tenure', () => {
  beforeAll(async () => {
    const s = await ctx.db.query<{ id: string }>(
      `INSERT INTO series (code, name, deemed_date, is_subordinate, close_date, status)
       VALUES ('SHORTEN-1', 'Shorten Test 1', '2026-08-01', TRUE, '2026-08-31', 'Open') RETURNING id`);
    series = Number(s.rows[0]!.id);
    // A 60-month scheme, cloned from a live one so TDS rule, face value and day
    // count are the real ones — the fields that would change money if invented.
    const sc = await ctx.db.query<{ id: string }>(
      `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                            min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
       SELECT 'SHORTEN_M60', 'Shorten Test 60 Months', 60, 'Monthly', 13, s.face_value,
              s.min_ticket, s.multiple_of, s.day_count_convention, s.commission_rule, s.tds_rule_id, TRUE
         FROM schemes s ORDER BY s.id LIMIT 1 RETURNING id`);
    scheme60 = Number(sc.rows[0]!.id);
  });

  it('refuses to lengthen a term — that is the other script', async () => {
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    await expect(shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 36, toMonths: 60, commit: false, quiet: true }))
      .rejects.toThrow(/only ever shortens/i);
  });

  it('a dry run changes nothing', async () => {
    const appId = await invest('Shorten Dry', '9613000001');
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');

    const before = await sched(appId);
    expect(before.length).toBeGreaterThan(36);           // a 60-month schedule exists

    const r = await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: false, quiet: true });
    expect(r.moved).toBeGreaterThanOrEqual(1);
    expect(r.deleted).toBeGreaterThan(0);
    expect(r.skipped).toBe(0);

    expect(await sched(appId)).toEqual(before);
    expect(Number((await lineOf(appId)).tenure_months)).toBe(60);
  });

  it('drops only what lies past the new maturity, and re-prices the new tail', async () => {
    const appId = await invest('Shorten Commit', '9613000002');
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    const before = await sched(appId);
    const oldMaturity = String((await lineOf(appId)).maturity_date);

    await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true });

    const line = await lineOf(appId);
    expect(Number(line.tenure_months)).toBe(36);
    const newMaturity = String(line.maturity_date);
    expect(newMaturity < oldMaturity).toBe(true);

    const after = await sched(appId);
    expect(after.length).toBeLessThan(before.length);
    // Exactly one Redemption, and it sits on the new maturity.
    const red = after.filter((r) => r.due_type === 'Redemption');
    expect(red.length).toBe(1);
    expect(String(red[0]!.due_date)).toBe(newMaturity);
    // The closing stub legitimately falls AFTER the redemption date — the
    // engine pays principal on the maturity date and settles the final
    // part-month on the following payout day (2029-08-01 then 2029-08-28). So
    // the invariant is not "nothing past the maturity": it is that no INTEREST
    // month survives past it, and that the schedule now ends one stub later
    // instead of two years later.
    expect(after.filter((r) => r.due_type === 'Interest' && String(r.due_date) > newMaturity)).toEqual([]);
    const last = after[after.length - 1]!;
    expect(last.due_type).toBe('BrokenInterest');
    expect(String(last.due_date) < oldMaturity).toBe(true);
    const daysAfter = (Date.parse(String(last.due_date)) - Date.parse(newMaturity)) / 86400000;
    expect(daysAfter).toBeGreaterThan(0);
    expect(daysAfter).toBeLessThanOrEqual(35);
    // Every row at or before the new maturity that existed before is untouched,
    // same id — not regenerated, which is what would have rewritten paid rows.
    const keptIds = new Set(after.map((r) => Number(r.id)));
    for (const r of before.filter((b) => String(b.due_date) <= newMaturity && b.due_type !== 'Redemption')) {
      expect(keptIds.has(Number(r.id))).toBe(true);
    }
    // And the application's own maturity followed the line back in.
    const app = (await ctx.db.query<{ maturity_date: string }>(
      'SELECT maturity_date::text AS maturity_date FROM applications WHERE id = $1', [appId])).rows[0]!;
    expect(app.maturity_date).toBe(newMaturity);
  });

  it('REFUSES a line whose money past the new maturity is already paid', async () => {
    // The hazard extend-tenure named. Nothing about this line may move.
    const appId = await invest('Shorten Paid Tail', '9613000003');
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    const rows = await sched(appId);
    // A row roughly four years out — well past a 36-month maturity.
    const far = rows[rows.length - 2]!;
    await ctx.db.query(`UPDATE disbursement_schedule SET status = 'Paid' WHERE id = $1`, [Number(far.id)]);

    const before = await sched(appId);
    const r = await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true });

    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.skips.join(' ')).toMatch(/already PAID/);
    // Refused whole: schedule identical, term still 60.
    expect(await sched(appId)).toEqual(before);
    expect(Number((await lineOf(appId)).tenure_months)).toBe(60);
  });

  it('REFUSES one whose far row is only batched, not yet paid', async () => {
    const appId = await invest('Shorten Batched Tail', '9613000004');
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    const rows = await sched(appId);
    const batch = await ctx.db.query<{ id: string }>(
      `INSERT INTO payout_batches (batch_no, kind, payout_date, status)
       VALUES ('SHORTEN-TEST-1', 'interest', '2030-08-28', 'PendingChecker') RETURNING id`);
    await ctx.db.query('UPDATE disbursement_schedule SET batch_id = $1 WHERE id = $2',
      [Number(batch.rows[0]!.id), Number(rows[rows.length - 2]!.id)]);

    const before = await sched(appId);
    const r = await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true });

    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.skips.join(' ')).toMatch(/BATCHED/);
    expect(await sched(appId)).toEqual(before);
    expect(Number((await lineOf(appId)).tenure_months)).toBe(60);
  });

  it('leaves a 36-month line alone — it is not even selected', async () => {
    const appId = await invest('Shorten Already Three Six', '9613000005');
    await ctx.db.query('UPDATE application_lines SET tenure_months = 36 WHERE application_id = $1', [appId]);
    const before = await sched(appId);
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true });
    expect(await sched(appId)).toEqual(before);
    expect(Number((await lineOf(appId)).tenure_months)).toBe(36);
  });

  it('moves the line onto the 36-month scheme, in the same breath as the term', async () => {
    // The customer app is sent scheme_name, never tenure_months, and the bond
    // certificate prints the same string. A corrected line left on
    // "13% - 60 Months - Monthly" still reads as sixty months to the holder
    // (owner 2026-11-14: "it should show 36 months, it showed 60 months").
    const appId = await invest('Scheme Relabelled', '9613000007');
    const target = await ctx.db.query<{ id: string }>(
      `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                            min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
       SELECT 'SHORTEN_M36', 'Shorten Test 36 Months', 36, s.payout_frequency, s.coupon_rate_pct, s.face_value,
              s.min_ticket, s.multiple_of, s.day_count_convention, s.commission_rule, s.tds_rule_id, TRUE
         FROM schemes s WHERE s.id = $1 RETURNING id`, [scheme60]);
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');

    await shortenTenure(ctx.db, {
      seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true, schemeCode: 'SHORTEN_M36',
    });

    const line = (await ctx.db.query<Record<string, unknown>>(
      `SELECT l.tenure_months, sch.code, sch.name FROM application_lines l
         JOIN schemes sch ON sch.id = l.scheme_id WHERE l.application_id = $1`, [appId])).rows[0]!;
    expect(Number(line.tenure_months)).toBe(36);
    expect(line.code).toBe('SHORTEN_M36');
    expect(String(line.name)).toMatch(/36 Months/);
    expect(Number(target.rows[0]!.id)).toBeGreaterThan(0);
  });

  it('REFUSES to relabel onto a scheme that would change money', async () => {
    // A scheme move may change the label and nothing else. A different TDS rule
    // or face value is a money change wearing a rename.
    const appId = await invest('Scheme Mismatch', '9613000008');
    await ctx.db.query(
      `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                            min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
       SELECT 'SHORTEN_BAD36', 'Shorten Bad 36', 36, s.payout_frequency, s.coupon_rate_pct, s.face_value + 1,
              s.min_ticket, s.multiple_of, s.day_count_convention, s.commission_rule, s.tds_rule_id, TRUE
         FROM schemes s WHERE s.id = $1`, [scheme60]);
    const before = await sched(appId);
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');

    const r = await shortenTenure(ctx.db, {
      seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true, schemeCode: 'SHORTEN_BAD36',
    });
    expect(r.skips.join(' ')).toMatch(/face value/i);
    expect(await sched(appId)).toEqual(before);
    expect(Number((await lineOf(appId)).tenure_months)).toBe(60);
  });

  it('refuses a scheme whose own tenure is not the new term', async () => {
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    await expect(shortenTenure(ctx.db, {
      seriesIds: [series], fromMonths: 60, toMonths: 36, commit: false, quiet: true, schemeCode: 'SHORTEN_M60',
    })).rejects.toThrow(/is 60 months, not 36/);
  });

  it('leaves an excluded scheme entirely alone, by name', async () => {
    // Owner 2026-11-14: "leave the doubling ones out." Pinned by NAME, because
    // the scheme guard only happens to refuse them today — Doubling is 20%
    // AtMaturity against a 13% monthly target — and a 20% 36-month scheme
    // appearing later would silently let them through. 20% simple over three
    // years returns 60%, not 100%: a shortened Doubling does not double.
    const dbl = await ctx.db.query<{ id: string }>(
      `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value,
                            min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id, is_active)
       SELECT 'SHORTEN_DBL', 'Shorten Doubling - 60 Months', 60, 'AtMaturity', 20, s.face_value,
              s.min_ticket, s.multiple_of, s.day_count_convention, s.commission_rule, s.tds_rule_id, TRUE
         FROM schemes s WHERE s.id = $1 RETURNING id`, [scheme60]);
    const appId = await invest('Doubling Left Out', '9613000009');
    await ctx.db.query('UPDATE application_lines SET scheme_id = $1 WHERE application_id = $2',
      [Number(dbl.rows[0]!.id), appId]);

    const before = await sched(appId);
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    const r = await shortenTenure(ctx.db, {
      seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true,
      schemeCode: 'SHORTEN_M36', excludeSchemeCodes: ['SHORTEN_DBL'],
    });

    expect(r.excluded).toBeGreaterThanOrEqual(1);
    // Excluded, NOT refused — a different outcome with a different meaning.
    expect(r.excludedNote.join(' ')).toMatch(/excluded by --exclude-scheme/);
    // Term, schedule and scheme all untouched.
    expect(await sched(appId)).toEqual(before);
    const line = (await ctx.db.query<Record<string, unknown>>(
      `SELECT l.tenure_months, sch.code FROM application_lines l JOIN schemes sch ON sch.id = l.scheme_id
        WHERE l.application_id = $1`, [appId])).rows[0]!;
    expect(Number(line.tenure_months)).toBe(60);
    expect(line.code).toBe('SHORTEN_DBL');
  });

  it('records what it did, per line', async () => {
    const appId = await invest('Shorten Audited', '9613000006');
    const { shortenTenure } = await import('../src/scripts/shorten-tenure.js');
    await shortenTenure(ctx.db, { seriesIds: [series], fromMonths: 60, toMonths: 36, commit: true, quiet: true });
    const lineId = Number((await lineOf(appId)).id);
    const log = (await ctx.db.query<Record<string, unknown>>(
      `SELECT before_data, after_data FROM audit_log
        WHERE action = 'investment.tenure_shortened' AND entity_id = $1`, [String(lineId)])).rows[0];
    expect(log).toBeTruthy();
    expect((log!.before_data as { tenure_months: number }).tenure_months).toBe(60);
    expect((log!.after_data as { tenure_months: number }).tenure_months).toBe(36);
    expect((log!.after_data as { schedule_rows_deleted?: number; note: string }).note).toMatch(/2026-11-14/);
  });
});
