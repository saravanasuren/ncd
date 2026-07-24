/**
 * NCD → LockerHub AGENT-event webhook (contract §Events channel 1).
 *
 * The dispatcher was ported long ago but `enqueueEvent` had ZERO callers, so no
 * agent event ever fired. These tests pin the three domain emit points —
 * customer_activated / incentive_accrued / incentive_paid — plus the HMAC wire
 * format, so the agent app's earnings screens can't silently stay empty again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';
import { config } from '../src/config.js';
import { dispatchPending } from '../src/integrations/lockerhub/dispatcher.js';

let ctx: TestCtx;
let mock: Server;
let received: Array<{ event: string | undefined; sig: string | undefined; ts: string | undefined; raw: string; body: any }> = [];
const SECRET = 'agent-webhook-test-secret';

async function login(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const seriesId = () => ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'").then((r: any) => Number(r.rows[0].id));
const schemeId = () => ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'").then((r: any) => Number(r.rows[0].id));

/** An agent mirrored from LockerHub — only these get events. */
async function lockerhubAgent(lhUserId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO agents (agent_code, full_name, lockerhub_user_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [`LHA-${lhUserId}`, name, lhUserId]);
  return Number(rows[0]!.id);
}

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({
        event: req.headers['x-dhanam-event'] as string,
        sig: req.headers['x-dhanam-signature'] as string,
        ts: req.headers['x-dhanam-timestamp'] as string,
        raw, body: JSON.parse(raw || '{}'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_WEBHOOK_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/webhooks/wealth-agent`;
  config.LOCKERHUB_WEBHOOK_SECRET = SECRET; // arm the (otherwise dormant) webhook
});
afterAll(async () => {
  config.LOCKERHUB_WEBHOOK_URL = undefined;
  config.LOCKERHUB_WEBHOOK_SECRET = undefined;
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

/** Take an investment referred by `agentName` all the way to Active. */
async function liveInvestmentReferredBy(staff: Client, agentName: string, phone: string, amount = 500000) {
  const cust = await staff.post('/api/customers', { full_name: uniqueName('Agent Cust', phone), phone, referred_by_text: agentName });
  const app = await staff.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cust.json.id, series_id: await seriesId(), scheme_id: await schemeId(), amount, date_money_received: '2026-07-01',
  });
  const ncd = await login('ncd@demo.local');
  await ncd.post(`/api/approvals/${app.json.subscription_request.id}/approve`); // go-live
  return { appId: Number(app.json.id), customerId: Number(cust.json.id) };
}

describe('agent-event webhooks (contract §Events channel 1)', () => {
  it('activation enqueues customer_activated AND incentive_accrued for a LockerHub agent', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const agentId = await lockerhubAgent(910001, 'Webhook Agent One');
    const { appId, customerId } = await liveInvestmentReferredBy(staff, 'Webhook Agent One', '9871000001');

    const { rows } = await ctx.db.query<{ event_type: string; dedup_key: string; payload: any; target_agent_id: string }>(
      'SELECT event_type, dedup_key, payload, target_agent_id FROM agent_event_webhooks ORDER BY event_type');
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('customer_activated');
    expect(types).toContain('incentive_accrued');

    const act = rows.find((r) => r.event_type === 'customer_activated')!;
    expect(Number(act.target_agent_id)).toBe(agentId);
    expect(act.dedup_key).toBe(`customer_activated:${customerId}:agent:${agentId}`);
    expect(act.payload.customer_id).toBe(customerId);
    expect(act.payload.activated_at).toBeTruthy();
    // Every payload carries the contract's four standard fields.
    expect(act.payload.event).toBe('customer_activated');
    expect(act.payload.agent_id).toBe(agentId);
    expect(act.payload.lockerhub_user_id).toBe(910001);
    expect(act.payload.fired_at).toBeTruthy();

    const acc = rows.find((r) => r.event_type === 'incentive_accrued')!;
    expect(acc.dedup_key).toBe(`incentive_accrued:${appId}:agent:${agentId}`);
    expect(acc.payload.application_id).toBe(appId);
    expect(Number(acc.payload.amount)).toBeGreaterThan(0);
  });

  it('paying the incentive enqueues incentive_paid', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const agentId = await lockerhubAgent(910002, 'Webhook Agent Two');
    const { appId } = await liveInvestmentReferredBy(staff, 'Webhook Agent Two', '9871000002');

    const pay = await staff.post(`/api/incentives/payees/agent/${agentId}/accruals/${appId}/pay`, {});
    expect(pay.status).toBe(200);

    const { rows } = await ctx.db.query<{ dedup_key: string; payload: any }>(
      "SELECT dedup_key, payload FROM agent_event_webhooks WHERE event_type = 'incentive_paid' AND target_agent_id = $1", [agentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.application_id).toBe(appId);
    expect(Number(rows[0]!.payload.amount)).toBeGreaterThan(0);
    expect(rows[0]!.payload.paid_at).toBeTruthy();
    expect(rows[0]!.dedup_key).toMatch(/^incentive_paid:\d+$/);
  });

  it('a non-LockerHub agent gets nothing, and re-accrual never double-fires', async () => {
    const staff = await login('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const { rows: before } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM agent_event_webhooks');

    // A plain NCD agent (no lockerhub_user_id) — enqueueEvent skips it.
    await ctx.db.query("INSERT INTO agents (agent_code, full_name) VALUES ('LOCAL-1','Local Only Agent')");
    const { appId } = await liveInvestmentReferredBy(staff, 'Local Only Agent', '9871000003');

    // Re-running accrual is idempotent, so no second incentive_accrued either.
    const { accrueForApplication } = await import('../src/modules/incentives/accrual.js');
    await ctx.db.withTx(async (tx: any) => { await accrueForApplication(tx, appId); });

    const { rows: after } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM agent_event_webhooks');
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it('dispatch signs the RAW body with HMAC(secret, "<ts>.<body>") and marks the row sent', async () => {
    received = [];
    const out = await dispatchPending(ctx.db);
    expect(out.sent).toBeGreaterThan(0);
    expect(received.length).toBe(out.sent);

    const r = received[0]!;
    expect(r.event).toBeTruthy();
    expect(r.ts).toBeTruthy();
    // Verify exactly as LockerHub does — over the raw bytes, not a re-serialisation.
    const expected = 'sha256=' + createHmac('sha256', SECRET).update(`${r.ts}.${r.raw}`).digest('hex');
    expect(r.sig).toBe(expected);

    const { rows } = await ctx.db.query<{ n: string }>("SELECT count(*) AS n FROM agent_event_webhooks WHERE status = 'pending'");
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
