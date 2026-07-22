/** Digio eSign: initiate (stub), webhook secret gate, completion stamps esigned_at. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await a.post('/api/customers', { full_name: 'Esign Cust', phone: '9990004444', email: 'es@example.com' }); // live on creation
  const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 400000 });
  appId = app.json.id;
});
afterAll(async () => { await ctx.close(); });

describe('digio esign', () => {
  it('initiate returns a stub session; webhook without the secret is 401; the flow is inert until creds land', async () => {
    const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const init = await a.post(`/api/applications/${appId}/esign/initiate`);
    expect(init.status).toBe(201);
    expect(init.json.stub).toBe(true);
    expect(init.json.digio_request_id).toMatch(/^STUB-DIGIO-REQ-/);

    // Webhook needs the secret. Test env has none set → every call is 401 (dormant).
    const r = await fetch(ctx.base + '/api/webhooks/digio/esign-complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: init.json.digio_request_id }),
    });
    expect(r.status).toBe(401);
    // App is not eSigned via a rejected webhook.
    const esigned = (await ctx.db.query('SELECT esigned_at FROM applications WHERE id = $1', [appId])).rows[0] as { esigned_at: string | null };
    expect(esigned.esigned_at).toBeNull();
  });

  it('the eSign document (the application form) is generatable for the application', async () => {
    // initiateSigning now attaches this PDF as the document Digio signs.
    const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const r = await a.raw(`/api/reports/application-form/${appId}.pdf`);
    expect(r.status).toBe(200);
    expect(r.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('completeSigning (poller/webhook path) stamps esigned_at, idempotently', async () => {
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    const reqId = (await ctx.db.query('SELECT digio_request_id FROM digio_signing_sessions WHERE application_id = $1', [appId])).rows[0] as { digio_request_id: string };
    const out = await completeSigning(ctx.db, reqId.digio_request_id, {});
    expect(out.ok).toBe(true);
    const first = (await ctx.db.query('SELECT esigned_at FROM applications WHERE id = $1', [appId])).rows[0] as { esigned_at: string | null };
    expect(first.esigned_at).not.toBeNull();
    // Idempotent — second call keeps the same stamp.
    await completeSigning(ctx.db, reqId.digio_request_id, {});
    const second = (await ctx.db.query('SELECT esigned_at FROM applications WHERE id = $1', [appId])).rows[0] as { esigned_at: string };
    expect(second.esigned_at).toBe(first.esigned_at);
  });
});

// Auto-completion (owner spec 2026-07-22): no webhook, no manual "Mark eSigned".
describe('esign auto-poll', () => {
  it('exposes esign_pending while a signature is out, and clears it on completion', async () => {
    const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Poll Cust', phone: '9990005555' });
    const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000 });
    const id = app.json.id;

    // Before any signing session → not pending.
    expect((await a.get(`/api/applications/${id}`)).json.esign_pending).toBe(false);

    await a.post(`/api/applications/${id}/esign/initiate`);
    expect((await a.get(`/api/applications/${id}`)).json.esign_pending).toBe(true);

    // No signed copy stored yet (stub mode) → the signed-application route 404s.
    expect((await a.get(`/api/reports/esigned/${id}.pdf`)).status).toBe(404);

    // Completion (what the 15s poller triggers) flips it without any manual step.
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    const reqId = (await ctx.db.query<{ digio_request_id: string }>(
      'SELECT digio_request_id FROM digio_signing_sessions WHERE application_id = $1', [id])).rows[0]!;
    await completeSigning(ctx.db, reqId.digio_request_id, {});

    const after = await a.get(`/api/applications/${id}`);
    expect(after.json.esign_pending).toBe(false);
    expect(after.json.application.esigned_at).not.toBeNull();
  });

  it('the poller is a no-op when Digio creds are absent (stub mode)', async () => {
    const { pollOutstanding } = await import('../src/integrations/digio/service.js');
    const out = await pollOutstanding(ctx.db);
    expect(out).toEqual({ checked: 0, signed: 0 });
  });
});
