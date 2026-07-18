/**
 * Activation decoupled from allotment (docs + plan). An investment goes live —
 * status Active, interest schedule materialised, incentives accrued — at the
 * maker-checker ACTIVATION approval, right after money is credited. Allotment
 * is a later, data-neutral series step that only stamps allotment_date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

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

/** Create + confirm-collection → app sits in PendingActivation. */
async function fundApp(a: Client, name: string, amount: number, phone: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `7777${phone}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-10', method: 'NEFT' });
  return Number(app.json.id);
}

/** Maker (NCD Manager) submits activation for the series; distinct checker approves. */
async function activateSeries() {
  const ncd = await as('ncd@demo.local');
  const a = await admin();
  const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
  expect(batch.status).toBe(201);
  const ok = await a.post(`/api/approvals/${batch.json.request.id}/approve`);
  expect(ok.status).toBe(200);
}

describe('activation makes an investment live before allotment', () => {
  it('activation → Active + schedule + incentives, allotment_date still null', async () => {
    const a = await admin();
    const appId = await fundApp(a, 'Activation One', 500000, '9700000001');

    await activateSeries();

    const app = (await ctx.db.query('SELECT status, allotment_date, maturity_date FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.status).toBe('Active');
    expect(app.allotment_date).toBeNull();      // not allotted yet
    expect(app.maturity_date).toBeTruthy();     // maturity derived at activation
    const sched = (await ctx.db.query("SELECT count(*)::int AS n FROM disbursement_schedule WHERE application_id = $1", [appId])).rows[0] as any;
    expect(Number(sched.n)).toBeGreaterThan(0);
    const inc = (await ctx.db.query('SELECT count(*)::int AS n FROM incentive_accruals WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(inc.n)).toBeGreaterThan(0);
  });

  it('interest payout picks up the schedule BEFORE allotment', async () => {
    // The seeded app above is Active with a due schedule; a payout batch on the
    // first due date must find rows even though the series is not allotted.
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

  it('activation approval requires a distinct checker (maker ≠ checker)', async () => {
    const a = await admin();
    await fundApp(a, 'Distinct Checker', 300000, '9700000009');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
    expect(batch.status).toBe(201);
    // the maker cannot approve their own activation
    const self = await ncd.post(`/api/approvals/${batch.json.request.id}/approve`);
    expect(self.status).toBe(403);
  });
});

describe('closing a series with nothing pending (migrated-series case)', () => {
  it('a 0-pending Open series can be allotted → Allotted; a re-allot is then rejected', async () => {
    const a = await admin();
    // A series with no un-allotted apps — like a migrated series whose apps
    // already carry an allotment date. Insert a bare Open series directly.
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

    // Already Allotted with nothing pending → cannot allot again.
    const again = await ncd.post(`/api/allotments/series/${sid}`, { allotment_date: '2026-07-21' });
    expect(again.status).toBe(422);
  });
});
