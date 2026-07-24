/**
 * Mandatory payment evidence on investment creation: credited date, payment
 * method, reference / cheque no. AND the receipt photo are all required —
 * POST /api/applications rejects a create missing any of them, and the receipt
 * is stored in the same transaction, so no application row can ever exist
 * without one. POST /:id/receipt remains for replacing a receipt later.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  it('rejects a create missing (or blank in) any of the four fields', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields Cust', phone: '9500009901' });
    const base = { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 };
    for (const field of ['date_money_received', 'collection_method', 'collection_reference', 'receipt'] as const) {
      const { [field]: _omit, ...body } = base;
      const missing = await a.post('/api/applications', body);
      expect(missing.status, `missing ${field} must 400`).toBe(400);
      expect(missing.json.error.code).toBe('VALIDATION');
    }
    for (const field of ['date_money_received', 'collection_method', 'collection_reference'] as const) {
      const blank = await a.post('/api/applications', { ...base, [field]: '' });
      expect(blank.status, `blank ${field} must 400`).toBe(400);
    }
    expect(await appCount(cust.json.id)).toBe(0);
  });

  it('rejects a receipt that is not an accepted file type — and creates nothing', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields Bad', phone: '9500009903' });
    const r = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
      receipt: { filename: 'x.png', mime: 'image/png', data_base64: Buffer.from('not-an-image').toString('base64') },
    });
    expect(r.status).toBe(400);
    expect(await appCount(cust.json.id)).toBe(0);
  });

  it('accepts a complete create — evidence stored and receipt attached atomically', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields OK', phone: '9500009902' });
    const r = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    expect(r.status).toBe(201);
    const detail = await a.get(`/api/applications/${r.json.id}`);
    expect(String(detail.json.application.date_money_received).slice(0, 10)).toBe('2026-07-10');
    expect(detail.json.application.collection_method).toBe('NEFT/RTGS');
    expect(detail.json.application.collection_reference).toBe('TEST-REF-001');
    // The receipt is already on the app — no separate upload happened.
    const receipt = await a.raw(`/api/applications/${r.json.id}/receipt`);
    expect(receipt.status).toBe(200);
    // The replace endpoint still works for correcting a receipt later.
    const up = await a.post(`/api/applications/${r.json.id}/receipt`, { filename: 'better.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 better').toString('base64') });
    expect(up.status).toBe(201);
  });

  it('a failed create leaves no orphaned receipt file behind', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields Orphan', phone: '9500009905' });
    // Unique filename so the check is immune to other tests writing receipts in parallel.
    const marker = 'orphan-check-4f9a.pdf';
    const r = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: 999999, amount: 100000,
      receipt: { filename: marker, mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 orphan').toString('base64') },
    });
    expect(r.status).toBe(400);
    expect(await appCount(cust.json.id)).toBe(0);
    const receiptsDir = join(process.env.FILE_STORAGE_DIR || resolve(process.cwd(), 'data', 'uploads'), 'receipts');
    const leftovers = existsSync(receiptsDir) ? readdirSync(receiptsDir).filter((f) => f.endsWith(marker)) : [];
    expect(leftovers).toEqual([]);
  });

  it('a clubbed line also requires the evidence, and its receipt lands on the target app', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Mandatory Fields Club', phone: '9500009904' });
    const first = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    expect(first.status).toBe(201);
    const noReceipt = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
      club_with_application_id: first.json.id, receipt: undefined,
    });
    expect(noReceipt.status).toBe(400);
    const clubbed = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
      club_with_application_id: first.json.id,
    });
    expect(clubbed.status).toBe(201);
    expect(clubbed.json.clubbed).toBe(true);
    const receipt = await a.raw(`/api/applications/${first.json.id}/receipt`);
    expect(receipt.status).toBe(200);
  });
});
