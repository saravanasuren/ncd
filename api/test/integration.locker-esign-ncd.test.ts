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
import { getSigning } from '../src/modules/lockers/agreements.js';
import { lockerAgreementPdf } from '../src/modules/reports/forms/locker-agreement.js';

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

  it('surfaces the customer sign-link on the signing view so the enroller can reopen it', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Reopen Link', phone: '9700000044', pan: 'AAAPR1234Q', address: '7 Link St' });
    const init = await a.post('/api/lockers/applications/la_ncd_esign_link/agreement/esign-initiate', { customer_id: Number(cust.json.id) });
    expect(init.status).toBe(200);

    // The Digio session holds the customer's link; getSigning must echo it back
    // so the enrolment screen shows "Open signing link" even after a reload.
    const sess = (await ctx.db.query<{ sign_url: string }>(
      'SELECT sign_url FROM digio_signing_sessions WHERE digio_request_id = $1', [init.json.digio_request_id as string])).rows[0]!;
    const view = await getSigning(ctx.db, 'la_ncd_esign_link');
    expect(view).toBeTruthy();
    expect(view!.method).toBe('esign');
    expect(view!.status).toBe('AwaitingSignature');
    expect(view!.customer_sign_url).toBe(sess.sign_url);
    expect(view!.customer_sign_url).toBeTruthy();
  });

  it('prints a joint hirer onto the agreement instead of a blank Hirer 2 block', async () => {
    const base = { customer: { full_name: 'Primary Hirer', pan: 'AAAPP1234Q', phone: '9700001111' } as never,
      locker: { lockerhub_application_id: 'la_render_jh' } };
    // Same document, once with no joint hirer and once with holder 2 filled.
    const blank = await lockerAgreementPdf(ctx.db, base);
    const withJoint = await lockerAgreementPdf(ctx.db, {
      ...base,
      hirers: [{ position: 2, full_name: 'Second Hirer', pan: 'BBBPP5678Q', address: '9 Joint St', phone: '9700002222' }],
    });
    // Both are valid PDFs, and the filled one is a DIFFERENT document — proof the
    // joint hirer is consumed by the renderer, not dropped into a blank block.
    expect(blank.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(withJoint.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(withJoint.buffer.equals(blank.buffer)).toBe(false);
    expect(withJoint.buffer.length).toBeGreaterThan(blank.buffer.length);
  });

  it('re-sending retires the old link and hands out a fresh one', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Resend Cust', phone: '9700003333', pan: 'AAAPS9876Q', address: '4 Resend St' });
    const first = await a.post('/api/lockers/applications/la_ncd_resend/agreement/esign-initiate', { customer_id: Number(cust.json.id) });
    expect(first.status).toBe(200);
    const firstReq = first.json.digio_request_id as string;

    // Re-send: a brand-new request, and the signing now references it.
    const second = await a.post('/api/lockers/applications/la_ncd_resend/agreement/esign-initiate', {});
    expect(second.status).toBe(200);
    const secondReq = second.json.digio_request_id as string;
    expect(secondReq).not.toBe(firstReq);

    // The OLD session is retired (cancelled) so the poller ignores it and a stale
    // link can't complete; the NEW one is the live 'requested' link.
    const sessions = (await ctx.db.query<{ digio_request_id: string; status: string }>(
      `SELECT d.digio_request_id, d.status FROM digio_signing_sessions d
         JOIN locker_agreement_signings s ON s.id = d.locker_agreement_signing_id
        WHERE s.lockerhub_application_id = 'la_ncd_resend' AND d.document_type = 'locker_agreement'`)).rows;
    const old = sessions.find((r) => r.digio_request_id === firstReq)!;
    const fresh = sessions.find((r) => r.digio_request_id === secondReq)!;
    expect(old.status).toBe('cancelled');
    expect(fresh.status).toBe('requested');

    // getSigning points the enroller at the fresh link, not the retired one.
    const view = await getSigning(ctx.db, 'la_ncd_resend');
    expect(view!.esign_reference).toBe(secondReq);
  });

  it('the CEO counter-signs a customer-signed agreement, then it is fully Signed', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'CEO Flow Hirer', phone: '9700000066', pan: 'AAAPC1234Q', address: '3 Sign St' });
    const sig = await ctx.db.query<{ id: string }>(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, created_by_user_id)
       VALUES ('la_ncd_esign_2', $1, 'esign', 'Draft', $2) RETURNING id`, [cust.json.id, uid]);
    const signingId = Number(sig.rows[0]!.id);

    // Customer signs first.
    const custInit = await a.post('/api/lockers/applications/la_ncd_esign_2/agreement/esign-initiate', {});
    await completeSigning(ctx.db, custInit.json.digio_request_id as string, {});
    // In stub mode nothing is downloaded from Digio, so stand in the customer-
    // signed copy the real flow would have stored (the CEO signs THIS file).
    const { saveBuffer } = await import('../src/lib/storage.js');
    const { path } = saveBuffer('locker-agreements', `signed-${signingId}.pdf`, Buffer.from('%PDF-1.4\n% customer signed\n'));
    await ctx.db.query('UPDATE locker_agreement_signings SET signed_doc_path = $1, signed_doc_mime = $2 WHERE id = $3', [path, 'application/pdf', signingId]);

    const ceo = await a.post('/api/lockers/applications/la_ncd_esign_2/agreement/ceo-esign-initiate', {});
    expect(ceo.status).toBe(200);
    const ceoReq = ceo.json.digio_request_id as string;
    expect(ceoReq).toBeTruthy();

    const sess = (await ctx.db.query<{ document_type: string }>(
      'SELECT document_type FROM digio_signing_sessions WHERE digio_request_id = $1', [ceoReq])).rows[0]!;
    expect(sess.document_type).toBe('locker_agreement_ceo');
    const mid = (await ctx.db.query<{ status: string }>('SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(mid.status).toBe('AwaitingCEO');

    // CEO signs → fully signed.
    await completeSigning(ctx.db, ceoReq, {});
    const done = (await ctx.db.query<{ status: string }>('SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(done.status).toBe('Signed');
  });

  it('refuses a CEO sign before the customer has signed', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Too Early', phone: '9700000077' });
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, created_by_user_id)
       VALUES ('la_ncd_esign_3', $1, 'esign', 'AwaitingSignature', $2)`, [cust.json.id, uid]);
    const r = await a.post('/api/lockers/applications/la_ncd_esign_3/agreement/ceo-esign-initiate', {});
    expect(r.status).toBe(400);
  });

  it('starts the e-sign even with no signing row yet, given a customer id', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Fresh Start', phone: '9700000088', pan: 'AAAPF1234Q', address: '9 New St' });
    // No locker_agreement_signings row exists — the enrolment button comes here.
    const r = await a.post('/api/lockers/applications/la_ncd_esign_4/agreement/esign-initiate', { customer_id: Number(cust.json.id) });
    expect(r.status).toBe(200);
    expect(r.json.digio_request_id).toBeTruthy();
    const row = (await ctx.db.query<{ status: string; method: string }>(
      "SELECT status, method FROM locker_agreement_signings WHERE lockerhub_application_id = 'la_ncd_esign_4'")).rows[0]!;
    expect(row.method).toBe('esign');
    expect(row.status).toBe('AwaitingSignature');
  });

  it('the awaiting-CEO queue lists a customer-signed agreement', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Queue Cust', phone: '9700000099', pan: 'AAAPQ1234Q', address: '5 Queue St' });
    const init = await a.post('/api/lockers/applications/la_ncd_esign_5/agreement/esign-initiate', { customer_id: Number(cust.json.id) });
    await completeSigning(ctx.db, init.json.digio_request_id as string, {});
    const q = await a.get('/api/lockers/agreements/awaiting-ceo');
    expect(q.status).toBe(200);
    const found = (q.json.rows as any[]).find((x) => x.application_id === 'la_ncd_esign_5');
    expect(found).toBeTruthy();
    expect(found.customer_name).toBe('Queue Cust');
  });
});
