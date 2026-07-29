/**
 * Acknowledgment authorised-signatory (CEO) signature (Masters → Company
 * profile). The receipt acknowledgment PDF drew a hardcoded on-disk image that
 * was never supplied, so it always printed a blank signature line. The signature
 * now lives in the DB and is uploaded from the UI — a single slot (the ack has
 * one signatory line), mirroring the 3-slot bond director signatures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

// 1x1 transparent PNG.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('acknowledgment signature', () => {
  it('starts empty, uploads, serves as an image, then removes', async () => {
    const a = await admin();
    expect((await a.raw('/api/company-profile/ack-signature')).status).toBe(404);

    expect((await a.post('/api/company-profile/ack-signature', { filename: 'ceo.png', data_base64: TINY_PNG_B64 })).status).toBe(201);

    const served = await a.raw('/api/company-profile/ack-signature');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect((await a.del('/api/company-profile/ack-signature')).status).toBe(200);
    expect((await a.raw('/api/company-profile/ack-signature')).status).toBe(404);
  });

  it('rejects a non-image upload', async () => {
    const a = await admin();
    const notImage = await a.post('/api/company-profile/ack-signature', { filename: 'x.txt', data_base64: Buffer.from('hello').toString('base64') });
    expect(notImage.status).toBe(400);
  });

  it('a non-manage user cannot upload or delete, but can still view', async () => {
    const a = await admin();
    await a.post('/api/company-profile/ack-signature', { filename: 'ceo.png', data_base64: TINY_PNG_B64 });
    const staff = await as('staff@demo.local'); // branch_staff — no products:manage
    expect((await staff.post('/api/company-profile/ack-signature', { filename: 'ceo.png', data_base64: TINY_PNG_B64 })).status).toBe(403);
    expect((await staff.del('/api/company-profile/ack-signature')).status).toBe(403);
    expect((await staff.raw('/api/company-profile/ack-signature')).status).toBe(200);
    await a.del('/api/company-profile/ack-signature'); // cleanup
  });

  it('replacing overwrites the previous file, not just the DB pointer', async () => {
    const a = await admin();
    await a.post('/api/company-profile/ack-signature', { filename: 'first.png', data_base64: TINY_PNG_B64 });
    const p1 = (await ctx.db.query<{ ack_signature_path: string }>('SELECT ack_signature_path FROM company_profile WHERE id = 1')).rows[0]!.ack_signature_path;
    await a.post('/api/company-profile/ack-signature', { filename: 'second.png', data_base64: TINY_PNG_B64 });
    const p2 = (await ctx.db.query<{ ack_signature_path: string }>('SELECT ack_signature_path FROM company_profile WHERE id = 1')).rows[0]!.ack_signature_path;
    expect(p2).not.toBe(p1);
    await a.del('/api/company-profile/ack-signature'); // cleanup
  });

  it('the acknowledgment PDF still generates cleanly with a signature on file', async () => {
    const a = await admin();
    await a.post('/api/company-profile/ack-signature', { filename: 'ceo.png', data_base64: TINY_PNG_B64 });
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Ack Sig Cust', phone: '9550000088' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
    await approveInvestment(await as('ncd@demo.local'), app);
    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const pdf = await acknowledgmentPdf(ctx.db, app.json.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await a.del('/api/company-profile/ack-signature'); // cleanup
  });
});
