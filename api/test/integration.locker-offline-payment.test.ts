/**
 * Rent paid offline via approval (owner 2026-08-22). Staff record a payment
 * (cheque or transfer) + reference; the rent settles on LockerHub (§A18) and is
 * marked paid ONLY when an Admin/CXO approves. Nothing reaches LockerHub on the
 * request alone — the approval is the control.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/settle-offline$/.test(url.pathname) && req.method === 'POST') return send(200, { success: true, leg: body.leg, settled: true });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const manager = () => as('ncd@demo.local');
const settleCalls = () => seen.filter((s) => /\/settle-offline$/.test(s.path));

describe('rent paid offline — approval before paid', () => {
  it('records a transfer, settles on LockerHub only on approval', async () => {
    const appId = 'la_pay_1';
    seen = [];
    const rec = await (await manager()).post(`/api/lockers/applications/${appId}/offline-payment`, { method: 'transfer', reference: 'UTR-99887766', amount: 20000 });
    expect(rec.status).toBe(201);
    expect(rec.json.status).toBe('PendingApproval');
    expect(settleCalls()).toHaveLength(0);   // the control — nothing settled yet

    const row = (await ctx.db.query(
      "SELECT id, method, reference, status, lockerhub_settled_at, approval_request_id FROM locker_offline_payments WHERE lockerhub_application_id = $1", [appId])).rows[0] as any;
    expect(row.method).toBe('transfer');
    expect(row.status).toBe('PendingApproval');
    expect(row.lockerhub_settled_at).toBeNull();

    // Admin approves → settle-offline is sent with the method + reference.
    const ok = await (await admin()).post(`/api/approvals/${row.approval_request_id}/approve`);
    expect(ok.status).toBe(200);
    expect(settleCalls()[0]!.body).toMatchObject({ leg: 'rent', method: 'transfer', reference: 'UTR-99887766' });
    const after = (await ctx.db.query("SELECT status, lockerhub_settled_at FROM locker_offline_payments WHERE id = $1", [row.id])).rows[0] as any;
    expect(after.status).toBe('Approved');
    expect(after.lockerhub_settled_at).toBeTruthy();
  });

  it('rejecting settles nothing and marks it Rejected', async () => {
    const appId = 'la_pay_2';
    const rec = await (await admin()).post(`/api/lockers/applications/${appId}/offline-payment`, { method: 'cheque', reference: 'CHQ-4521' });
    const row = (await ctx.db.query("SELECT approval_request_id FROM locker_offline_payments WHERE lockerhub_application_id = $1", [appId])).rows[0] as any;
    seen = [];
    const r = await (await admin()).post(`/api/approvals/${row.approval_request_id}/reject`, { reason: 'wrong reference' });
    expect(r.status).toBe(200);
    expect(settleCalls()).toHaveLength(0);
    const after = (await ctx.db.query("SELECT status FROM locker_offline_payments WHERE lockerhub_application_id = $1", [appId])).rows[0] as any;
    expect(after.status).toBe('Rejected');
  });

  it('refuses a second pending payment on the same leg, and needs a reference', async () => {
    const appId = 'la_pay_3';
    expect((await (await admin()).post(`/api/lockers/applications/${appId}/offline-payment`, { method: 'transfer', reference: 'UTR-1' })).status).toBe(201);
    expect((await (await admin()).post(`/api/lockers/applications/${appId}/offline-payment`, { method: 'transfer', reference: 'UTR-2' })).status).toBe(409);
    expect((await (await admin()).post(`/api/lockers/applications/la_pay_4/offline-payment`, { method: 'transfer', reference: '' })).status).toBe(400);
  });
});
