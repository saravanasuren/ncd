/**
 * Bond certificate director signatures (Masters → Company profile). The
 * certificate always shipped with blank signature lines — the PDF code drew
 * an image if one existed on disk, but the file was never supplied anywhere,
 * including in the original wealth app. Signatures now live in the DB and are
 * uploaded from the UI instead of needing a deploy.
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

describe('bond certificate director signatures', () => {
  it('starts empty, uploads, serves, then removes — for each of the 3 slots', async () => {
    const a = await admin();
    for (const index of [0, 1, 2]) {
      const before = await a.raw(`/api/company-profile/bond-signature/${index}`);
      expect(before.status).toBe(404);

      const up = await a.post(`/api/company-profile/bond-signature/${index}`, { filename: 'sig.png', data_base64: TINY_PNG_B64 });
      expect(up.status).toBe(201);

      const served = await a.raw(`/api/company-profile/bond-signature/${index}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/png');
      expect(served.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const del = await a.del(`/api/company-profile/bond-signature/${index}`);
      expect(del.status).toBe(200);
      const after = await a.raw(`/api/company-profile/bond-signature/${index}`);
      expect(after.status).toBe(404);
    }
  });

  it('rejects a non-image upload and an out-of-range slot', async () => {
    const a = await admin();
    const notImage = await a.post('/api/company-profile/bond-signature/0', { filename: 'x.txt', data_base64: Buffer.from('hello').toString('base64') });
    expect(notImage.status).toBe(400);
    const badSlot = await a.post('/api/company-profile/bond-signature/5', { filename: 'sig.png', data_base64: TINY_PNG_B64 });
    expect(badSlot.status).toBe(400);
  });

  it('a non-manage user cannot upload or delete, but can still view', async () => {
    const a = await admin();
    await a.post('/api/company-profile/bond-signature/1', { filename: 'sig.png', data_base64: TINY_PNG_B64 });
    const staff = await as('staff@demo.local'); // branch_staff — no products:manage
    const upload = await staff.post('/api/company-profile/bond-signature/1', { filename: 'sig.png', data_base64: TINY_PNG_B64 });
    expect(upload.status).toBe(403);
    const del = await staff.del('/api/company-profile/bond-signature/1');
    expect(del.status).toBe(403);
    const view = await staff.raw('/api/company-profile/bond-signature/1');
    expect(view.status).toBe(200);
    await a.del('/api/company-profile/bond-signature/1'); // cleanup
  });

  it('replacing a signature overwrites the previous file, not just the DB pointer', async () => {
    const a = await admin();
    await a.post('/api/company-profile/bond-signature/2', { filename: 'first.png', data_base64: TINY_PNG_B64 });
    const path1 = (await ctx.db.query<{ bond_signature_3_path: string }>('SELECT bond_signature_3_path FROM company_profile WHERE id = 1')).rows[0]!.bond_signature_3_path;
    await a.post('/api/company-profile/bond-signature/2', { filename: 'second.png', data_base64: TINY_PNG_B64 });
    const path2 = (await ctx.db.query<{ bond_signature_3_path: string }>('SELECT bond_signature_3_path FROM company_profile WHERE id = 1')).rows[0]!.bond_signature_3_path;
    expect(path2).not.toBe(path1);
    await a.del('/api/company-profile/bond-signature/2'); // cleanup
  });

  it('the certificate PDF still generates cleanly with a signature on file', async () => {
    const a = await admin();
    await a.post('/api/company-profile/bond-signature/0', { filename: 'sig.png', data_base64: TINY_PNG_B64 });
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = await a.post('/api/customers', { full_name: 'Bond Sig Cust', phone: '9550000099' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
    await approveInvestment(await as('ncd@demo.local'), app);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const pdf = await bondCertificatePdf(ctx.db, app.json.id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await a.del('/api/company-profile/bond-signature/0'); // cleanup
  });
});
