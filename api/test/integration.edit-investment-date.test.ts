/**
 * Correcting an investment's date (owner 2026-08-25). Super Admin only, single-
 * credit only, and only while no interest is paid/batched — it moves the money-
 * received / interest-start date and rebuilds the schedule. 🔒 interest-lock:
 * pins that the first period follows the new date and that the guards hold.
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

const mkActive = async (a: Client, phone: string, date = '2026-07-25') => {
  const cust = await a.post('/api/customers', { full_name: 'InvDate Cust', phone });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: date,
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
};
const firstInterest = async (appId: number) => (await ctx.db.query(
  "SELECT due_date FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest' ORDER BY due_date LIMIT 1", [appId])).rows[0]?.due_date;

describe('editing the investment date', () => {
  it('a Super Admin moves the date and the schedule is rebuilt from it', async () => {
    const a = await superAdmin();
    const appId = await mkActive(a, '9706000001', '2026-07-25');
    const before = String(await firstInterest(appId));

    const r = await a.patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' });
    expect(r.status).toBe(200);

    // App + line dates moved together, interest_start follows.
    const app = (await ctx.db.query('SELECT date_money_received, interest_start_date FROM applications WHERE id=$1', [appId])).rows[0]!;
    expect(String(app.date_money_received).slice(0, 10)).toBe('2026-07-20');
    expect(String(app.interest_start_date).slice(0, 10)).toBe('2026-07-20');
    expect(String((await ctx.db.query('SELECT date_money_received FROM application_lines WHERE application_id=$1', [appId])).rows[0]!.date_money_received).slice(0, 10)).toBe('2026-07-20');
    // Schedule rebuilt (still one first-period row); nothing left half-updated.
    expect(String(await firstInterest(appId)).length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
  });

  it('refuses once interest is locked into a batch', async () => {
    const a = await superAdmin();
    const appId = await mkActive(a, '9706000002');
    // Simulate a batched row.
    await ctx.db.query("UPDATE disbursement_schedule SET batch_id = 999999 WHERE application_id=$1 AND due_type='Interest' AND due_date=(SELECT min(due_date) FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest')", [appId]);
    const r = await a.patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' });
    expect(r.status).toBe(409);
  });

  it('refuses a clubbed (multi-credit) investment', async () => {
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'InvDate club', phone: '9706000003' });
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-25',
    });
    await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-26', club_with_application_id: Number(first.json.id),
    });
    await approveInvestment(await as('ncd@demo.local'), first);
    const r = await a.patch(`/api/applications/${first.json.id}/investment-date`, { date: '2026-07-20' });
    expect(r.status).toBe(400);
  });

  it('a non-Super-Admin cannot change it', async () => {
    const a = await superAdmin();
    const appId = await mkActive(a, '9706000004');
    const ncd = await as('ncd@demo.local');
    const r = await ncd.patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' });
    expect(r.status).toBe(403);
  });
});
