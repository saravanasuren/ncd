/**
 * Gap C — applications (clubbing, payout account, revert, receipt) + customer
 * relations/KYC (joint holders, nominees, deceased, docs, DigiLocker, mirror).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const B64 = Buffer.from('hello-receipt').toString('base64');

async function newCustomer(a: Client, name: string, phone: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  return cust.json.id as number;
}

describe('applications — clubbing', () => {
  it('a second line clubs into the in-flight application', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Club Cust', '9500000001');
    const app1 = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 200000 });
    const cand = await a.get(`/api/applications/clubbing-candidates?customer_id=${cid}&series_id=${seriesId}`);
    expect(cand.json.rows.some((r: any) => r.id === app1.json.id)).toBe(true);
    const app2 = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 300000, club_with_application_id: app1.json.id });
    expect(app2.json.clubbed).toBe(true);
    expect(app2.json.id).toBe(app1.json.id);
    const detail = await a.get(`/api/applications/${app1.json.id}`);
    expect(Number(detail.json.application.total_amount)).toBe(500000);
    expect(detail.json.lines.length).toBe(2);
  });
});

describe('applications — receipt upload', () => {
  it('uploads and streams back the receipt', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Receipt Cust', '9500000002');
    const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    const up = await a.post(`/api/applications/${app.json.id}/receipt`, { filename: 'r.txt', mime: 'text/plain', data_base64: B64 });
    expect(up.status).toBe(201);
    const dl = await a.raw(`/api/applications/${app.json.id}/receipt`);
    expect(dl.status).toBe(200);
    expect(dl.buffer.toString()).toBe('hello-receipt');
  });
});

async function activeApp(a: Client, cid: number, amount = 500000) {
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-12', method: 'NEFT' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  return app.json.id as number;
}
async function allot(payoutDate = '2026-07-20') {
  const ncd = await as('ncd@demo.local');
  const batch = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: payoutDate });
  const a = await admin();
  await a.post(`/api/approvals/${batch.json.request.id}/approve`);
}

describe('applications — per-application payout account', () => {
  it('changing the payout account re-snapshots future scheduled rows', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Payout Cust', '9500000003');
    const b1 = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '11110001111', ifsc: 'HDFC0001111' });
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '22220002222', ifsc: 'ICIC0002222' });
    void b1;
    const appId = await activeApp(a, cid);
    await allot();
    // second (non-active) account id
    const acc2 = Number((await ctx.db.query("SELECT id FROM customer_bank_accounts WHERE account_number = '22220002222'")).rows[0]!.id);
    const set = await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: acc2 });
    expect(set.status).toBe(200);
    const rows = (await ctx.db.query("SELECT DISTINCT payee_account FROM disbursement_schedule WHERE application_id = $1 AND status = 'Scheduled'", [appId])).rows as any[];
    expect(rows.every((r) => r.payee_account === '22220002222')).toBe(true);
  });
});

describe('applications — revert allotment', () => {
  it('super admin reverts an unpaid series; apps go back to PendingAllotment', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Revert Cust', '9500000004');
    const appId = await activeApp(a, cid);
    await allot();
    const rev = await a.post(`/api/allotments/series/${seriesId}/revert`, { reason: 'Wrong date' });
    expect(rev.status).toBe(200);
    const app = (await ctx.db.query('SELECT status FROM applications WHERE id = $1', [appId])).rows[0] as any;
    expect(app.status).toBe('PendingAllotment');
    const sched = (await ctx.db.query('SELECT count(*)::int AS n FROM disbursement_schedule WHERE application_id = $1', [appId])).rows[0] as any;
    expect(Number(sched.n)).toBe(0);
  });
});

describe('customers — relations, deceased, KYC docs', () => {
  it('sets joint holders + nominees and rejects >100% shares', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Relations Cust', '9500000005');
    expect((await a.put(`/api/customers/${cid}/joint-holders`, { holders: [{ full_name: 'JH One', relationship: 'Spouse' }] })).status).toBe(200);
    expect((await a.put(`/api/customers/${cid}/nominees`, { nominees: [{ full_name: 'Nom', share_pct: 60 }, { full_name: 'Nom2', share_pct: 50 }] })).status).toBe(400);
    expect((await a.put(`/api/customers/${cid}/nominees`, { nominees: [{ full_name: 'Nom', share_pct: 100 }] })).status).toBe(200);
    const detail = await a.get(`/api/customers/${cid}`);
    expect(detail.json.jointHolders.length).toBe(1);
    expect(detail.json.nominees.length).toBe(1);
  });

  it('uploads a KYC doc and streams it back; mirror from the app tags origin', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'Doc Cust', '9500000006');
    const up = await a.post(`/api/customers/${cid}/documents`, { doc_type: 'PAN', filename: 'pan.txt', mime: 'text/plain', data_base64: B64 });
    const dl = await a.raw(`/api/customers/${cid}/documents/${up.json.id}`);
    expect(dl.buffer.toString()).toBe('hello-receipt');
    // integration mirror
    const mirror = await fetch(ctx.base + `/api/integration/customers/${cid}/kyc-docs`, {
      method: 'POST', headers: { 'X-Integration-Key': 'dev-integration-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_type: 'Aadhaar', filename: 'aad.txt', mime: 'text/plain', data_base64: B64 }),
    });
    expect(mirror.status).toBe(201);
    const docs = (await ctx.db.query("SELECT origin FROM customer_documents WHERE customer_id = $1 AND origin = 'dhanamfin'", [cid])).rows;
    expect(docs.length).toBe(1);
  });

  it('DigiLocker stub verifies KYC; deceased flag sets', async () => {
    const a = await admin();
    const cid = await newCustomer(a, 'KYC Cust', '9500000007');
    const start = await a.post(`/api/customers/${cid}/kyc/digilocker/start`);
    expect(start.json.session_id).toContain('stub-dl');
    await a.post(`/api/customers/${cid}/kyc/digilocker/complete`);
    const c1 = (await ctx.db.query('SELECT kyc_status FROM customers WHERE id = $1', [cid])).rows[0] as any;
    expect(c1.kyc_status).toBe('Verified');
    await a.post(`/api/customers/${cid}/deceased`, { deceased_date: '2026-07-15' });
    const c2 = (await ctx.db.query('SELECT is_deceased FROM customers WHERE id = $1', [cid])).rows[0] as any;
    expect(c2.is_deceased).toBe(true);
  });
});
