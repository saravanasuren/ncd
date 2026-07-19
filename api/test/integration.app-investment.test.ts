/**
 * Path B (owner spec 2026-07-19) — a dhanamfin-app investment goes live
 * INSTANTLY for the customer and surfaces on the Approvals page as a notice
 * (not a gate). With a referral code it's auto-attributed; without one the
 * admin assigns a staff/agent from the notice and the referrer incentive
 * re-accrues. Locker deposits (requires_approval) stay gated — covered in
 * integration.lockerhub-facade.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

/** POST an app payment through the LockerHub integration facade. */
function appPayment(overrides: Record<string, unknown>) {
  return fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
    method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ series_id: seriesId, scheme_id: schemeId, amount: 200000, provider: 'easebuzz', provider_ref: 'EZB', verified: true, ...overrides }),
  }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
}

describe('Path B — app investment goes live instantly + Approvals notice', () => {
  it('no referral code → live now, notice flagged for attribution, then admin assigns → re-accrues', async () => {
    const r = await appPayment({ customer_phone: '9400001001', customer_name: 'App Cust A', lockerhub_intent_no: 'LHB-1' });
    expect(r.status).toBe(200);
    const app = (await ctx.db.query("SELECT id, status FROM applications WHERE lockerhub_intent_no = 'LHB-1'")).rows[0] as any;
    expect(app.status).toBe('Active'); // instant live — customer sees it live

    // A notice sits on the Approvals page, flagged as needing attribution.
    const notice = (await ctx.db.query(
      "SELECT status, metadata FROM approval_requests WHERE request_type='app_investment' AND entity_id=$1", [String(app.id)])).rows[0] as any;
    expect(notice.status).toBe('Pending');
    expect(notice.metadata.needs_attribution).toBe(true);

    // No referrer accrual yet (no code given).
    const acc0 = (await ctx.db.query("SELECT count(*)::int n FROM incentive_accruals WHERE application_id=$1 AND matrix_cell='referrer'", [app.id])).rows[0] as any;
    expect(Number(acc0.n)).toBe(0);

    // Admin assigns an agent from the notice → referrer incentive re-accrues.
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Path B Agent', agent_code: 'AG-PB' });
    expect(ag.status).toBe(201);
    const assign = await a.post(`/api/applications/${app.id}/attribute-referrer`, { payee: 'AG-PB' });
    expect(assign.status).toBe(200);

    const acc = (await ctx.db.query("SELECT payee_type, payee_id, amount FROM incentive_accruals WHERE application_id=$1 AND matrix_cell='referrer'", [app.id])).rows as any[];
    expect(acc.length).toBe(1);
    expect(acc[0].payee_type).toBe('agent');
    expect(Number(acc[0].payee_id)).toBe(Number(ag.json.id));
    expect(Number(acc[0].amount)).toBe(4000); // fresh customer → referrer 2% of 2,00,000

    // Notice metadata now reflects it's resolved.
    const notice2 = (await ctx.db.query(
      "SELECT metadata FROM approval_requests WHERE request_type='app_investment' AND entity_id=$1", [String(app.id)])).rows[0] as any;
    expect(notice2.metadata.needs_attribution).toBe(false);
  });

  it('with a referral code → auto-attributed on ingest (no manual step)', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Coded Agent', agent_code: 'AG-CODE' });
    const r = await appPayment({ customer_phone: '9400001002', customer_name: 'App Cust B', lockerhub_intent_no: 'LHB-2', referred_by: 'AG-CODE' });
    expect(r.status).toBe(200);
    const app = (await ctx.db.query("SELECT id, status FROM applications WHERE lockerhub_intent_no = 'LHB-2'")).rows[0] as any;
    expect(app.status).toBe('Active');

    const acc = (await ctx.db.query("SELECT payee_type, payee_id FROM incentive_accruals WHERE application_id=$1 AND matrix_cell='referrer'", [app.id])).rows as any[];
    expect(acc.length).toBe(1);
    expect(Number(acc[0].payee_id)).toBe(Number(ag.json.id));

    // Its notice is not flagged for attribution.
    const notice = (await ctx.db.query(
      "SELECT metadata FROM approval_requests WHERE request_type='app_investment' AND entity_id=$1", [String(app.id)])).rows[0] as any;
    expect(notice.metadata.needs_attribution).toBe(false);
  });
});
