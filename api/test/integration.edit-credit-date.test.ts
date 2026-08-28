/**
 * Correcting ONE credit's date on a clubbed investment (owner 2026-08-27).
 *
 * A clubbed investment is ONE debenture paid for on several days — the owner's
 * example: 50,000 today, 50,000 tomorrow, 1,00,000 the day after — and each
 * credit earns from ITS OWN date. So a mistyped credit date is real interest,
 * and editInvestmentDate cannot fix it: it refuses a clubbed investment because
 * there is no single date to move. Before this there was no way to correct one
 * on screen at all; it took a hand-written database repair (8 of those on
 * 2026-08-26).
 *
 * 🔒 interest-logic-locked — this DELIBERATELY changes a first period's day
 * count, so it is maker/checker, exactly like the investment-date change (#355,
 * owner: "the change of date of an investment should be only done by admins and
 * also should go through an approval process"). Both rebuild the schedule and
 * shift a first period, so both carry the same gate. Maker: NCD Manager+;
 * checker: Admin/CXO. NOTHING changes until a checker approves.
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
/** Maker: NCD Manager. Checker: Admin/CXO — a DIFFERENT human (rule zero). */
const maker = () => as('ncd@demo.local');
const checker = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A clubbed investment: 50k on the 5th, 50k on the 6th, 1L on the 7th. */
async function clubbed(name: string, phone: string) {
  const a = await checker();   // created by the admin so the NCD manager is free to be maker
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
  await approveInvestment(await maker(), first);
  const lines = (await ctx.db.query(
    'SELECT id, amount, date_money_received FROM application_lines WHERE application_id = $1 ORDER BY id', [appId])).rows as any[];
  return { appId, lines };
}

const lineDate = async (lineId: number) => String(((await ctx.db.query(
  'SELECT date_money_received FROM application_lines WHERE id = $1', [lineId])).rows[0] as any).date_money_received).slice(0, 10);
const firstGross = async (lineId: number) => Number(((await ctx.db.query(
  `SELECT gross_amount FROM disbursement_schedule WHERE line_id = $1 AND due_type = 'Interest' ORDER BY due_date LIMIT 1`,
  [lineId])).rows[0] as any).gross_amount);

describe('correct one credit date on a clubbed investment', () => {
  it('does NOT change the date until a checker approves', async () => {
    const { appId, lines } = await clubbed('Credit Date A', '9704600001');
    const third = Number(lines[2].id);   // the 1,00,000 on the 7th
    const before = await firstGross(third);

    // It actually arrived on the 9th, not the 7th.
    const r = await (await maker()).patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(200);
    expect(r.json.pending_approval).toBe(true);
    // THE POINT: nothing has moved yet.
    expect(await lineDate(third)).toBe('2026-07-07');
    expect(await firstGross(third)).toBe(before);

    const reqId = Number(r.json.approval_request.id);
    const ok = await (await checker()).post(`/api/approvals/${reqId}/approve`);
    expect(ok.status).toBe(200);

    // Now it moves — and only this credit.
    expect(await lineDate(third)).toBe('2026-07-09');
    expect(await lineDate(Number(lines[0].id))).toBe('2026-07-05');
    expect(await lineDate(Number(lines[1].id))).toBe('2026-07-06');
    // Two days later means less interest in its first period.
    expect(await firstGross(third)).toBeLessThan(before);

    // And the payout sheet follows the corrected date.
    const p = (await (await checker()).get('/api/payouts/preview?date=2026-07-28')).json;
    const row = (p.rows as any[]).find((x) => Number(x.line_id) === third)!;
    expect(String(row.from_date).slice(0, 10)).toBe('2026-07-09');
  });

  it('the payout health check stays silent afterwards', async () => {
    const { appId, lines } = await clubbed('Credit Date B', '9704600002');
    const r = await (await maker()).patch(`/api/applications/${appId}/lines/${Number(lines[2].id)}/date`, { date: '2026-07-09' });
    await (await checker()).post(`/api/approvals/${Number(r.json.approval_request.id)}/approve`);
    const rows = (await (await checker()).get('/api/payouts/date-health')).json.rows as any[];
    expect(rows.filter((x) => Number(x.application_id) === appId)).toHaveLength(0);
  });

  it('refuses a single-credit investment — use the investment date instead', async () => {
    const a = await checker();
    const cust = await a.post('/api/customers', { full_name: 'Credit Date C', phone: '9704600003' });
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await maker(), create);
    const appId = Number(create.json.id);
    const lineId = Number(((await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1', [appId])).rows[0] as any).id);

    const r = await (await maker()).patch(`/api/applications/${appId}/lines/${lineId}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(400);
    expect(String(r.json.error?.message ?? '')).toMatch(/single credit/i);
    expect(await lineDate(lineId)).toBe('2026-07-05');
  });

  it('refuses once interest is paid or batched', async () => {
    const { appId, lines } = await clubbed('Credit Date D', '9704600004');
    await ctx.db.query(
      "UPDATE disbursement_schedule SET status = 'Paid' WHERE application_id = $1 AND due_type = 'Interest' AND due_date = (SELECT min(due_date) FROM disbursement_schedule WHERE application_id = $1 AND due_type = 'Interest')",
      [appId]);
    const third = Number(lines[2].id);
    const r = await (await maker()).patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(409);
    expect(await lineDate(third)).toBe('2026-07-07');
  });

  it('branch staff cannot even request it', async () => {
    const { appId, lines } = await clubbed('Credit Date E', '9704600005');
    const third = Number(lines[2].id);
    const r = await (await as('staff@demo.local')).patch(`/api/applications/${appId}/lines/${third}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(403);
    expect(await lineDate(third)).toBe('2026-07-07');
  });

  it('does not hand an unapproved investment a schedule as a side effect', async () => {
    // Pre-approval there is no schedule — it is generated at go-live from these
    // very dates. Correcting a typo must not materialise one early.
    const a = await checker();
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
    expect(Number(((await ctx.db.query('SELECT count(*)::int n FROM disbursement_schedule WHERE application_id = $1', [appId])).rows[0] as any).n)).toBe(0);

    const r = await (await maker()).patch(`/api/applications/${appId}/lines/${second}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(200);
    await (await checker()).post(`/api/approvals/${Number(r.json.approval_request.id)}/approve`);
    expect(await lineDate(second)).toBe('2026-07-09');
    expect(Number(((await ctx.db.query('SELECT count(*)::int n FROM disbursement_schedule WHERE application_id = $1', [appId])).rows[0] as any).n)).toBe(0);
  });

  it("refuses a credit that belongs to a different investment", async () => {
    const one = await clubbed('Credit Date F', '9704600006');
    const two = await clubbed('Credit Date G', '9704600007');
    const foreign = Number(two.lines[0].id);
    const r = await (await maker()).patch(`/api/applications/${one.appId}/lines/${foreign}/date`, { date: '2026-07-09' });
    expect(r.status).toBe(404);
    expect(await lineDate(foreign)).toBe('2026-07-05');
  });
});
