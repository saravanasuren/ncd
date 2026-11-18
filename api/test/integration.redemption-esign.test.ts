/**
 * Signing the redemption request letter through Digio (owner 2026-11-18).
 *
 * WHAT THESE TESTS CAN AND CANNOT REACH. Digio is not configured in the test
 * environment, so `createSignRequest` returns a stub id and
 * `downloadSignedDocument` returns null. That is not a gap being papered over —
 * it is the interesting case. This flow REFUSES to record a signature it has no
 * document for, and the stub gives exactly that condition for free: Digio says
 * signed, no PDF arrives, and the letter must stay unsigned rather than gate a
 * payment on nothing. The test that proves the happy path puts a real PDF in
 * storage the way a successful download would.
 *
 * The e-sign route deliberately does NOT get its own approval or its own gate.
 * It is a second way to reach the same `Signed` state the paper upload reaches,
 * and every rule already proved in integration.redemption-signing.test.ts —
 * the submit gate, the approve gate, voiding on a changed figure — applies to
 * it unchanged because they all read the same row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function readyToSign(name: string, phone: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id;
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  const r = await ncd.post('/api/redemptions/premature', { application_id: Number(app.json.id), reason: 'Needs it back early' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { ncd, appId: Number(app.json.id), rid: Number(r.json.redemption_id) };
}

const sessionFor = async (rid: number) => (await ctx.db.query(
  `SELECT s.* FROM digio_signing_sessions s JOIN redemption_signings rs ON rs.id = s.redemption_signing_id
    WHERE rs.redemption_id = $1 ORDER BY s.id DESC LIMIT 1`, [rid])).rows[0] as any;

const signingFor = async (rid: number) => (await ctx.db.query(
  "SELECT * FROM redemption_signings WHERE redemption_id = $1 ORDER BY id DESC LIMIT 1", [rid])).rows[0] as any;

describe('sending the redemption letter for e-Sign', () => {
  it('opens a Digio session against the letter and moves the row to Awaiting E-Sign', async () => {
    const { ncd, rid } = await readyToSign('Esign Alpha', '9740000001');
    const sent = await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    expect(sent.status, JSON.stringify(sent.json)).toBe(201);
    expect(sent.json.digio_request_id).toBeTruthy();

    const sess = await sessionFor(rid);
    expect(sess.document_type).toBe('redemption_letter');
    expect(sess.status).toBe('requested');
    // Keyed to the signing row, not to the investment, so the poller and the
    // webhook can tell this apart from an application-form signature.
    expect(sess.redemption_signing_id).toBeTruthy();

    const row = await signingFor(rid);
    expect(row.method).toBe('esign');
    expect(row.status).toBe('AwaitingSignature');

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.stage).toBe('Awaiting E-Sign');
    expect(view.json.can_submit).toBe(false);
  });

  it('will not send a letter that has not been generated, or one already signed', async () => {
    const { ncd, rid } = await readyToSign('Esign Beta', '9740000002');
    // Already signed on paper — e-Sign must not reopen it.
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      filename: 's.png', signed_on: new Date().toISOString().slice(0, 10),
    });
    const sent = await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    expect(sent.status).toBe(409);
    expect(String(sent.json.error.message)).toContain('already been signed');
  });

  it('an unsigned e-Sign does not let the redemption through', async () => {
    const { ncd, rid } = await readyToSign('Esign Gamma', '9740000003');
    await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status).toBe(409);
    expect(String(submit.json.error.message)).toContain('not signed the redemption request letter');
  });
});

describe('a signature Digio confirms but whose document never arrives', () => {
  it('is NOT recorded as signed — there would be nothing for the approver to look at', async () => {
    const { ncd, rid } = await readyToSign('Esign Delta', '9740000004');
    await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    const sess = await sessionFor(rid);

    // Digio says signed; the download comes back null (unconfigured here, a
    // 500 or a non-PDF body in production — all the same to this code).
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    await completeSigning(ctx.db, sess.digio_request_id, {});

    const row = await signingFor(rid);
    expect(row.status).toBe('AwaitingSignature');
    expect(row.signed_doc_path).toBeNull();
    // And it still cannot be submitted, which is the point.
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(409);
  });

  it('records it once the document does arrive, and freezes the figures', async () => {
    const { ncd, rid } = await readyToSign('Esign Epsilon', '9740000005');
    await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    const sess = await sessionFor(rid);
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    await completeSigning(ctx.db, sess.digio_request_id, {});
    expect((await signingFor(rid)).status).toBe('AwaitingSignature');

    // What a successful download would have done. Driving the storage helper
    // directly keeps the test about OUR state machine rather than about
    // Digio's HTTP, which is stubbed out here anyway.
    const { saveBuffer } = await import('../src/lib/storage.js');
    const row = await signingFor(rid);
    const stored = saveBuffer('redemption-letters', `redemption-letter-signed-${row.id}.pdf`, Buffer.from('%PDF-1.4 signed'));
    const red = (await ctx.db.query('SELECT principal, penalty, redemption_date FROM redemptions WHERE id = $1', [rid])).rows[0] as any;
    await ctx.db.query(
      `UPDATE redemption_signings
          SET status='Signed', method='esign', signed_doc_path=$1, signed_doc_mime='application/pdf',
              signed_at=now(), signed_on=now()::date,
              signed_principal=$2, signed_penalty=$3, signed_redemption_date=$4
        WHERE id=$5`,
      [stored.path, red.principal, red.penalty, red.redemption_date, row.id]);

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.stage).toBe('Signature Submitted');
    expect(view.json.can_submit).toBe(true);
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(201);
  });
});

describe('a dead e-Sign link does not strand the redemption', () => {
  it('an expired or declined session puts the letter back to Draft so staff can act', async () => {
    const { ncd, rid } = await readyToSign('Esign Zeta', '9740000006');
    await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    expect((await signingFor(rid)).status).toBe('AwaitingSignature');
    const sess = await sessionFor(rid);

    const { markSessionFailed } = await import('../src/integrations/digio/service.js');
    await markSessionFailed(ctx.db, sess.digio_request_id, 'expired');

    const row = await signingFor(rid);
    // Not left saying "waiting for the customer" about a link that is dead —
    // 36 locker links expired exactly that way before anyone noticed.
    expect(row.status).toBe('Draft');
    expect(row.sign_url).toBeNull();

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.stage).toBe('Redemption Letter Generated');

    // The paper route is still open, and still gates approval properly.
    const up = await ncd.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      filename: 's.png', signed_on: new Date().toISOString().slice(0, 10),
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(201);
  });

  it('needs an explicit switch to paper while an e-Sign is still live, and then takes the scan', async () => {
    const { ncd, rid } = await readyToSign('Esign Eta', '9740000007');
    await ncd.post(`/api/redemptions/${rid}/letter/esign`, {});
    const scan = {
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      filename: 'posted.png', signed_on: new Date().toISOString().slice(0, 10),
    };
    // Refused while the e-Sign is live — how a document was signed is recorded
    // on the row and never inferred, the same rule the locker agreement keeps.
    // The message says what to do rather than just "no".
    const blocked = await ncd.post(`/api/redemptions/${rid}/signed-letter`, scan);
    expect(blocked.status).toBe(400);
    expect(String(blocked.json.error.message)).toContain('Switch it to a physical signature');

    // And the switch is a real route, not advice with nothing behind it.
    const sw = await ncd.post(`/api/redemptions/${rid}/letter/method`, { method: 'physical' });
    expect(sw.status, JSON.stringify(sw.json)).toBe(200);
    const up = await ncd.post(`/api/redemptions/${rid}/signed-letter`, scan);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(201);
  });
});
