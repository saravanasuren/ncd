/**
 * NCD → LockerHub customer-event webhook (NCD_INTEGRATION_CONTRACT.md).
 * Dormant unless LOCKERHUB_EVENT_WEBHOOK_URL is set; here we point it at a local
 * mock so we can assert the envelope, the X-Integration-Key, idempotency, and
 * that the domain lifecycle (a landed payment → activation) actually emits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';
import { emitCustomerEvent, dispatchPendingCustomerEvents } from '../src/integrations/lockerhub/customerEvents.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
let mock: Server;
let received: Array<{ key: string | undefined; event: string | undefined; body: any }> = [];
let mockUrl = '';
const KEY = 'dev-integration-key';

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await ctx.db.query("UPDATE series SET status = 'Open' WHERE id = $1", [seriesId]);

  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ key: req.headers['x-integration-key'] as string, event: req.headers['x-dhanam-event'] as string, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/integration/wealth/webhook`;
  config.LOCKERHUB_EVENT_WEBHOOK_URL = mockUrl; // arm the (otherwise dormant) webhook
});
afterAll(async () => {
  config.LOCKERHUB_EVENT_WEBHOOK_URL = undefined;
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

describe('customer-event webhook', () => {
  it('emit is idempotent on (event_type, dedup key)', async () => {
    const input = { eventType: 'customer.synced' as const, phone: '9800011111', data: { customer_code: 'DHN9999' }, dedupKey: 'idem-1' };
    const a = await emitCustomerEvent(ctx.db, input);
    const b = await emitCustomerEvent(ctx.db, input);
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(false); // ON CONFLICT (event_id) DO NOTHING
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM customer_event_webhooks WHERE event_type='customer.synced' AND phone='9800011111'");
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('dispatch POSTs the contract envelope with X-Integration-Key and marks the row sent', async () => {
    received = [];
    await emitCustomerEvent(ctx.db, { eventType: 'redemption.completed', phone: '9800022222', data: { customer_code: 'DHN8888', lockerhub_application_no: 'LH-APP-1' }, dedupKey: 'disp-1' });
    const out = await dispatchPendingCustomerEvents(ctx.db);
    expect(out.sent).toBeGreaterThanOrEqual(1);
    const hit = received.find((r) => r.body.event_type === 'redemption.completed');
    expect(hit).toBeTruthy();
    expect(hit!.key).toBe(KEY);
    expect(hit!.event).toBe('redemption.completed');
    expect(hit!.body).toMatchObject({
      event_type: 'redemption.completed',
      phone: '9800022222',
      data: { customer_code: 'DHN8888', lockerhub_application_no: 'LH-APP-1' },
    });
    expect(typeof hit!.body.event_id).toBe('string');
    expect(typeof hit!.body.occurred_at).toBe('string');
    const { rows } = await ctx.db.query("SELECT status FROM customer_event_webhooks WHERE event_type='redemption.completed'");
    expect(rows[0]!.status).toBe('sent');
  });

  it('a landed LockerHub payment emits payment.acknowledged + subscription.activated', async () => {
    const res = await fetch(ctx.base + '/api/integration/subscription-payments/from-lockerhub', {
      method: 'POST',
      headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_no: 'EVT-WIRE-1', phone: '9800033333', customer_name: 'Evt Wire', series_id: seriesId, scheme_id: schemeId, amount: 200000, paid_at: '2026-07-21' }),
    });
    expect(res.status).toBe(200);
    const { rows } = await ctx.db.query(
      `SELECT event_type FROM customer_event_webhooks
        WHERE payload->'data'->>'lockerhub_application_no' = 'EVT-WIRE-1'
           OR payload->'data'->>'application_no' IN (SELECT application_no FROM applications WHERE lockerhub_intent_no='EVT-WIRE-1')
        ORDER BY event_type`);
    const types = rows.map((r: any) => r.event_type);
    expect(types).toContain('payment.acknowledged');
    expect(types).toContain('subscription.activated');
  });
});
