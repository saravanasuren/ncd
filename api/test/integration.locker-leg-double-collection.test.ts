/**
 * One leg, one instrument.
 *
 * Both money paths guarded only their OWN table and only the OPEN state, so a
 * leg could be collected twice: a second cheque once the first CLEARED, a second
 * payment once the first was APPROVED, and either instrument on top of the other
 * because neither looked across. LockerHub answers the second settle with
 * `{already:true}`, so the leg is paid once there and the second collection is
 * real money with no refund record — and the enrolment screen shows only the
 * first. See lockers/legClaims.ts.
 *
 * The existing suites pin only the "second PENDING" case, which was never the
 * hole.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (c: number, o: unknown) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/\/settle-offline$/.test(url.pathname)) return send(200, { success: true, leg_settled: true });
    if (/\/locker-applications\//.test(url.pathname)) return send(200, { locker_size: 'M', legs: { rent: { amount: 14160 }, deposit: { amount: 100000 } } });
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
let n = 0;
const takeCheque = (app: string, leg = 'rent') => admin().then((a) => a.post('/api/lockers/cheques', {
  lockerhub_application_id: app, leg, amount: 14160, cheque_no: `CHQ-D${++n}`, bank_name: 'KVB', received_on: '2026-09-01',
}));
const clearCheque = (id: number) => admin().then((a) => a.post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-09-05', reference: 'UTR-1' }));
const takePayment = (app: string, leg = 'rent') => admin().then((a) => a.post(`/api/lockers/applications/${app}/offline-payment`, {
  leg, method: 'transfer', reference: `UTR-P${++n}`, amount: 14160,
}));

describe('a leg cannot be collected twice', () => {
  it('refuses a second cheque once the first has CLEARED', async () => {
    const app = 'la_dbl_1';
    const first = await takeCheque(app);
    expect(first.status).toBe(201);
    await clearCheque(first.json.cheque.id);

    const second = await takeCheque(app);
    expect(second.status).toBe(409);
    expect(second.json.error.message).toMatch(/already cleared|twice/i);
  });

  it('refuses a cash/transfer payment for a leg a cheque already holds', async () => {
    const app = 'la_dbl_2';
    const chq = await takeCheque(app);
    await clearCheque(chq.json.cheque.id);

    const pay = await takePayment(app);
    expect(pay.status).toBe(409);
    expect(pay.json.error.message).toMatch(/cheque/i);
    const n2 = (await ctx.db.query(
      'SELECT count(*)::int AS c FROM locker_offline_payments WHERE lockerhub_application_id = $1', [app])).rows[0] as any;
    expect(Number(n2.c)).toBe(0);
  });

  it('refuses a cheque for a leg an offline payment already holds', async () => {
    const app = 'la_dbl_3';
    const pay = await takePayment(app);
    expect(pay.status).toBe(201);

    const chq = await takeCheque(app);
    expect(chq.status).toBe(409);
    expect(chq.json.error.message).toMatch(/payment/i);
  });

  it('leaves the OTHER leg free', async () => {
    const app = 'la_dbl_4';
    const rent = await takeCheque(app, 'rent');
    expect(rent.status).toBe(201);
    const deposit = await takeCheque(app, 'deposit');
    expect(deposit.status).toBe(201);          // a different leg is untouched
  });

  it('frees the leg again once the instrument fails', async () => {
    const app = 'la_dbl_5';
    const chq = await takeCheque(app);
    await (await admin()).post(`/api/lockers/cheques/${chq.json.cheque.id}/bounce`, { reason: 'Insufficient funds' });

    // A bounced cheque collected nothing, so a fresh instrument must be allowed.
    const retry = await takeCheque(app);
    expect(retry.status).toBe(201);
    const pay = await takePayment('la_dbl_6');
    expect(pay.status).toBe(201);
  });
});
