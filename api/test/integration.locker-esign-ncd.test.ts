/**
 * NCD-run locker-agreement e-Sign (owner 2026-09-10, CEO-signature stage 3).
 *
 * The customer e-signs OUR own copy of the agreement via OUR Digio — a
 * digio_signing_sessions row (document_type 'locker_agreement') tied to the
 * locker_agreement_signings row. Digio is stubbed here (no creds), so the flow
 * is exercised without contacting anyone; completeSigning stands in for the
 * signature the poller would confirm.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { completeSigning } from '../src/integrations/digio/service.js';

let ctx: TestCtx;
let uid: number;
beforeAll(async () => {
  ctx = await startTestServer();
  uid = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'admin@dhanam.finance'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker agreement e-sign on our own copy', () => {
  it('initiates the customer e-sign and moves to CustomerSigned when they sign', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Esign Hirer', phone: '9700000055', pan: 'AAAPE1234Q', address: '2 Sign St' });
    const sig = await ctx.db.query<{ id: string }>(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, created_by_user_id)
       VALUES ('la_ncd_esign_1', $1, 'esign', 'Draft', $2) RETURNING id`, [cust.json.id, uid]);
    const signingId = Number(sig.rows[0]!.id);

    // Initiate — Digio is stubbed, so a synthetic request id comes back.
    const r = await a.post('/api/lockers/applications/la_ncd_esign_1/agreement/esign-initiate', {});
    expect(r.status).toBe(200);
    expect(r.json.stub).toBe(true);
    const reqId = r.json.digio_request_id as string;
    expect(reqId).toBeTruthy();

    // A locker-agreement Digio session was created and tied to the signing row.
    const sess = (await ctx.db.query<{ document_type: string; locker_agreement_signing_id: string; status: string }>(
      'SELECT document_type, locker_agreement_signing_id, status FROM digio_signing_sessions WHERE digio_request_id = $1', [reqId])).rows[0]!;
    expect(sess.document_type).toBe('locker_agreement');
    expect(Number(sess.locker_agreement_signing_id)).toBe(signingId);

    // The agreement is now awaiting the customer's signature, holding our Digio ref.
    const before = (await ctx.db.query<{ status: string; method: string; esign_reference: string }>(
      'SELECT status, method, esign_reference FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(before.method).toBe('esign');
    expect(before.status).toBe('AwaitingSignature');
    expect(before.esign_reference).toBe(reqId);

    // The customer signs (what the poller would confirm) → awaiting the CEO next.
    await completeSigning(ctx.db, reqId, {});
    const after = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(after.status).toBe('CustomerSigned');
  });
});
