/**
 * §A18 settle-offline — money taken at the branch actually settles the leg.
 *
 * Until 2026-07-29 it could not: contract v1.2 retired A10 record-payment, so
 * clearing a cheque released NCD's own hold and nothing else, and a staff
 * member had to open LockerHub and mark the row paid by hand.
 *
 * Two rules carry the risk here and both are pinned below:
 *
 *   1. TAKING a cheque settles nothing — only CLEARING does. Settling on
 *      receipt would allot a locker against paper that can still bounce.
 *   2. A failed settle must NOT roll back the clear. The money really did
 *      clear; throwing would tell the operator otherwise. The divergence is
 *      recorded and shown instead, and the retry is idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; body: any }> = [];
/** Flip to make LockerHub refuse the next settle-offline. */
let settleFails = false;

const APP = 'la_settle';

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/\/settle-offline$/.test(url.pathname) && req.method === 'POST') {
        if (settleFails) return send(503, { error: 'upstream unavailable' });
        return send(200, { success: true, leg: body.leg, leg_settled: true, method: body.method });
      }
      return send(404, { error: 'not found: ' + url.pathname });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

// One pending cheque per (application, leg) is enforced, so each case gets its
// own application — otherwise the second `takeCheque` 409s on the first.
let n = 0;
async function takeCheque(leg: 'rent' | 'deposit' = 'rent', appId?: string) {
  appId = appId ?? `${APP}_${n + 1}`;
  const a = await admin();
  const r = await a.post('/api/lockers/cheques', {
    lockerhub_application_id: appId, leg, amount: 14160,
    cheque_no: `CHQ-${++n}`, bank_name: 'KVB', received_on: '2026-07-29',
  });
  expect(r.status).toBe(201);
  return Number(r.json.cheque.id);
}
const settleCalls = () => seen.filter((s) => /settle-offline$/.test(s.path));

describe('taking a cheque settles nothing', () => {
  it('recording one never calls LockerHub — it can still bounce', async () => {
    seen = [];
    await takeCheque();
    expect(settleCalls()).toHaveLength(0);
  });

  it('a bounced cheque never settles either', async () => {
    const id = await takeCheque();
    seen = [];
    const r = await (await admin()).post(`/api/lockers/cheques/${id}/bounce`, { reason: 'Insufficient funds' });
    expect(r.status).toBe(200);
    expect(settleCalls()).toHaveLength(0);
  });
});

describe('clearing a cheque settles the leg', () => {
  it('sends method=cheque with the bank reference and the cleared date', async () => {
    const id = await takeCheque('deposit');
    seen = [];
    const r = await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02', reference: 'UTR-77' });
    expect(r.status).toBe(200);
    expect(r.json.settled).toBe(true);

    const call = settleCalls()[0]!;
    expect(call.body.leg).toBe('deposit');
    expect(call.body.method).toBe('cheque');
    expect(call.body.reference).toBe('UTR-77');
    expect(call.body.received_on).toBe('2026-08-02');
    // Never our figure — their side derives the amount from the leg.
    expect(call.body.amount).toBeUndefined();
    // Their audit log must show the real person.
    expect(call.body.staff?.name).toBeTruthy();
  });

  it('falls back to the cheque number when there is no bank reference', async () => {
    const id = await takeCheque();
    seen = [];
    await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02' });
    expect(settleCalls()[0]!.body.reference).toMatch(/^CHQ-/);
  });

  it('stamps the row so the register can prove it settled', async () => {
    const id = await takeCheque();
    await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02' });
    const row = (await ctx.db.query('SELECT lockerhub_settled_at, lockerhub_error FROM locker_cheques WHERE id = $1', [id])).rows[0] as any;
    expect(row.lockerhub_settled_at).toBeTruthy();
    expect(row.lockerhub_error).toBeNull();
  });
});

describe('when LockerHub refuses, the money still cleared', () => {
  it('the clear succeeds, and says plainly that the leg did not settle', async () => {
    const id = await takeCheque();
    settleFails = true;
    try {
      const r = await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02' });
      expect(r.status).toBe(200);              // NOT an error — the cheque cleared
      expect(r.json.settled).toBe(false);
      expect(r.json.cheque.status).toBe('Cleared');
      expect(r.json.note).toMatch(/not settled|outstanding/i);
    } finally { settleFails = false; }

    const row = (await ctx.db.query('SELECT status, lockerhub_settled_at, lockerhub_error FROM locker_cheques WHERE id = $1', [id])).rows[0] as any;
    expect(row.status).toBe('Cleared');        // never rolled back
    expect(row.lockerhub_settled_at).toBeNull();
    expect(row.lockerhub_error).toBeTruthy();  // and the reason is kept
  });

  it('retrying afterwards settles it and clears the error', async () => {
    const id = await takeCheque();
    settleFails = true;
    try { await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02' }); }
    finally { settleFails = false; }

    const r = await (await admin()).post(`/api/lockers/cheques/${id}/settle-retry`, {});
    expect(r.json.settled).toBe(true);
    const row = (await ctx.db.query('SELECT lockerhub_settled_at, lockerhub_error FROM locker_cheques WHERE id = $1', [id])).rows[0] as any;
    expect(row.lockerhub_settled_at).toBeTruthy();
    expect(row.lockerhub_error).toBeNull();
  });

  it('retrying an ALREADY-settled cheque calls nobody', async () => {
    const id = await takeCheque();
    await (await admin()).post(`/api/lockers/cheques/${id}/clear`, { cleared_on: '2026-08-02' });
    seen = [];
    const r = await (await admin()).post(`/api/lockers/cheques/${id}/settle-retry`, {});
    expect(r.json.settled).toBe(true);
    expect(settleCalls()).toHaveLength(0);
  });

  it('a cheque that never cleared cannot be settled by retrying', async () => {
    const id = await takeCheque();
    seen = [];
    const r = await (await admin()).post(`/api/lockers/cheques/${id}/settle-retry`, {});
    expect(r.status).toBe(409);               // paper still in hand
    expect(settleCalls()).toHaveLength(0);
  });
});

describe('cash and transfer go straight through', () => {
  it('cash settles immediately, with no NCD-side instrument', async () => {
    seen = [];
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/settle-offline`, {
      leg: 'rent', method: 'cash', reference: 'RCPT-9', received_on: '2026-07-29',
    });
    expect(r.status).toBe(200);
    const call = settleCalls()[0]!;
    expect(call.body).toMatchObject({ leg: 'rent', method: 'cash', reference: 'RCPT-9' });
    const chq = (await ctx.db.query("SELECT count(*)::int n FROM locker_cheques WHERE lockerhub_application_id = $1 AND cheque_no = 'RCPT-9'", [APP])).rows[0] as any;
    expect(Number(chq.n)).toBe(0);
  });

  it('rejects cheque on this route — cheques must go through the register', async () => {
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/settle-offline`, { leg: 'rent', method: 'cheque' });
    expect(r.status).toBe(400);
  });

  it('rejects a leg it does not recognise', async () => {
    const r = await (await admin()).post(`/api/lockers/applications/${APP}/settle-offline`, { leg: 'maintenance', method: 'cash' });
    expect(r.status).toBe(400);
  });
});
