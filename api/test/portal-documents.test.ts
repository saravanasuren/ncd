/** Portal + staff document PDFs: bond certificate, allotment letter, SOA. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let appId: number, customerId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await a.post('/api/customers', { full_name: 'Doc Cust', phone: '9990003333' });
  customerId = cust.json.id; // live on creation — no approval step
  const ncd = new Client(ctx.base); await ncd.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  const app = await a.post('/api/applications', { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-12' });
  appId = app.json.id;
  await approveInvestment(ncd, app);
  const allot = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
  await a.post(`/api/approvals/${allot.json.request.id}/approve`);
});
afterAll(async () => { await ctx.close(); });

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';

describe('document PDFs', () => {
  it('staff can download the bond certificate + allotment letter', async () => {
    const a = new Client(ctx.base); await a.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
    const bond = await a.raw(`/api/reports/bond/${appId}.pdf`);
    expect(bond.status).toBe(200); expect(isPdf(bond.buffer)).toBe(true);
    const al = await a.raw(`/api/reports/allotment/${appId}.pdf`);
    expect(al.status).toBe(200); expect(isPdf(al.buffer)).toBe(true);
  });

  it('the portal lists real download hrefs and streams the PDFs, ownership-scoped', async () => {
    // Portal login as the customer (OTP): grab the OTP from the queue.
    const p = new Client(ctx.base);
    await p.post('/api/portal/otp/request', { identifier: '9990003333' });
    const otp = String((await ctx.db.query(
      `SELECT payload->>'otp' AS otp FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1`)).rows[0]!.otp);
    const login = await p.post('/api/portal/otp/verify', { identifier: '9990003333', otp });
    expect(login.status).toBe(200);
    const docs = await p.get('/api/portal/documents');
    const bondDoc = docs.json.documents.find((d: any) => d.id.startsWith('BOND-'));
    expect(bondDoc?.href).toBeTruthy();
    const pdf = await p.raw(bondDoc.href);
    expect(pdf.status).toBe(200); expect(isPdf(pdf.buffer)).toBe(true);
    // Ownership: a BOND id for someone else's app 404s.
    const foreign = await p.raw('/api/portal/documents/BOND-999999');
    expect(foreign.status).toBe(404);
  });
});
