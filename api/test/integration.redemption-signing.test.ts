/**
 * The signed redemption request letter, and the gate it puts in front of
 * approval (owner 2026-11-18).
 *
 * The point of this suite is that NO STEP CAN BE BYPASSED — that was the
 * owner's closing sentence. So most of these tests assert a REFUSAL, and each
 * refusal is paired with the success that proves the refusal was about the
 * signature and not about something incidental being missing.
 *
 * The staleness tests matter most. The approver can waive the penalty and move
 * the redemption date, and the date recomputes the broken-period interest — so
 * the figure a customer signed for can change after they signed it. The owner's
 * rule is that the letter voids and they sign again, and the two gates here
 * (submit, then approve) are what make that unbypassable: the second exists
 * precisely because the approver can change the figures AFTER the first.
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

async function activeInvestment(name: string, phone: string, amount = 500000) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id;
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  return { customerId: cid, appId: Number(app.json.id) };
}

/** A one-pixel PNG, base64 — stands in for a scan of the signed page. */
const SCAN = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const today = () => new Date().toISOString().slice(0, 10);

async function initiate(appId: number, reason = 'Needs the money back early') {
  const ncd = await as('ncd@demo.local');
  const r = await ncd.post('/api/redemptions/premature', { application_id: appId, reason });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { ncd, rid: Number(r.json.redemption_id), body: r.json };
}

describe('the redemption request letter gates approval', () => {
  it('initiating no longer submits for approval — it generates the letter instead', async () => {
    const inv = await activeInvestment('Sign Alpha', '9710000001');
    const { rid, body } = await initiate(inv.appId);

    // The old behaviour created the approval in the same call. It must not.
    const red = (await ctx.db.query("SELECT status, approval_request_id FROM redemptions WHERE id = $1", [rid])).rows[0] as any;
    expect(red.status).toBe('Requested');
    expect(red.approval_request_id).toBeNull();

    expect(body.stage).toBe('Redemption Letter Generated');
    expect(body.can_submit).toBe(false);
    const signing = (await ctx.db.query('SELECT * FROM redemption_signings WHERE redemption_id = $1', [rid])).rows[0] as any;
    expect(signing.status).toBe('Draft');
    expect(signing.letter_pdf_path).toBeTruthy();
  });

  it('refuses to send for approval while the letter is unsigned', async () => {
    const inv = await activeInvestment('Sign Beta', '9710000002');
    const { ncd, rid } = await initiate(inv.appId);
    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status).toBe(409);
    expect(String(submit.json.error.message)).toContain('not signed the redemption request letter');
    // and nothing was created on the way out
    expect((await ctx.db.query('SELECT approval_request_id FROM redemptions WHERE id = $1', [rid])).rows[0]!.approval_request_id).toBeNull();
  });

  it('accepts the signed scan and then lets it go for approval', async () => {
    const inv = await activeInvestment('Sign Gamma', '9710000003');
    const { ncd, rid } = await initiate(inv.appId);

    const up = await ncd.post(`/api/redemptions/${rid}/signed-letter`, {
      data_base64: SCAN, filename: 'signed.png', signed_on: today(), note: 'Signed at the branch',
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json.status).toBe('Signed');
    expect(up.json.method).toBe('physical');
    // The figures are frozen at the moment of signing — this is what makes a
    // later change detectable rather than a guess.
    expect(Number(up.json.signed_principal)).toBeGreaterThan(0);

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.stage).toBe('Signature Submitted');
    expect(view.json.can_submit).toBe(true);

    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status, JSON.stringify(submit.json)).toBe(201);

    const after = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(after.json.stage).toBe('Pending Approval');
  });

  it('runs all the way to Approved once signed, and only then releases the NEFT sheet', async () => {
    const inv = await activeInvestment('Sign Delta', '9710000004');
    const { ncd, rid } = await initiate(inv.appId);

    // Before approval the processing sheet must not come out.
    expect((await ncd.raw(`/api/redemptions/${rid}/neft.xlsx`)).status).toBe(409);

    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });
    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/approvals/${submit.json.request.id}/approve`)).json.request.status).toBe('Approved');

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.stage).toBe('Ready for Redemption Processing');
    expect((await ncd.raw(`/api/redemptions/${rid}/neft.xlsx`)).status).toBe(200);
  });

  it('will not regenerate a letter that has already been signed', async () => {
    const inv = await activeInvestment('Sign Epsilon', '9710000005');
    const { ncd, rid } = await initiate(inv.appId);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });
    const again = await ncd.post(`/api/redemptions/${rid}/letter`, {});
    expect(again.status).toBe(409);
    expect(String(again.json.error.message)).toContain('already been signed');
  });

  it('regenerating BEFORE signing is allowed — staff fix a bank account and reprint', async () => {
    const inv = await activeInvestment('Sign Zeta', '9710000006');
    const { ncd, rid } = await initiate(inv.appId);
    const again = await ncd.post(`/api/redemptions/${rid}/letter`, {});
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.status).toBe('Draft');
    // Still exactly one live signing row — regenerating must not stack them up.
    const live = await ctx.db.query(
      "SELECT count(*) AS n FROM redemption_signings WHERE redemption_id = $1 AND status IN ('Draft','AwaitingSignature','Signed')", [rid]);
    expect(Number((live.rows[0] as any).n)).toBe(1);
  });

  it('refuses a signing date in the future — it is read off the paper, not the clock', async () => {
    const inv = await activeInvestment('Sign Eta', '9710000007');
    const { ncd, rid } = await initiate(inv.appId);
    const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const up = await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: future });
    expect(up.status).toBe(400);
    expect(String(up.json.error.message)).toContain('cannot be in the future');
  });

  it('serves the generated letter and the signed copy for the approver to look at', async () => {
    const inv = await activeInvestment('Sign Theta', '9710000008');
    const { ncd, rid } = await initiate(inv.appId);
    const letter = await ncd.raw(`/api/redemptions/${rid}/letter.pdf`);
    expect(letter.status).toBe(200);
    expect(letter.buffer.subarray(0, 4).toString()).toBe('%PDF');
    // No scan yet.
    expect((await ncd.raw(`/api/redemptions/${rid}/signed-letter.pdf`)).status).toBe(404);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });
    expect((await ncd.raw(`/api/redemptions/${rid}/signed-letter.pdf`)).status).toBe(200);
  });
});

describe('a signature stops counting when the money or the date moves', () => {
  it('waiving the penalty voids the signature and blocks the submit', async () => {
    const inv = await activeInvestment('Stale Alpha', '9720000001');
    const { ncd, rid } = await initiate(inv.appId);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });

    const cxo = await as('cxo@demo.local');
    const waive = await cxo.post(`/api/redemptions/${rid}/waive-penalty`, { new_penalty: 0, reason: 'Goodwill' });
    expect(waive.status, JSON.stringify(waive.json)).toBe(200);
    expect(waive.json.signature_voided).toBe(true);

    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status).toBe(409);
    expect(String(submit.json.error.message)).toContain('not signed the redemption request letter');

    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.can_submit).toBe(false);
  });

  it('changing the redemption date voids the signature too', async () => {
    const inv = await activeInvestment('Stale Beta', '9720000002');
    const { ncd, rid } = await initiate(inv.appId);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });

    const cxo = await as('cxo@demo.local');
    const moved = await cxo.post(`/api/redemptions/${rid}/redemption-date`, {
      redemption_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), reason: 'Correcting the date',
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json.signature_voided).toBe(true);
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(409);
  });

  it('a fresh signature after the change lets it through again', async () => {
    const inv = await activeInvestment('Stale Gamma', '9720000003');
    const { ncd, rid } = await initiate(inv.appId);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });
    const cxo = await as('cxo@demo.local');
    await cxo.post(`/api/redemptions/${rid}/waive-penalty`, { new_penalty: 0, reason: 'Goodwill' });

    // New letter, new signature — against the figures as they now stand.
    expect((await ncd.post(`/api/redemptions/${rid}/letter`, {})).status).toBe(200);
    const up = await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's2.png', signed_on: today() });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(Number(up.json.signed_penalty)).toBe(0);

    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status, JSON.stringify(submit.json)).toBe(201);
    // The voided one is kept as the record of what was signed before.
    const all = await ctx.db.query("SELECT status FROM redemption_signings WHERE redemption_id = $1 ORDER BY id", [rid]);
    expect(all.rows.map((r: any) => r.status)).toEqual(['Superseded', 'Signed']);
  });

  it('the approver cannot approve against a signature their own change voided', async () => {
    const inv = await activeInvestment('Stale Delta', '9720000004');
    const { ncd, rid } = await initiate(inv.appId);
    await ncd.post(`/api/redemptions/${rid}/signed-letter`, { data_base64: SCAN, filename: 's.png', signed_on: today() });
    const submit = await ncd.post(`/api/redemptions/${rid}/submit-for-approval`);
    expect(submit.status).toBe(201);

    // Now, with it already in the queue, the approver moves the money.
    const cxo = await as('cxo@demo.local');
    expect((await cxo.post(`/api/redemptions/${rid}/waive-penalty`, { new_penalty: 0, reason: 'Goodwill' })).status).toBe(200);

    // The second gate. Without it the approver would be approving their own
    // change against a signature for the old figure.
    const approve = await cxo.post(`/api/approvals/${submit.json.request.id}/approve`);
    expect(approve.status).toBeGreaterThanOrEqual(400);

    // Nothing half-happened: the redemption is still pending and the
    // investment is still live.
    const red = (await ctx.db.query('SELECT status FROM redemptions WHERE id = $1', [rid])).rows[0] as any;
    expect(red.status).toBe('Requested');
    const app = (await ctx.db.query('SELECT status FROM applications WHERE id = $1', [inv.appId])).rows[0] as any;
    expect(app.status).toBe('Active');
  });
});

describe('what the letter does NOT gate', () => {
  it('a maturity redemption needs no letter and goes straight to its approval', async () => {
    const inv = await activeInvestment('Mature Alpha', '9730000001');
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/redemptions/maturity', { application_id: inv.appId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Its approval exists immediately — the gate never applied.
    expect(r.json.request.id).toBeTruthy();
    const view = await ncd.get(`/api/redemptions/${r.json.redemption_id}/signing`);
    expect(view.json.needs_signature).toBe(false);
    expect(view.json.stage).toBe('Pending Approval');
    // Maturity is checked by NCD Manager / Admin, not the CXO (approvals
    // config) — and the maker here was the NCD manager, so admin checks it.
    const checker = await admin();
    expect((await checker.post(`/api/approvals/${r.json.request.id}/approve`)).json.request.status).toBe('Approved');
  });

  it('a customer asking through the portal signs nothing extra — they asked themselves', async () => {
    const inv = await activeInvestment('Portal Alpha', '9730000002');
    const cust = new Client(ctx.base);
    await cust.post('/api/portal/otp/request', { identifier: '9730000002' });
    const otp = (await ctx.db.query("SELECT payload FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1")).rows[0] as any;
    await cust.post('/api/portal/otp/verify', { identifier: '9730000002', otp: otp.payload.otp });
    const detail = await (await admin()).get(`/api/applications/${inv.appId}`);
    const appNo = detail.json.application.application_no;
    const req = await cust.post('/api/portal/redemption-request', { application_no: appNo, reason: 'Need funds' });
    expect(req.status).toBe(201);

    const ncd = await as('ncd@demo.local');
    const queue = await ncd.get('/api/redemptions?filter=requests');
    const item = queue.json.rows.find((r: any) => r.application_no === appNo);
    expect(item, 'the portal request should be in the staff queue').toBeTruthy();
    const rid = Number(item.id);
    const view = await ncd.get(`/api/redemptions/${rid}/signing`);
    expect(view.json.needs_signature).toBe(false);
    // Straight through, exactly as before this change.
    expect((await ncd.post(`/api/redemptions/${rid}/submit-for-approval`)).status).toBe(201);
  });
});
