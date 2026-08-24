/**
 * Authorised-user consent: recheck against Digio + download the signed letter
 * (owner 2026-08-22). The webhook may not have landed, so staff can pull the
 * live status; once signed, the signed consent is downloadable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { completeSigning } from '../src/integrations/digio/service.js';
import { saveBuffer } from '../src/lib/storage.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('authorised-user consent recheck + download', () => {
  it('rechecks a pending consent, and downloads it once signed', async () => {
    const a = await admin();
    const owner = await a.post('/api/customers', { full_name: 'Consent Holder', phone: '9765400001' });
    const add = await a.post('/api/lockers/applications/la_consent_1/authorised-users', {
      customer_id: owner.json.id, name: 'Auth Person', pan: 'ABCDE1234F', aadhaar: '111122223333', phone: '9765400002',
    });
    const id = add.json.id;

    // Recheck while pending — reachable, still pending (Digio is stubbed here).
    const rc = await a.post(`/api/lockers/authorised-users/${id}/consent/refresh`, {});
    expect(rc.status).toBe(200);
    expect(rc.json.consent_signed).toBe(false);

    // No signed copy yet → download 404s.
    expect((await a.get(`/api/lockers/authorised-users/${id}/consent.pdf`)).status).toBe(404);

    // Simulate the holder signing (same path the webhook/poller/recheck use).
    const sess = (await ctx.db.query('SELECT digio_request_id FROM digio_signing_sessions WHERE locker_authorised_user_id = $1', [id])).rows[0] as any;
    await completeSigning(ctx.db, sess.digio_request_id, {});

    // Now authorised, and the list says a signed copy is available.
    const list = await a.get('/api/lockers/applications/la_consent_1/authorised-users');
    expect(list.json.rows[0].consent_signed).toBe(true);
    expect(list.json.rows[0].has_consent_pdf).toBe(true);

    // Store a signed copy (Digio stub returns none) and confirm the download serves it.
    const { path } = saveBuffer('locker-consent', `consent-${id}.pdf`, Buffer.from('%PDF-1.4 signed consent'));
    await ctx.db.query('UPDATE locker_authorised_users SET consent_pdf_path = $2 WHERE id = $1', [id, path]);
    const dl = await a.raw(`/api/lockers/authorised-users/${id}/consent.pdf`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
    expect(dl.buffer.toString()).toContain('signed consent');
  });
});
