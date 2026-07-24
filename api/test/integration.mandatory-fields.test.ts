/**
 * Mandatory payment evidence on investment creation: credited date, payment
 * method and reference / cheque no. are required — POST /api/applications
 * rejects a create missing any of them, so the client-side checks cannot be
 * bypassed. The receipt photo keeps its existing flow (POST /:id/receipt right
 * after the create) and its own type/size validation there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

async function appCount(customerId: number) {
  return Number((await ctx.db.query<{ n: string }>('SELECT count(*)::int AS n FROM applications WHERE customer_id = $1', [customerId])).rows[0]!.n);
}

describe('POST /api/applications — mandatory payment evidence', () => {
  it('rejects a create missing (or blank in) credited date / method / reference', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields Cust', phone: '9500009901' });
    const base = { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 };
    for (const field of ['date_money_received', 'collection_method', 'collection_reference'] as const) {
      const { [field]: _omit, ...body } = base;
      const missing = await a.post('/api/applications', body);
      expect(missing.status, `missing ${field} must 400`).toBe(400);
      expect(missing.json.error.code).toBe('VALIDATION');
      const blank = await a.post('/api/applications', { ...base, [field]: '' });
      expect(blank.status, `blank ${field} must 400`).toBe(400);
    }
    expect(await appCount(cust.json.id)).toBe(0);
  });

  it('accepts a complete create, stores the evidence, and the receipt attaches as before', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields OK', phone: '9500009902' });
    const r = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    expect(r.status).toBe(201);
    const detail = await a.get(`/api/applications/${r.json.id}`);
    expect(String(detail.json.application.date_money_received).slice(0, 10)).toBe('2026-07-10');
    expect(detail.json.application.collection_method).toBe('NEFT/RTGS');
    expect(detail.json.application.collection_reference).toBe('TEST-REF-001');
    const up = await a.post(`/api/applications/${r.json.id}/receipt`, { filename: 'r.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 receipt').toString('base64') });
    expect(up.status).toBe(201);
    const receipt = await a.raw(`/api/applications/${r.json.id}/receipt`);
    expect(receipt.status).toBe(200);
  });
});
