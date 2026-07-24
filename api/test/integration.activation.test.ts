/**
 * Investment approval = go-live (owner spec 2026-07-19). Staff enrol an
 * investment; it waits in PendingApproval until the admin (a DISTINCT checker)
 * approves it in Approvals — that one approval takes the NCD live: status
 * Active, interest schedule materialised, incentives accrued. There is no
 * separate "confirm collection" or batch-activation step. Allotment stays a
 * later, data-neutral series step that only stamps allotment_date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Enrol an investment (staff/admin maker). Sits in PendingApproval with an
 * investment approval raised. Returns the app id + the create response. */
async function enrol(a: Client, name: string, amount: number, phone: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `7777${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-10' });
  return { appId: Number(app.json.id), create: app };
}

describe('investment approval makes an NCD live before allotment', () => {
  it('approve → Active + schedule + incentives, allotment_date still null', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const { appId, create } = await enrol(a, 'Activation One', 500000, '9700000001');

    const beforeApp = (await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(beforeApp.status).toBe('PendingApproval');

    const ok = await approveInvestment(ncd, create);
    expect(ok.status).toBe(200);

    const app = (await ctx.db.query('SELECT status, allotment_date, maturity_date, interest_start_date FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.status).toBe('Active');
    expect(app.allotment_date).toBeNull();      // not allotted yet
    expect(app.maturity_date).toBeTruthy();     // maturity derived at go-live
    expect(String(app.interest_start_date)).toBe('2026-07-10'); // staff-entered credit date
    const sched = (await ctx.db.query("SELECT count(*)::int AS n FROM disbursement_schedule WHERE application_id = $1", [appId])).rows[0] as any;
    expect(Number(sched.n)).toBeGreaterThan(0);
    const inc = (await ctx.db.query('SELECT count(*)::int AS n FROM incentive_accruals WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(inc.n)).toBeGreaterThan(0);
  });

  it('interest payout picks up the schedule BEFORE allotment', async () => {
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-08-31' });
    expect(batch.status).toBe(201);
    expect(batch.json.count).toBeGreaterThan(0);
  });

  it('allotment only stamps allotment_date; no new schedule/incentive rows', async () => {
    const appId = (await ctx.db.query("SELECT id FROM applications WHERE status = 'Active' AND allotment_date IS NULL ORDER BY id LIMIT 1", [])).rows[0] as any;
    const id = Number(appId.id);
    const before = (await ctx.db.query("SELECT (SELECT count(*)::int FROM disbursement_schedule WHERE application_id=$1) AS s, (SELECT count(*)::int FROM incentive_accruals WHERE application_id=$1) AS i", [id])).rows[0] as any;

    const ncd = await as('ncd@demo.local');
    const a = await admin();
    const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    const after = (await ctx.db.query("SELECT status, allotment_date, (SELECT count(*)::int FROM disbursement_schedule WHERE application_id=$1) AS s, (SELECT count(*)::int FROM incentive_accruals WHERE application_id=$1) AS i FROM applications WHERE id=$1", [id])).rows[0] as any;
    expect(after.status).toBe('Active');
    expect(after.allotment_date).toBe('2026-07-20');
    expect(Number(after.s)).toBe(Number(before.s));   // unchanged
    expect(Number(after.i)).toBe(Number(before.i));   // unchanged
  });

  it('maturity redemption succeeds on an Active (already-allotted) app', async () => {
    const id = Number((await ctx.db.query("SELECT id FROM applications WHERE status = 'Active' ORDER BY id LIMIT 1", [])).rows[0]!.id);
    const ncd = await as('ncd@demo.local');
    const a = await admin();
    const init = await ncd.post('/api/redemptions/maturity', { application_id: id });
    expect(init.status).toBe(201);
    const ok = await a.post(`/api/approvals/${init.json.request.id}/approve`);
    expect(ok.status).toBe(200);
  });

  it('the investment approval requires a distinct checker (maker ≠ checker)', async () => {
    const a = await admin();
    const { create } = await enrol(a, 'Distinct Checker', 300000, '9700000009');
    // the maker (admin, who created the app) cannot approve their own investment
    const self = await approveInvestment(a, create);
    expect(self.status).toBe(403);
  });
});

describe('closing a series with nothing pending (migrated-series case)', () => {
  it('a 0-pending Open series can be allotted → Allotted; a re-allot is then rejected', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query(
      "INSERT INTO series (code, name, status, deemed_date) VALUES ('NCD CLOSE', 'NCD Close Test', 'Open', '2026-07-01') RETURNING id")).rows[0]!.id);
    const ncd = await as('ncd@demo.local');

    const batch = await ncd.post(`/api/allotments/series/${sid}`, { allotment_date: '2026-07-20' });
    expect(batch.status).toBe(201);
    expect(batch.json.count).toBe(0);                       // nothing pending, but allowed
    const ok = await a.post(`/api/approvals/${batch.json.request.id}/approve`);
    expect(ok.status).toBe(200);

    const s = (await ctx.db.query('SELECT status, allotted_at FROM series WHERE id = $1', [sid])).rows[0] as any;
    expect(s.status).toBe('Allotted');                      // series is now closed to new money
    expect(s.allotted_at).toBeTruthy();

    const again = await ncd.post(`/api/allotments/series/${sid}`, { allotment_date: '2026-07-21' });
    expect(again.status).toBe(422);
  });
});
