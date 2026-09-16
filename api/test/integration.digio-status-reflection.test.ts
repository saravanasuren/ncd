/**
 * Does the e-Sign status we show match what Digio actually holds?
 *
 * Three ways it did not:
 *
 *   · the webhook believed ANY delivery was a completed signature. It read the
 *     request id out of the body and completed the session without once
 *     looking at what the event said — and for an NCD application that path
 *     stamps esigned_at AND signing_method, the one field the codebase says
 *     may only be written where a real signature lands;
 *   · nothing ever recorded a signature that is not coming. Only 'signed' was
 *     acted on, so an expired or declined request stayed 'requested' and every
 *     screen went on saying "waiting", offering a dead link;
 *   · and a locker agreement had no way to ASK. checkOneApplication finds
 *     sessions by application_id, which is NULL on every locker-agreement
 *     session, and the poller stops after POLL_WINDOW_DAYS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const APP = 'LKR-STATUS-1';
const actor = { id: 1 } as never;
const WEBHOOK_SECRET = 'test-digio-webhook-secret';
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

/** A live Digio that reports whatever the test tells it to. */
let digioSays = 'requested';
async function withDigio<T>(fn: () => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if ((req.url ?? '').includes('/document/status')) { res.end(JSON.stringify({ agreement_status: digioSays })); return; }
      res.end(JSON.stringify({ id: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: 'requested', signers: [{ sign_url: 'about:blank#mock' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const { config } = await import('../src/config.js');
  const saved = { id: config.DIGIO_CLIENT_ID, secret: config.DIGIO_CLIENT_SECRET, base: config.DIGIO_BASE, hook: config.DIGIO_WEBHOOK_SECRET };
  Object.assign(config, {
    DIGIO_CLIENT_ID: 'test', DIGIO_CLIENT_SECRET: 'test',
    DIGIO_BASE: `http://127.0.0.1:${port}`, DIGIO_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  try {
    return await fn();
  } finally {
    Object.assign(config, { DIGIO_CLIENT_ID: saved.id, DIGIO_CLIENT_SECRET: saved.secret, DIGIO_BASE: saved.base, DIGIO_WEBHOOK_SECRET: saved.hook });
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function seedSigning(): Promise<number> {
  const a = await admin();
  const customerId = Number((await a.post('/api/customers', { full_name: 'Status Hirer', phone: '9716000001' })).json.id);
  await ctx.db.query(
    `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone, locker_size, status)
     VALUES ($1, $2, 'Status Hirer', '9716000001', 'Large', 'approved')`, [APP, customerId]);
  const { initiateCustomerEsign, getSigning } = await import('../src/modules/lockers/agreements.js');
  await initiateCustomerEsign(ctx.db, actor, APP, customerId);
  return (await getSigning(ctx.db, APP))!.id;
}

const webhook = (id: string) => fetch(ctx.base + '/api/webhooks/digio/esign-complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Digio-Secret': WEBHOOK_SECRET },
  body: JSON.stringify({ id, signed_at: new Date().toISOString() }),
});

describe('e-sign status reflects what Digio holds', () => {
  let signingId: number;
  let requestId: string;
  beforeAll(async () => {
    signingId = await seedSigning();
    requestId = (await ctx.db.query<{ digio_request_id: string }>(
      `SELECT digio_request_id FROM digio_signing_sessions WHERE locker_agreement_signing_id = $1
        ORDER BY id DESC LIMIT 1`, [signingId])).rows[0]!.digio_request_id;
  });

  it('refuses to record a signature the webhook only CLAIMS happened', async () => {
    // A well-formed, correctly-secreted delivery for a request Digio says is
    // still out. The old handler completed it on the strength of the body.
    digioSays = 'requested';
    await withDigio(async () => {
      const r = await webhook(requestId);
      expect(r.status).toBe(200);
      expect((await r.json()).ignored).toBe(true);
    });
    const sess = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM digio_signing_sessions WHERE digio_request_id = $1', [requestId])).rows[0]!;
    expect(sess.status).toBe('requested');
    const signing = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(signing.status).toBe('AwaitingSignature');
  });

  it('records a signature that is never coming, instead of waiting for ever', async () => {
    digioSays = 'expired';
    await withDigio(async () => {
      const { pollOutstanding } = await import('../src/integrations/digio/service.js');
      const out = await pollOutstanding(ctx.db);
      expect(out.failed).toBeGreaterThan(0);
      expect(out.signed).toBe(0);
    });
    const sess = (await ctx.db.query<{ status: string; webhook_payload: { digio_status?: string } | null }>(
      'SELECT status, webhook_payload FROM digio_signing_sessions WHERE digio_request_id = $1', [requestId])).rows[0]!;
    expect(sess.status).toBe('failed');
    // WHICH failure, because "expired" and "declined" need different answers.
    expect(sess.webhook_payload?.digio_status).toBe('expired');
  });

  it('shows the hirer as needing a fresh link, and stops offering the dead one', async () => {
    const { agreementSigners, getSigning } = await import('../src/modules/lockers/agreements.js');
    const s = (await agreementSigners(ctx.db, APP))[0]!;
    expect(s.status).toBe('failed');
    expect(s.sign_url).toBeNull();
    expect(s.can_send).toBe(true);           // re-sending is the way forward
    // ...and the enrolment screen's link is gone too.
    expect((await getSigning(ctx.db, APP))!.customer_sign_url).toBeNull();
  });

  it('lets a locker agreement ask Digio directly — the button lockers never had', async () => {
    // Re-send, then have Digio report it signed while no webhook ever arrives.
    const { initiateHirerEsign, recheckEsign } = await import('../src/modules/lockers/agreements.js');
    await withDigio(async () => {
      digioSays = 'requested';
      await initiateHirerEsign(ctx.db, actor, APP, 1);
      digioSays = 'signed';
      const r = await recheckEsign(ctx.db, actor, APP);
      expect(r.signed).toBe(1);
    });
    const signing = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]!;
    expect(signing.status).toBe('CustomerSigned');
  });

  it('says so plainly when there is nothing outstanding to ask about', async () => {
    const { recheckEsign } = await import('../src/modules/lockers/agreements.js');
    await withDigio(async () => {
      await expect(recheckEsign(ctx.db, actor, APP)).rejects.toThrow(/No signing link is outstanding/);
    });
  });
});
