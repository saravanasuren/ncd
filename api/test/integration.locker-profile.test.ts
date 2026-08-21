/**
 * Locker profile — one page for a whole locker (owner 2026-08-07). It unions the
 * LockerHub-live locker/lease/rent/deposit + per-leg PAYMENT STATUS (item 2's
 * "reflect their payments in our screens") with NCD's own cheques, pledges and
 * waivers. A LockerHub outage must degrade to `lockerhub_error`, not a blank.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let lockerHubUp = true;
const APP = 'la_profile_1';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!lockerHubUp) return send(503, { error: 'upstream unavailable' });
    if (/\/esign\/status$/.test(url.pathname)) return send(200, { status: 'completed', esign_id: 'es_77' });
    // The real application record carries only branch_id — branch_name is resolved
    // from this list, exactly as production does (that's the bug this pins).
    if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br_dindigul', name: 'Dindigul' }] });
    if (/\/locker-applications\//.test(url.pathname)) {
      return send(200, {
        locker_size: 'XL', branch_id: 'br_dindigul', account_status: 'active',
        allotment: { locker_number: 'A-12', allotted_on: '2026-08-01' },
        lease_start: '2026-08-01', lease_expires_on: '2027-07-31',
        legs: { deposit: { amount: 300000, status: 'paid' }, rent: { amount: 23600, status: 'pending' } },
        payments: [{ purpose: 'deposit', amount: 300000, status: 'paid', reference: 'UTR-DEP-1', payment_method: 'rtgs', paid_at: '2026-08-02' }],
      });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker profile', () => {
  it('reflects LockerHub payment status and includes the NCD-side records', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Locker Owner', phone: '9846900001' });
    // An NCD cheque against this locker application.
    await a.post('/api/lockers/cheques', {
      lockerhub_application_id: APP, customer_id: cust.json.id, leg: 'rent',
      amount: 23600, cheque_no: 'CHQ-PRO-1', bank_name: 'KVB', received_on: '2026-08-01',
    });

    const p = await a.get(`/api/lockers/profile?application_id=${APP}`);
    expect(p.status).toBe(200);

    // Resolved NCD customer.
    expect(p.json.customer.full_name).toBe('Locker Owner');
    // Branch name resolved from branch_id (the record has no branch_name) — the
    // profile showed "—" before this was wired.
    expect(p.json.lockerhub.branch_name).toBe('Dindigul');
    // LockerHub-live locker facts passed through.
    expect(p.json.lockerhub.allotment.locker_number).toBe('A-12');
    expect(p.json.lockerhub.legs.deposit.status).toBe('paid');
    // e-sign status reflected.
    expect(p.json.esign.status).toBe('completed');
    // NCD-side cheque present.
    expect(p.json.cheques).toHaveLength(1);
    expect(p.json.cheques[0].cheque_no).toBe('CHQ-PRO-1');
    expect(p.json.lockerhub_error).toBeNull();
  });

  it('degrades to lockerhub_error when LockerHub is down, keeping NCD records', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Down Owner', phone: '9846900002' });
    await a.post('/api/lockers/cheques', {
      lockerhub_application_id: 'la_profile_down', customer_id: cust.json.id, leg: 'deposit',
      amount: 300000, cheque_no: 'CHQ-PRO-2', bank_name: 'HDFC', received_on: '2026-08-01',
    });

    lockerHubUp = false;
    try {
      const p = await a.get('/api/lockers/profile?application_id=la_profile_down');
      expect(p.status).toBe(200);          // never a blank page
      expect(p.json.lockerhub).toBeNull();
      expect(p.json.lockerhub_error).toBeTruthy();
      expect(p.json.cheques[0].cheque_no).toBe('CHQ-PRO-2');  // NCD records still shown
    } finally { lockerHubUp = true; }
  });
});
