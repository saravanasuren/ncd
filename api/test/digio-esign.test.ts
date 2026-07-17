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
  const cust = await a.post('/api/customers', { full_name: 'Esign Cust', phone: '9990004444', email: 'es@example.com' });
  const submit = await a.post(`/api/customers/${cust.json.id}/submit-for-approval`);
  const ncd = new Client(ctx.base); await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await ncd.post(`/api/approvals/${submit.json.request.id}/approve`);
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
