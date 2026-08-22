/**
 * Remember the locker chosen at enrolment (owner 2026-08-22). The pick used to
 * live only in the browser, so a resume lost it and allotment re-asked. It is
 * now persisted on create and echoed back on GET, so a resumed application allots
 * the same number.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
const APP_ID = 'la_intended_1';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && /\/locker-applications$/.test(url.pathname)) return send(200, { id: APP_ID, application_no: 'APP-INT-1', status: 'created' });
    if (req.method === 'POST' && /\/waiver$/.test(url.pathname)) return send(200, { success: true, leg_settled: true });
    if (req.method === 'GET' && /\/locker-applications\/[^/]+$/.test(url.pathname)) return send(200, { id: APP_ID, application_no: 'APP-INT-1', status: 'esign_pending', locker_size: 'Large', branch_id: 'br1' });
    return send(404, {});
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('the locker chosen at enrolment is remembered', () => {
  it('persists on create and is echoed back on resume', async () => {
    const a = await admin();
    const create = await a.post('/api/lockers/applications', {
      phone: '9812300001', name: 'Chooser', branch_id: 'br1', locker_size: 'Large',
      locker_id: 'lk_777', locker_number: 'L10-2',
    });
    expect(create.status).toBe(201);
    expect(create.json.intended_locker).toMatchObject({ locker_id: 'lk_777', locker_number: 'L10-2' });

    // Stored, keyed on the application id.
    const row = (await ctx.db.query('SELECT locker_id, locker_number FROM locker_intended_locker WHERE lockerhub_application_id = $1', [APP_ID])).rows[0] as any;
    expect(row.locker_id).toBe('lk_777');
    expect(row.locker_number).toBe('L10-2');

    // Reopening the application echoes it back, so allotment uses it, not a re-ask.
    const resumed = await a.get(`/api/lockers/applications/${APP_ID}`);
    expect(resumed.json.intended_locker).toMatchObject({ locker_id: 'lk_777', locker_number: 'L10-2' });
  });

  it('an application created without a chosen locker has no intended locker', async () => {
    const a = await admin();
    // Distinct id from the mock isn't possible here (mock returns APP_ID), so
    // assert the GET path is null-safe when no row exists.
    const r = await a.get('/api/lockers/applications/la_never_chosen');
    expect(r.status).toBe(200);
    expect(r.json.intended_locker).toBeUndefined();
  });
});
