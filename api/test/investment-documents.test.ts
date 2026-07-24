/**
 * Investment document generators — the acknowledgement (funds received) and the
 * filled subscription application form each render as a valid PDF for an
 * application, and the endpoints are permission-gated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let appId: number;

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const isPdf = (b: Buffer) => b.length > 500 && b.subarray(0, 4).toString('latin1') === '%PDF';

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Doc Test Investor', phone: '9847000123' });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '1234567890', ifsc: 'ICIC0001111' });
  await a.put(`/api/customers/${cid}/demat`, { dp_id: 'IN300513', client_id: '92151856', depository: 'NSDL' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000,
    date_money_received: '2026-07-10', collection_method: 'NEFT/RTGS', collection_reference: 'UTR9988',
  });
  appId = Number(app.json.id);
  await a.post(`/api/applications/${appId}/mark-esigned`);
  await approveInvestment(await as('ncd@demo.local'), app); // distinct checker → Active
});
afterAll(async () => { await ctx.close(); });

describe('investment document generators', () => {
  it('renders a valid application-form PDF with content', async () => {
    const r = await (await admin()).raw(`/api/reports/application-form/${appId}.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(isPdf(r.buffer)).toBe(true);
  });

  it('renders a valid acknowledgement PDF with content', async () => {
    const r = await (await admin()).raw(`/api/reports/acknowledgment/${appId}.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(isPdf(r.buffer)).toBe(true);
  });

  it('the application-form generator returns a signature box for Digio placement', async () => {
    const { applicationFormPdf } = await import('../src/modules/reports/forms/application-form.js');
    const r = await applicationFormPdf(ctx.db, appId);
    expect(r.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(r.signaturePage).toBeGreaterThanOrEqual(1);
    expect(r.signatureBox).not.toBeNull();
    expect(r.signatureBox!.urx).toBeGreaterThan(r.signatureBox!.llx);
    expect(r.signatureBox!.ury).toBeGreaterThan(r.signatureBox!.lly);
  });

  it('both endpoints require authentication', async () => {
    const anon = new Client(ctx.base);
    expect((await anon.raw(`/api/reports/application-form/${appId}.pdf`)).status).toBe(401);
    expect((await anon.raw(`/api/reports/acknowledgment/${appId}.pdf`)).status).toBe(401);
  });

  it('404s for a missing application', async () => {
    expect((await (await admin()).raw('/api/reports/application-form/99999999.pdf')).status).toBe(404);
  });
});
