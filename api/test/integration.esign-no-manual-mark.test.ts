/**
 * A signature is recorded because DIGIO says the customer signed — never because
 * a member of staff clicked a button (owner 2026-08-29).
 *
 * "Mark eSigned" stamped a signature date with no document, no evidence and no
 * approval, for anyone from NCD Manager up. It was already obsolete: the owner's
 * 2026-07-22 spec put a poller in place that asks Digio every 15 seconds and
 * completes the signature itself, "with no webhook and no manual Mark eSigned".
 * The poller shipped; the button did not get deleted with it, and sat there for
 * five weeks.
 *
 * Nothing was ever falsely recorded — it was pressed once in the system's life,
 * and all 7 signed investments carry a real signed PDF. This removes the
 * possibility rather than repairing damage, which is why the first test matters
 * most: it fails the moment anyone reintroduces a way to self-certify.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function liveInvestment(a: Client, name: string, phone: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: '2026-07-10',
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return Number(create.json.id);
}
const detail = async (a: Client, id: number) => (await a.get(`/api/applications/${id}`)).json;

describe('eSign cannot be self-certified', () => {
  it('the manual "mark signed" route is GONE, even for a Super Admin', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Gone', '9706000001');
    const r = await a.post(`/api/applications/${appId}/mark-esigned`);
    expect(r.status).toBe(404);
    // And nothing was recorded by trying.
    const d = await detail(a, appId);
    expect(d.application.esigned_at).toBeNull();
    expect(d.esign.state).toBe('not_sent');
  });

  it('reports where the signature stands, not just signed / unsigned', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign State', '9706000002');

    // Nothing sent yet.
    expect((await detail(a, appId)).esign.state).toBe('not_sent');

    // A signature is out with the customer, sent today.
    await ctx.db.query(
      `INSERT INTO digio_signing_sessions (application_id, digio_request_id, status, created_at)
       VALUES ($1, 'REQ-AWAIT-1', 'requested', now())`, [appId]);
    const awaiting = (await detail(a, appId)).esign;
    expect(awaiting.state).toBe('awaiting');
    expect(awaiting.days_waiting).toBe(0);
    expect(awaiting.sent_at).toBeTruthy();
  });

  it('a request past the poller window reads as stalled, not as still-waiting', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Stalled', '9706000003');
    await ctx.db.query(
      `INSERT INTO digio_signing_sessions (application_id, digio_request_id, status, created_at)
       VALUES ($1, 'REQ-STALL-1', 'requested', now() - interval '20 days')`, [appId]);

    const e = (await detail(a, appId)).esign;
    expect(e.state).toBe('stalled');
    expect(e.days_waiting).toBe(20);
    // The UI draws its line from the poller's own window, so the two cannot drift.
    expect(e.poll_window_days).toBe(7);
  });

  it('the re-check asks Digio and refuses to invent a signature', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Check', '9706000004');
    await ctx.db.query(
      `INSERT INTO digio_signing_sessions (application_id, digio_request_id, status, created_at)
       VALUES ($1, 'REQ-CHECK-1', 'requested', now() - interval '20 days')`, [appId]);

    // No Digio credentials in test, so it reports that honestly — and above all
    // does NOT fall back to marking it signed.
    const r = await a.post(`/api/applications/${appId}/esign/check`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.reason).toBe('not-configured');

    const d = await detail(a, appId);
    expect(d.application.esigned_at).toBeNull();   // still unsigned — the point
    expect(d.esign.state).toBe('stalled');
  });

  it('says so plainly when there is nothing out to check', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Nothing', '9706000005');
    const r = await a.post(`/api/applications/${appId}/esign/check`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(['no-session', 'not-configured']).toContain(r.json.reason);
    expect((await detail(a, appId)).application.esigned_at).toBeNull();
  });

  /**
   * REVERSED on 2026-09-04 (owner: "get all these access to branch staff login
   * also — esign access and manual sign upload option"). Branch staff enrol the
   * investment and sit with the customer, so they are the people who get the
   * form signed.
   *
   * This does not weaken the control the rest of this file is about. What was
   * removed on 2026-08-29 was the ability to ASSERT a signature; that is still
   * gone for everyone. A branch staff member can start a Digio signing, ask
   * Digio whether it completed, and upload a real signed document — none of
   * which can record a signature that did not happen.
   */
  it('branch staff CAN start a signature, and still cannot invent one', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Perms', '9706000006');
    const staff = await as('staff@demo.local');
    expect((await staff.post(`/api/applications/${appId}/esign/initiate`)).status).toBeLessThan(400);
    // The re-check asks Digio; it answers no-session/not-configured here, but
    // the point is that it is REACHABLE and cannot fabricate a signature.
    expect((await staff.post(`/api/applications/${appId}/esign/check`)).status).toBeLessThan(400);
    expect((await detail(a, appId)).application.esigned_at).toBeNull();
    // The route that let a person say "this is signed" is gone for them too.
    expect((await staff.post(`/api/applications/${appId}/mark-esigned`)).status).toBe(404);
  });

  it('an AGENT still cannot touch a signature — they are external', async () => {
    const a = await admin();
    const appId = await liveInvestment(a, 'ESign Agent Perms', '9706000007');
    const agent = await as('agent@demo.local');
    expect((await agent.post(`/api/applications/${appId}/esign/initiate`)).status).toBe(403);
    expect((await agent.post(`/api/applications/${appId}/signed-upload`, {
      data_base64: Buffer.from('%PDF-1.4\n').toString('base64'), signed_on: '2026-09-01',
    })).status).toBe(403);
  });
});
