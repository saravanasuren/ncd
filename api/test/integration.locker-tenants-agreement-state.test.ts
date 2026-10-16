/**
 * The Locker Tenants roster must report where each agreement actually STANDS.
 *
 * Owner 2026-10-12: "i get to see all shows aggrement not signed - but some are
 * signed." The roster asked `WHERE status = 'Signed'` and painted every other
 * state red, so a locker the customer e-signed weeks ago looked identical to
 * one nobody had touched. On the live book: 3 of 55 ticked, while 20 carried
 * real signature progress.
 *
 * This drives the REAL roster (the query that was wrong), not the label helper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let adminId: number;

/** One locker per state we care about. */
const APPS = ['ag_done', 'ag_cust_signed', 'ag_part', 'ag_untouched', 'ag_none'] as const;

beforeAll(async () => {
  ctx = await startTestServer();
  adminId = Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id);
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br1', name: 'MAIN' }] });
    if (/\/locker-tenants$/.test(url.pathname)) {
      return send(200, { tenants: APPS.map((id, i) => ({
        tenant_id: `t_${id}`, application_id: id, branch_id: 'br1', branch_name: 'MAIN', size: 'Medium',
        locker_number: `L-${i}`, tenant: { name: `Tenant ${id}`, phone: `97000000${String(i).padStart(2, '0')}` },
      })) });
    }
    const m = url.pathname.match(/\/locker-applications\/([^/]+)$/);
    if (m) return send(200, { id: decodeURIComponent(m[1]!), branch_id: 'br1' });
    return send(404, {});
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

  const signing = async (app: string, method: string, status: string) => Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status, created_by_user_id)
     VALUES ($1,$2,$3,$4) RETURNING id`, [app, method, status, adminId])).rows[0]!.id);
  const hirer = (app: string, pos: number, name: string) => ctx.db.query(
    `INSERT INTO locker_application_hirers (lockerhub_application_id, position, full_name, created_by_user_id)
     VALUES ($1,$2,$3,$4)`, [app, pos, name, adminId]);
  const session = (signingId: number, pos: number, status: string, ref: string) => ctx.db.query(
    `INSERT INTO digio_signing_sessions (application_id, digio_request_id, status, document_type, locker_agreement_signing_id, signer_position)
     VALUES (NULL,$1,$2,'locker_agreement',$3,$4)`, [ref, status, signingId, pos]);

  await signing('ag_done', 'physical', 'Signed');
  await signing('ag_cust_signed', 'esign', 'CustomerSigned');
  // The live shape of the 11: two hirers, the first signed, the second never sent.
  const part = await signing('ag_part', 'esign', 'AwaitingSignature');
  await hirer('ag_part', 2, 'Joint Hirer');
  await session(part, 1, 'signed', 'req-part-1');
  // Sent, nobody has signed — must STAY red, or the fix is just the old bug inverted.
  const untouched = await signing('ag_untouched', 'esign', 'AwaitingSignature');
  await session(untouched, 1, 'requested', 'req-untouched-1');
  // 'ag_none' deliberately has no signing row at all.
});
afterAll(async () => {
  config.LOCKERHUB_API_URL = '';
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const roster = async () => {
  const r = await (await admin()).get('/api/lockers/tenants');
  expect(r.status).toBe(200);
  return new Map((r.json.rows as any[]).map((x) => [String(x.lockerhub_application_id), x]));
};

describe('locker tenants — agreement state', () => {
  it('a fully signed agreement still reads as signed, with its method', async () => {
    const r = (await roster()).get('ag_done');
    expect(r.agreement_signed).toBe(true);
    expect(r.agreement_method).toBe('physical');
    expect(r.agreement_label).toBe('Physically signed');
  });

  it('a customer-signed agreement is NOT reported as unsigned', async () => {
    const r = (await roster()).get('ag_cust_signed');
    expect(r.agreement_signed).toBe(false);          // not FULLY signed — true
    expect(r.agreement_progressed).toBe(true);       // …but it has a signature
    expect(r.agreement_label).toBe('Awaiting authorised signatory');
  });

  it('a part-signed agreement says how many hirers are done', async () => {
    const r = (await roster()).get('ag_part');
    expect(r.agreement_signed).toBe(false);
    expect(r.agreement_progressed).toBe(true);
    expect(r.agreement_signatures).toBe(1);
    expect(r.agreement_signers_needed).toBe(2);
    expect(r.agreement_label).toBe('1 of 2 hirers signed');
  });

  it('an agreement nobody has signed still reads as not signed', async () => {
    const r = (await roster()).get('ag_untouched');
    expect(r.agreement_progressed).toBe(false);
    expect(r.agreement_signatures).toBe(0);
  });

  it('a locker with no agreement at all reads as not signed', async () => {
    const r = (await roster()).get('ag_none');
    expect(r.agreement_signed).toBe(false);
    expect(r.agreement_progressed).toBe(false);
    expect(r.agreement_status).toBeNull();
  });
});
