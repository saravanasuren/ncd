/**
 * "New investments" — recent 30 with no range, exact range when one is picked
 * (owner 2026-08-04).
 *
 * History: #160 made this tile show the last 30 whole-book and IGNORE the range
 * picker, because summing a quiet window read ₹0. That traded one problem for
 * another — picking "Today" no longer showed today. It was then hidden (#245).
 *
 * The rule now: no range → the 30 most recently funded, whole book. A range →
 * exactly what falls in it, uncapped. Today means today.
 *
 * The tile total and the drill list are built from the SAME rows, so they can
 * never disagree — that invariant is what this file guards hardest.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const cid = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
     VALUES ('NIT001','New Inv Tile','9733000001','Approved',TRUE) RETURNING id`)).rows[0]!.id);

  // 40 funded investments spread over past days, plus 3 funded TODAY. 40 > the
  // cap of 30, so "All" must trim and a range must not.
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.now() - (i + 5) * 86400000).toISOString().slice(0, 10);
    await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, allotment_date)
       VALUES ($1,$2,$3,'Active',100000,$4,$4)`, [`APP-NIT-${String(i).padStart(3, '0')}`, cid, seriesId, d]);
  }
  for (let i = 1; i <= 3; i++) {
    await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, allotment_date)
       VALUES ($1,$2,$3,'Active',250000,$4,$4)`, [`APP-NIT-TODAY-${i}`, cid, seriesId, TODAY]);
  }
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const overview = async (qs = '') => (await (await admin()).get(`/api/dashboard/overview${qs}`)).json;
const drill = async (qs = '') => (await (await admin()).get(`/api/dashboard/drill/new-investments${qs}`)).json;

describe('no range picked — the most recent 30', () => {
  it('counts 30, not the whole book', async () => {
    const o = await overview();
    expect(o.flow.new_investments).toBe(30);
    expect(o.flow.new_investments_recent).toBe(true);
  });

  it('they are the NEWEST 30 — today\'s three are in, the oldest are not', async () => {
    const d = await drill();
    const nos = (d.rows as any[]).map((r) => r.application_no);
    expect(nos).toHaveLength(30);
    for (let i = 1; i <= 3; i++) expect(nos).toContain(`APP-NIT-TODAY-${i}`);
    expect(nos).not.toContain('APP-NIT-040');     // the oldest of the 40
  });

  it('the tile total is the sum of exactly those rows', async () => {
    const [o, d] = [await overview(), await drill()];
    const summed = (d.rows as any[]).reduce((s, r) => s + Number(r.amount), 0);
    expect(Number(o.flow.money_in)).toBe(summed);
  });
});

describe('a range picked — exactly that range, uncapped', () => {
  it('Today shows today\'s three, not the recent 30', async () => {
    const qs = `?from=${TODAY}&to=${TODAY}`;
    const o = await overview(qs);
    expect(o.flow.new_investments).toBe(3);
    expect(o.flow.new_investments_recent).toBe(false);
    expect(Number(o.flow.money_in)).toBe(750000);   // 3 × ₹2,50,000
    const d = await drill(qs);
    expect((d.rows as any[]).every((r) => r.date_money_received?.slice(0, 10) === TODAY)).toBe(true);
  });

  it('a wide range is NOT trimmed to 30 — the cap is only for "All"', async () => {
    const qs = '?from=2000-01-01&to=2099-12-31';
    const o = await overview(qs);
    expect(o.flow.new_investments).toBeGreaterThan(30);
    expect(o.flow.new_investments_recent).toBe(false);
    expect((await drill(qs)).rows.length).toBe(o.flow.new_investments);
  });

  it('a quiet window honestly reads zero rather than falling back to recent activity', async () => {
    const qs = '?from=2015-01-01&to=2015-01-31';
    const o = await overview(qs);
    expect(o.flow.new_investments).toBe(0);
    expect(Number(o.flow.money_in)).toBe(0);
    expect((await drill(qs)).rows).toHaveLength(0);
  });
});

describe('the tile and its drill can never disagree', () => {
  for (const [label, qs] of [['All', ''], ['Today', `?from=${TODAY}&to=${TODAY}`], ['wide', '?from=2000-01-01&to=2099-12-31']] as const) {
    it(`${label}: count and total match the drill rows`, async () => {
      const [o, d] = [await overview(qs), await drill(qs)];
      expect(d.rows.length).toBe(o.flow.new_investments);
      expect(Number(o.flow.money_in)).toBe((d.rows as any[]).reduce((s, r) => s + Number(r.amount), 0));
    });
  }
});
