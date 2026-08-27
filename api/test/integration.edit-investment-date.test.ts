/**
 * Correcting an investment's date now goes through maker/checker approval (owner
 * 2026-08-27). Maker: NCD Manager+; Checker: Admin/CXO. Single-credit only, and
 * only while no interest is paid/batched. 🔒 interest-lock: the change is HELD on
 * the approval and applied — schedule rebuilt from the new date — only on approve.
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
const dateOf = async (appId: number) =>
  String((await ctx.db.query('SELECT date_money_received FROM applications WHERE id=$1', [appId])).rows[0]!.date_money_received).slice(0, 10);

describe('changing the investment date needs approval', () => {
  it('an NCD Manager requests it, the change is HELD, and an Admin/CXO approval applies it', async () => {
    const admin = await superAdmin();
    const appId = await mkActive(admin, '9706000001', '2026-07-25');

    // NCD Manager (maker) requests — nothing changes yet.
    const ncd = await as('ncd@demo.local');
    const r = await ncd.patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' });
    expect(r.status).toBe(200);
    expect(r.json.pending_approval).toBe(true);
    const reqId = Number(r.json.approval_request.id);
    expect(await dateOf(appId)).toBe('2026-07-25');   // unchanged until approved

    // The maker cannot approve their own request.
    expect((await ncd.post(`/api/approvals/${reqId}/approve`)).status).toBe(403);
    // An Admin/CXO checker approves → applied.
    expect((await (await as('cxo@demo.local')).post(`/api/approvals/${reqId}/approve`)).status).toBe(200);

    // App + line dates moved together, interest_start follows, schedule rebuilt.
    const app = (await ctx.db.query('SELECT date_money_received, interest_start_date FROM applications WHERE id=$1', [appId])).rows[0]!;
    expect(String(app.date_money_received).slice(0, 10)).toBe('2026-07-20');
    expect(String(app.interest_start_date).slice(0, 10)).toBe('2026-07-20');
    expect(String((await ctx.db.query('SELECT date_money_received FROM application_lines WHERE application_id=$1', [appId])).rows[0]!.date_money_received).slice(0, 10)).toBe('2026-07-20');
    expect(Number((await ctx.db.query("SELECT count(*)::int n FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest'", [appId])).rows[0]!.n)).toBeGreaterThan(0);
  });

  it('a branch staff (below NCD Manager) cannot request it', async () => {
    const admin = await superAdmin();
    const appId = await mkActive(admin, '9706000004');
    const staff = await as('staff@demo.local');
    expect((await staff.patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' })).status).toBe(403);
  });

  it('refuses at request time once interest is locked into a batch', async () => {
    const admin = await superAdmin();
    const appId = await mkActive(admin, '9706000002');
    await ctx.db.query("UPDATE disbursement_schedule SET batch_id = 999999 WHERE application_id=$1 AND due_type='Interest' AND due_date=(SELECT min(due_date) FROM disbursement_schedule WHERE application_id=$1 AND due_type='Interest')", [appId]);
    expect((await (await as('ncd@demo.local')).patch(`/api/applications/${appId}/investment-date`, { date: '2026-07-20' })).status).toBe(409);
  });

  it('refuses a clubbed (multi-credit) investment', async () => {
    const admin = await superAdmin();
    const cust = await admin.post('/api/customers', { full_name: 'InvDate club', phone: '9706000003' });
    const first = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-25',
    });
    await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-26', club_with_application_id: Number(first.json.id),
    });
    await approveInvestment(await as('ncd@demo.local'), first);
    expect((await (await as('ncd@demo.local')).patch(`/api/applications/${first.json.id}/investment-date`, { date: '2026-07-20' })).status).toBe(400);
  });
});
