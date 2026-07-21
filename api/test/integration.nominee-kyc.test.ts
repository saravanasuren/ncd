/**
 * Nominee KYC (owner spec 2026-07-21): the nominee PAN field is replaced by a
 * KYC id (Aadhaar/PAN type + number) stored on the nominee; the photo lands in
 * customer documents as 'nominee_kyc'.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('nominee KYC', () => {
  it('stores the nominee KYC id type + number, and a nominee_kyc document', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Nom KYC Cust', phone: '9700088812' });
    const id = cust.json.id;

    const put = await a.put(`/api/customers/${id}/nominees`, { nominees: [{
      full_name: 'Nominee One', relationship: 'Spouse', share_pct: 100,
      kyc_id_type: 'Aadhaar', kyc_id_number: '123412341234',
    }] });
    expect(put.status).toBe(200);

    // KYC photo → customer documents tagged nominee_kyc.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const doc = await a.post(`/api/customers/${id}/documents`, { doc_type: 'nominee_kyc', filename: 'nom.png', mime: 'image/png', data_base64: png });
    expect(doc.status).toBe(201);

    const detail = await a.get(`/api/customers/${id}`);
    const nom = detail.json.nominees[0];
    expect(nom.kyc_id_type).toBe('Aadhaar');
    expect(nom.kyc_id_number).toBe('123412341234');
    expect((detail.json.documents as any[]).some((d) => d.doc_type === 'nominee_kyc')).toBe(true);
  });
});
