/**
 * Locker authorised users (owner 2026-08-22): add a person (name/PAN/Aadhaar/
 * phone), the holder e-signs a consent letter, and only THEN is the person
 * authorised. Digio is unconfigured under test → createSignRequest stubs, so the
 * add succeeds and we drive the "signed" completion through completeSigning (the
 * same path the webhook/poller use) to prove the consent branch flips it active.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, requiredInvestmentFields, type TestCtx } from './helpers/server.js';
import { completeSigning } from '../src/integrations/digio/service.js';

let ctx: TestCtx;
const APP = 'la_auth_users_1';
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker authorised users', () => {
  it('adds a pending user, flips to active on consent, then revokes', async () => {
    const a = await admin();
    const owner = await a.post('/api/customers', { full_name: 'Locker Holder', phone: '9871200001' });

    // Add — comes back pending, with a (stub) signing URL for the holder.
    const add = await a.post(`/api/lockers/applications/${APP}/authorised-users`, {
      customer_id: owner.json.id, name: 'Trusted Person', pan: 'ABCDE1234F', aadhaar: '111122223333', phone: '9871200002',
    });
    expect(add.status).toBe(201);
    expect(add.json.id).toBeGreaterThan(0);
    expect(add.json.sign_url).toBeTruthy();

    // Listed as consent-pending, not yet authorised.
    let list = await a.get(`/api/lockers/applications/${APP}/authorised-users`);
    expect(list.json.rows).toHaveLength(1);
    expect(list.json.rows[0].name).toBe('Trusted Person');
    expect(list.json.rows[0].status).toBe('consent_pending');
    expect(list.json.rows[0].consent_signed).toBe(false);

    // The signing session is a consent letter, carries no application, and points
    // back at the authorised-user row.
    const sess = (await ctx.db.query(
      'SELECT digio_request_id, document_type, application_id FROM digio_signing_sessions WHERE locker_authorised_user_id = $1', [add.json.id])).rows[0] as any;
    expect(sess.document_type).toBe('locker_authorised_user_consent');
    expect(sess.application_id).toBeNull();

    // The holder signs → the consent branch flips the person to active.
    await completeSigning(ctx.db, sess.digio_request_id, {});
    list = await a.get(`/api/lockers/applications/${APP}/authorised-users`);
    expect(list.json.rows[0].status).toBe('active');
    expect(list.json.rows[0].consent_signed).toBe(true);
    expect(list.json.rows[0].consent_signed_at).toBeTruthy();

    // Signing again is idempotent — no error, still one active row.
    await completeSigning(ctx.db, sess.digio_request_id, {});
    list = await a.get(`/api/lockers/applications/${APP}/authorised-users`);
    expect(list.json.rows).toHaveLength(1);

    // Revoke drops it from the list.
    const rev = await a.post(`/api/lockers/authorised-users/${add.json.id}/revoke`, { reason: 'added by mistake' });
    expect(rev.status).toBe(200);
    list = await a.get(`/api/lockers/applications/${APP}/authorised-users`);
    expect(list.json.rows).toHaveLength(0);
  });

  it('rejects a nameless authorised user', async () => {
    const a = await admin();
    const r = await a.post(`/api/lockers/applications/${APP}/authorised-users`, { name: 'x' });
    expect(r.status).toBe(400);
  });

  it('an application form eSign still signs the application (consent branch is not taken)', async () => {
    // Guard: the polymorphic session change must not break the normal path.
    const a = await admin();
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Esign Owner', phone: '9871200009' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-10',
    });
    const appId = Number(app.json.id);
    const { initiateSigning } = await import('../src/integrations/digio/service.js');
    const admUser = { id: Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id), role: 'super_admin' } as any;
    const init = await initiateSigning(ctx.db, admUser, appId);
    await completeSigning(ctx.db, init.digio_request_id, {});
    const stamped = (await ctx.db.query('SELECT esigned_at FROM applications WHERE id=$1', [appId])).rows[0] as any;
    expect(stamped.esigned_at).toBeTruthy();
  });
});
