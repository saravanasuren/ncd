/**
 * Another signing attempt, until one succeeds (owner 2026-09-17: "once i
 * attempt to make a esigning - i'm not able to make another if the first
 * attempt gets failed ... unless a esign becomes successful i should have
 * attempts to make signing").
 *
 * The trap: a customer who abandons the Aadhaar OTP does NOT fail the Digio
 * document. Digio's own screen says "Signing cancelled by user. To retry,
 * please click on Sign Now" and leaves it open, so our session stays
 * 'requested' for ever. The page offered "Send for eSign" only while nothing
 * was out, which meant one abandoned attempt sealed the investment — no new
 * link, and not even a printed form to sign by hand, since the paper controls
 * sat behind the same gate. On production 64 sessions sit at 'requested'
 * against 7 signed.
 *
 * So the rule under test is about the SIGNATURE, not the session: anything but
 * a real signature may be attempted again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A live investment, the state an eSign is sent from. */
async function investment(a: Client, name: string, phone: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `7171${phone}`, ifsc: 'ICIC0002222' });
  const series = (await a.get('/api/series')).json.rows[0];
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount: 300000, date_money_received: '2026-09-01',
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return Number(create.json.id);
}

const detail = async (a: Client, appId: number) => (await a.get(`/api/applications/${appId}`)).json;
const initiate = (a: Client, appId: number) => a.post(`/api/applications/${appId}/esign/initiate`);

describe('a failed eSign attempt does not seal the investment', () => {
  it('offers another attempt while one is still outstanding', async () => {
    const a = await admin();
    const appId = await investment(a, 'Esign Retry One', '9567000001');

    const before = await detail(a, appId);
    expect(before.esign.state).toBe('not_sent');
    expect(before.esign.can_send).toBe(true);
    expect(before.esign.attempts).toBe(0);

    expect((await initiate(a, appId)).status).toBe(201);
    const out = await detail(a, appId);
    expect(out.esign.state).toBe('awaiting');
    // THE BUG: this was decided in the page as `state === 'not_sent'`, so the
    // button vanished here and never came back.
    expect(out.esign.can_send, 'a second attempt must be allowed').toBe(true);
    expect(out.esign.attempts).toBe(1);

    // And the second send actually goes through, as its own session.
    expect((await initiate(a, appId)).status).toBe(201);
    const again = await detail(a, appId);
    expect(again.esign.attempts).toBe(2);
    const rows = (await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM digio_signing_sessions WHERE application_id = $1 AND status = 'requested'",
      [appId])).rows[0]!;
    expect(Number(rows.n), 'the earlier link is not cancelled — either may be signed').toBe(2);
  });

  it('keeps offering attempts once the session has gone stale', async () => {
    // Past the poller's window: nobody is chasing it, which is exactly when a
    // human needs to send another one.
    const a = await admin();
    const appId = await investment(a, 'Esign Retry Stale', '9567000002');
    await initiate(a, appId);
    await ctx.db.query(
      "UPDATE digio_signing_sessions SET created_at = now() - interval '30 days' WHERE application_id = $1", [appId]);

    const d = await detail(a, appId);
    expect(d.esign.state).toBe('stalled');
    expect(d.esign.can_send).toBe(true);
  });

  it('STOPS offering attempts once a signature exists', async () => {
    // The one case that must close: a signed investment is not re-signed, and
    // this is the half of the rule that keeps the fix honest.
    const a = await admin();
    const appId = await investment(a, 'Esign Retry Signed', '9567000003');
    await initiate(a, appId);
    await ctx.db.query(
      "UPDATE applications SET esigned_at = now(), signing_method = 'esign' WHERE id = $1", [appId]);

    const d = await detail(a, appId);
    expect(d.esign.state).toBe('signed');
    expect(d.esign.can_send).toBe(false);
  });

});
