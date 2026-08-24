/**
 * The investment-detail projected schedule consolidates a clubbed investment's
 * tranches (owner 2026-08-24, [[payout-tranche-consolidation]]): each tranche's
 * BROKEN first period stays its own row, but from the next date on a multi-tranche
 * investment shows ONE combined row per date — the same view the payout run pays.
 * A single-tranche investment is a group of one and is left unchanged.
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
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('projected schedule — clubbed tranches fold into one row after the broken period', () => {
  it('keeps per-tranche broken rows, then shows one combined row per later date', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Sched Clubbed', phone: '9703000001' });
    // Build a 3-tranche investment by clubbing while the app is still in-flight
    // (no approval gate), then take it live so the schedule materialises.
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    for (const amt of [100000, 100000]) {
      const club = await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
        amount: amt, date_money_received: '2026-07-05', club_with_application_id: appId,
      });
      expect(club.json.clubbed).toBe(true);
    }
    await approveInvestment(await as('ncd@demo.local'), first);

    const detail = await a.get(`/api/applications/${appId}`);
    const schedule = detail.json.schedule as any[];
    const interest = schedule.filter((r) => r.due_type === 'Interest');
    const dates = [...new Set(interest.map((r) => String(r.due_date)))].sort();

    // Earliest date = the broken first period → three separate tranche rows.
    const brokenRows = interest.filter((r) => String(r.due_date) === dates[0]);
    expect(brokenRows).toHaveLength(3);
    expect(brokenRows.every((r) => !r.combined)).toBe(true);

    // Every later date is a single combined row spanning all three tranches.
    for (const d of dates.slice(1)) {
      const rows = interest.filter((r) => String(r.due_date) === d);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.combined).toBe(true);
      expect(rows[0]!.tranche_count).toBe(3);
    }

    // The combined figure is the sum of the tranche rows for that date (each
    // tranche is ₹1,00,000, so the combined row is 3× a single tranche's gross).
    const secondDate = dates[1]!;
    const combined = interest.find((r) => String(r.due_date) === secondDate)!;
    // Recompute the per-tranche gross from a raw stored row to prove the sum.
    const rawOne = (await ctx.db.query(
      `SELECT gross_amount FROM disbursement_schedule ds JOIN application_lines l ON l.id = ds.line_id
        WHERE ds.application_id = $1 AND ds.due_date = $2 AND ds.due_type = 'Interest'
        ORDER BY ds.line_id LIMIT 1`, [appId, secondDate])).rows[0]!;
    expect(Number(combined.gross_amount)).toBe(3 * Number(rawOne.gross_amount));
  });

  it('leaves a single-tranche investment one row per date (unchanged)', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Sched Solo', phone: '9703000002' });
    const solo = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), solo);
    const schedule = (await a.get(`/api/applications/${solo.json.id}`)).json.schedule as any[];
    const interest = schedule.filter((r) => r.due_type === 'Interest');
    const byDate = new Map<string, number>();
    for (const r of interest) byDate.set(String(r.due_date), (byDate.get(String(r.due_date)) ?? 0) + 1);
    expect([...byDate.values()].every((n) => n === 1)).toBe(true);   // never more than one row a date
    expect(interest.every((r) => !r.combined)).toBe(true);          // nothing is flagged combined
  });
});
