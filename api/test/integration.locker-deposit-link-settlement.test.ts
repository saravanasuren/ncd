/**
 * A pledge LockerHub refused must leave a trace, be chaseable, and be retryable.
 *
 * linkDeposit pledges the investment locally — which immediately blocks that
 * money from redemption — and then tells LockerHub the deposit leg is NCD-backed
 * (§A12). If that call failed, the reason used to live only in the HTTP response
 * and a console line. The pledge still stood, so the customer's money was frozen
 * for good, the deposit leg stayed outstanding so the locker never allotted, and
 * nothing knew. 033's unique index made re-linking impossible, so there was no
 * way back at all. See migration 093.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seriesId: number, schemeId: number, custId: number;
/** Flip to make LockerHub refuse the next link-ncd. */
let linkFails = true;
const DEPOSIT = 100000;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const c = await (await admin()).post('/api/customers', { full_name: 'Pledge Cust', phone: '9521000001' });
  custId = c.json.id;

  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/\/link-ncd$/.test(url.pathname) && req.method === 'POST') {
      return linkFails ? send(503, { error: 'upstream unavailable' }) : send(200, { success: true, application_status: 'approved' });
    }
    if (/\/locker-applications\//.test(url.pathname) && req.method === 'GET') {
      return send(200, { locker_size: 'M', legs: { deposit: { amount: DEPOSIT } } });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function activeNcd(amount: number) {
  const a = await admin();
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: custId, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await approveInvestment(await as('ncd@demo.local'), app);
  return Number(app.json.id);
}
const linkRow = async (id: number) => (await ctx.db.query(
  'SELECT status, lockerhub_settled_at, lockerhub_error FROM locker_deposit_links WHERE id = $1', [id])).rows[0] as any;

describe('refused NCD deposit pledge', () => {
  it('records the refusal on the link, and the pledge still stands', async () => {
    const appId = await activeNcd(DEPOSIT);
    linkFails = true;
    const r = await (await admin()).post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'LKR-FAIL-1' });
    expect(r.status).toBe(201);
    expect(r.json.lockerhub_settled).toBe(false);
    expect(r.json.settle_error).toBeTruthy();

    // The money is pledged (and therefore frozen) either way — that is the whole
    // reason the failure has to be recorded rather than lost.
    const row = await linkRow(r.json.link_id);
    expect(row.status).toBe('active');
    expect(row.lockerhub_settled_at).toBeNull();
    expect(row.lockerhub_error).toBeTruthy();
  });

  it('surfaces it on the outstanding chase report', async () => {
    const rep = await (await admin()).get('/api/reports/outstanding');
    expect(rep.status).toBe(200);
    const mine = (rep.json.rows as any[]).filter((x) => x.kind === 'deposit_link_failed');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(String(mine[0].detail)).toMatch(/cannot be redeemed|still outstanding/i);
  });

  it('retrying settles it and clears the error', async () => {
    const appId = await activeNcd(DEPOSIT);
    linkFails = true;
    const made = await (await admin()).post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'LKR-FAIL-2' });
    const linkId = made.json.link_id;

    linkFails = false;
    const retry = await (await admin()).post(`/api/lockers/deposit-links/${linkId}/settle-retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.json.lockerhub_settled).toBe(true);

    const row = await linkRow(linkId);
    expect(row.lockerhub_settled_at).toBeTruthy();
    expect(row.lockerhub_error).toBeNull();
  });

  it('a second retry is a no-op, and a released pledge cannot be retried', async () => {
    const appId = await activeNcd(DEPOSIT);
    linkFails = false;
    const made = await (await admin()).post('/api/lockers/deposit-links', { application_id: appId, lockerhub_application_id: 'LKR-OK-1' });
    const linkId = made.json.link_id;
    expect(made.json.lockerhub_settled).toBe(true);

    const again = await (await admin()).post(`/api/lockers/deposit-links/${linkId}/settle-retry`, {});
    expect(again.json.lockerhub_settled).toBe(true);

    await (await admin()).post(`/api/lockers/deposit-links/${linkId}/release`, { reason: 'locker closed' });
    const afterRelease = await (await admin()).post(`/api/lockers/deposit-links/${linkId}/settle-retry`, {});
    expect(afterRelease.status).toBe(422);           // nothing to settle
  });
});
