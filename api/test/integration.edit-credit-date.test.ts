/**
 * Correcting ONE credit's date on a clubbed investment (owner 2026-08-27).
 *
 * A clubbed investment is ONE debenture paid for on several days — the owner's
 * example: 50,000 today, 50,000 tomorrow, 1,00,000 the day after — and each
 * credit earns from ITS OWN date. So a mistyped tranche date is real interest,
 * and editInvestmentDate cannot fix it: it refuses a clubbed investment because
 * there is no single date to move. Before this there was no way to correct one
 * on screen at all; it took a hand-written database repair (8 of those on
 * 2026-08-26).
 *
 * 🔒 interest-logic-locked — this DELIBERATELY changes a first period's day
 * count. The guards are the point: Super Admin only, refused once anything is
 * paid or batched, refused on a single-credit investment (where the credit and
 * the application must stay in step — moving only the credit is exactly the
 * mismatch the payout health check reports), and the schedule is rebuilt by the
 * real materialize rather than by editing figures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A clubbed investment: 50k on the 5th, 50k on the 6th, 1L on the 7th. */
async function clubbed(a: Client, name: string, phone: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const first = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 50000, date_money_received: '2026-07-05',
  });
  const appId = Number(first.json.id);
  for (const [amount, date] of [[50000, '2026-07-06'], [100000, '2026-07-07']] as const) {
    await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount, date_money_received: date, club_with_application_id: appId,
    });
  }
  await approveInvestment(await as('ncd@demo.local'), first);
  const lines = (await ctx.db.query(
    'SELECT id, amount, date_money_received FROM application_lines WHERE application_id = $1 ORDER BY id', [appId])).rows as any[];
  return { appId, lines };
}

const lineDate = async (lineId: number) => String(((await ctx.db.query(
  'SELECT date_money_received FROM application_lines WHERE id = $1', [lineId])).rows[0] as any).date_money_received).slice(0, 10);

describe('correct one credit date on a clubbed investment', () => {
  it('moves that credit only, and rebuilds its first period', async () => {
    const a = await superAdmin();
    const { appId, lines } = await clubbed(a, 'Credit Date A', '9704600001');
    const third = Number(lines[2].id);   // the 1,00,000 on the 7th

    const before = (await ctx.db.query(
      `SELECT gross_amount FROM disbursement_schedule
        WHERE line_id = $1 AND due_type = 'Interest' ORDER BY due_date LIMIT 1`, [third])).rows[0]! as any;

    // It actually arrived on the 9th, not the 7th.
    const r = await a.patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(200);
    expect(await lineDate(third)).toBe('2026-07-09');

    // The OTHER two credits are untouched — that is the whole point.
    expect(await lineDate(Number(lines[0].id))).toBe('2026-07-05');
    expect(await lineDate(Number(lines[1].id))).toBe('2026-07-06');

    // Its first period is genuinely rebuilt — two days later means less interest.
    const after = (await ctx.db.query(
      `SELECT gross_amount FROM disbursement_schedule
        WHERE line_id = $1 AND due_type = 'Interest' ORDER BY due_date LIMIT 1`, [third])).rows[0]! as any;
    expect(Number(after.gross_amount)).toBeLessThan(Number(before.gross_amount));

    // And the payout sheet follows the corrected date.
    const p = (await a.get('/api/payouts/preview?date=2026-07-28')).json;
    const row = (p.rows as any[]).find((x) => Number(x.line_id) === third)!;
    expect(String(row.from_date).slice(0, 10)).toBe('2026-07-09');
  });

  it('the payout health check stays silent afterwards', async () => {
    const a = await superAdmin();
    const { appId, lines } = await clubbed(a, 'Credit Date B', '9704600002');
    await a.patch(`/api/applications/${appId}/lines/${Number(lines[2].id)}/date`, { date: '2026-07-09' });
    const rows = (await a.get('/api/payouts/date-health')).json.rows as any[];
    expect(rows.filter((r) => Number(r.application_id) === appId)).toHaveLength(0);
  });

  it('refuses a single-credit investment — use the investment date instead', async () => {
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'Credit Date C', phone: '9704600003' });
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), create);
    const appId = Number(create.json.id);
    const lineId = Number(((await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1', [appId])).rows[0] as any).id);

    const r = await a.patch(`/api/applications/${appId}/lines/${lineId}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(400);
    expect(String(r.json.error?.message ?? r.json.message ?? '')).toMatch(/single credit/i);
    expect(await lineDate(lineId)).toBe('2026-07-05');   // unchanged
  });

  it('refuses once interest is paid or batched', async () => {
    const a = await superAdmin();
    const { appId, lines } = await clubbed(a, 'Credit Date D', '9704600004');
    await ctx.db.query(
      "UPDATE disbursement_schedule SET status = 'Paid' WHERE application_id = $1 AND due_type = 'Interest' AND due_date = (SELECT min(due_date) FROM disbursement_schedule WHERE application_id = $1 AND due_type = 'Interest')",
      [appId]);
    const third = Number(lines[2].id);
    const r = await a.patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(409);
    expect(await lineDate(third)).toBe('2026-07-07');   // unchanged
  });

  it('refuses anyone who is not a Super Admin', async () => {
    const sa = await superAdmin();
    const { appId, lines } = await clubbed(sa, 'Credit Date E', '9704600005');
    const third = Number(lines[2].id);
    const r = await (await as('ncd@demo.local')).patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(403);
    expect(await lineDate(third)).toBe('2026-07-07');   // unchanged
  });

  it('does not hand an unapproved investment a schedule as a side effect', async () => {
    // Pre-approval there is no schedule — it is generated at go-live from these
    // very dates. Correcting a typo must not materialise one early.
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'Credit Date H', phone: '9704600008' });
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 50000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-07', club_with_application_id: appId,
    });
    expect(club.json.clubbed).toBe(true);
    const rows = (await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1 ORDER BY id', [appId])).rows as any[];
    const second = Number(rows[1].id);
    const had = (await ctx.db.query('SELECT count(*)::int n FROM disbursement_schedule WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(had.n)).toBe(0);   // nothing yet, as expected

    const r = await a.patch(`/api/applications/${appId}/lines/${second}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(200);
    expect(await lineDate(second)).toBe('2026-07-09');
    const after = (await ctx.db.query('SELECT count(*)::int n FROM disbursement_schedule WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(after.n)).toBe(0);   // still none — no early materialisation
  });

  it("refuses a credit that belongs to a different investment", async () => {
    const a = await superAdmin();
    const one = await clubbed(a, 'Credit Date F', '9704600006');
    const two = await clubbed(a, 'Credit Date G', '9704600007');
    const foreign = Number(two.lines[0].id);
    const r = await a.patch(`/api/applications/${one.appId}/lines/${foreign}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(404);
    expect(await lineDate(foreign)).toBe('2026-07-05');   // unchanged
  });
});
